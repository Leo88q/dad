import { createHmac, timingSafeEqual } from "node:crypto";
import { ensureRecoveryState, recoveryState } from "./recovery.js";

export const MAX_CONSENT_VERSION = "pilot-data-max-v2-security";
// MAX's official reference: github.com/max-messenger/max-agents-skill,
// references/webhooks-and-security.md (two-step WebAppData HMAC).
export function validateMaxInitData(raw, botToken, now = Date.now()) {
  if (
    !botToken ||
    typeof raw !== "string" ||
    !raw ||
    raw.length > 16384 ||
    /%(?![a-f0-9]{2})/i.test(raw)
  )
    throw new Error("Неверные данные запуска MAX.");
  const params = new URLSearchParams(raw),
    seen = new Set();
  for (const [key] of params) {
    if (seen.has(key) || !/^[a-zA-Z0-9_]+$/.test(key))
      throw new Error("Повторяющийся или неверный параметр MAX.");
    seen.add(key);
  }
  const received = params.get("hash");
  if (!received || !/^[a-f0-9]{64}$/i.test(received))
    throw new Error("Нет подписи MAX.");
  params.delete("hash");
  const secret = createHmac("sha256", "WebAppData").update(botToken).digest();
  const data = [...params]
    .map(([k, v]) => `${k}=${v}`)
    .sort()
    .join("\n");
  const calculated = createHmac("sha256", secret).update(data).digest();
  if (!timingSafeEqual(calculated, Buffer.from(received, "hex")))
    throw new Error("Подпись MAX не прошла проверку.");
  const date = params.get("auth_date");
  if (!date || !/^\d{1,12}$/.test(date))
    throw new Error("Неверное время запуска MAX.");
  const issued = Number(date) * 1000;
  if (issued > now + 60000 || now - issued > 3600000)
    throw new Error(
      "Запуск MAX устарел. Закройте и откройте мини-приложение снова.",
    );
  const query = params.get("query_id");
  if (!query || query.length > 256)
    throw new Error("Не найден идентификатор запуска MAX.");
  let user;
  try {
    user = JSON.parse(params.get("user"));
  } catch {
    throw new Error("Неверный пользователь MAX.");
  }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0)
    throw new Error("Неверный идентификатор MAX.");
  return {
    userId: String(user.id),
    firstName:
      typeof user.first_name === "string"
        ? user.first_name.trim().slice(0, 40)
        : "",
    startParam: params.get("start_param") || "",
    launchId: `${user.id}\n${query}\n${issued}`,
    issued,
    expires: issued + 3600000,
  };
}

export function mountMax(
  app,
  {
    db,
    access,
    id,
    hash,
    recordConsent,
    validName,
    botToken,
    botName,
    maxOnly,
    release = null,
    maxConsentVersion = MAX_CONSENT_VERSION,
  },
) {
  ensureRecoveryState(db);
  db.exec(`CREATE TABLE IF NOT EXISTS max_accounts (user_id TEXT PRIMARY KEY,member TEXT NOT NULL UNIQUE REFERENCES members(id) ON DELETE CASCADE);
  CREATE TABLE IF NOT EXISTS max_launches (fingerprint TEXT PRIMARY KEY,expires INTEGER NOT NULL);`);
  const fail = (res, message, status = 400) =>
    res.status(status).json({ error: message });
  const attempts = new Map();
  app.get("/api/runtime-config", (req, res) =>
    res.json({ maxEnabled: !!botToken, maxBotName: botName, maxOnly, release }),
  );
  app.post("/api/max/auth", (req, res) => {
    if (!botToken)
      return fail(res, "Вход через MAX ещё не настроен на сервере.", 503);
    const now = Date.now();
    let rate = attempts.get(req.ip);
    if (!rate || now - rate.start > 900000) {
      rate = { start: now, count: 0 };
      attempts.set(req.ip, rate);
    }
    if (++rate.count > 120) {
      res.set("Retry-After", "900");
      return fail(res, "Слишком много попыток входа. Попробуйте позже.", 429);
    }
    if (attempts.size > 10000)
      for (const [key, v] of attempts)
        if (now - v.start > 900000) attempts.delete(key);
    let verified;
    try {
      verified = validateMaxInitData(req.body.initData, botToken, now);
    } catch (err) {
      return fail(res, err.message, 403);
    }
    if (verified.issued < recoveryState(db, now).authNotBefore)
      return fail(
        res,
        "Этот запуск MAX предшествует восстановлению сервиса. Закройте и снова откройте мини-приложение.",
        403,
      );
    const link = db
      .prepare("SELECT member FROM max_accounts WHERE user_id=?")
      .get(verified.userId);
    const bearer = (req.headers.authorization || "").replace(/^Bearer /, "");
    const session = access.authenticate(bearer);
    if (session && link && session.member !== link.member)
      return fail(
        res,
        "Этот браузер вошёл в другой профиль. Выйдите из него, прежде чем войти через текущий аккаунт MAX.",
        409,
      );
    const existing = link
      ? db.prepare("SELECT * FROM members WHERE id=?").get(link.member)
      : session
        ? db.prepare("SELECT * FROM members WHERE id=?").get(session.member)
        : null;
    const boundToSession = session
      ? db
          .prepare("SELECT user_id FROM max_accounts WHERE member=?")
          .get(session.member)
      : null;
    if (boundToSession && boundToSession.user_id !== verified.userId)
      return fail(
        res,
        "Профиль связан с другим аккаунтом MAX. Выйдите из него перед входом.",
        409,
      );
    const mustLink = !!session && !link;
    const consent = db
      .prepare("SELECT version FROM consents WHERE member=?")
      .get(existing?.id || "");
    const invite =
      /^invite_([a-f0-9]{36})$/.exec(verified.startParam)?.[1] || null;
    if (mustLink && req.body.linkExisting !== true)
      return res.json({
        needsLinkConsent: true,
        name: verified.firstName,
        profileName: existing.name,
      });
    if (
      (!existing || consent?.version !== maxConsentVersion || mustLink) &&
      req.body.consent !== true
    )
      return res.json({
        needsConsent: true,
        name: existing?.name || verified.firstName,
        joining: !!invite,
      });
    const fingerprint = hash(verified.launchId);
    db.prepare("DELETE FROM max_launches WHERE expires<=?").run(now);
    // Already authenticated to this exact linked identity: no new bearer or session.
    if (link && session && session.member === link.member) {
      if (req.body.consent === true)
        recordConsent(link.member, maxConsentVersion);
      db.prepare("INSERT OR IGNORE INTO max_launches VALUES (?,?)").run(
        fingerprint,
        verified.expires,
      );
      return res.json({ authenticated: true, inviteIgnored: !!invite });
    }
    if (
      db
        .prepare("SELECT fingerprint FROM max_launches WHERE fingerprint=?")
        .get(fingerprint)
    )
      return fail(
        res,
        "Этот запуск MAX уже использован. Закройте и снова откройте мини-приложение.",
        409,
      );
    if (
      link &&
      db
        .prepare("SELECT count(*) n FROM access_sessions WHERE member=?")
        .get(link.member).n >= 5
    )
      return fail(
        res,
        "Достигнут лимит пяти подключений. Отключите старое устройство или используйте личный код восстановления.",
        409,
      );
    let family = existing?.family,
      member = existing?.id,
      recovery = null;
    if (!existing && invite) {
      const f = db
        .prepare("SELECT id FROM families WHERE invite=?")
        .get(invite);
      if (!f) return fail(res, "Приглашение отозвано или не найдено.", 404);
      if (
        db.prepare("SELECT count(*) n FROM members WHERE family=?").get(f.id)
          .n >= 2
      )
        return fail(res, "В этой паре уже два участника.", 409);
      family = f.id;
    }
    const token = session ? null : id();
    db.exec("BEGIN");
    try {
      if (!existing) {
        if (!family) {
          family = id();
          db.prepare("INSERT INTO families VALUES (?,?,?)").run(
            family,
            id(),
            new Date().toISOString(),
          );
        }
        member = id();
        recovery = id().slice(0, 32).match(/.{4}/g).join("-");
        const name = validName(req.body.name)
          ? req.body.name.trim()
          : verified.firstName || "Участник";
        db.prepare(
          "INSERT INTO members (id,family,token,name,recovery) VALUES (?,?,?,?,?)",
        ).run(
          member,
          family,
          hash(id()),
          name,
          hash(recovery.replaceAll("-", "")),
        );
      }
      if (!link)
        db.prepare("INSERT INTO max_accounts VALUES (?,?)").run(
          verified.userId,
          member,
        );
      if (req.body.consent === true) recordConsent(member, maxConsentVersion);
      if (token) access.create(member, token, "MAX");
      db.prepare("INSERT INTO max_launches VALUES (?,?)").run(
        fingerprint,
        verified.expires,
      );
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
    res.json({
      authenticated: true,
      ...(token ? { token } : {}),
      ...(recovery ? { recoveryCode: recovery } : {}),
      linked: mustLink,
      inviteIgnored: !!existing && !!invite,
    });
  });
}
