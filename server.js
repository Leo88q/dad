import express from "express";
import { DatabaseSync } from "node:sqlite";
import { randomBytes, createHash } from "node:crypto";
import { mkdirSync, accessSync, constants } from "node:fs";
import { persistentRateLimiter } from "./lib/rate-limit.js";
import { readConfig } from "./lib/config.js";
import { ensureRecoveryState, recoveryState } from "./lib/recovery.js";
import { lessons } from "./public/content.js";
import { buildReviewPlan } from "./lib/reviews.js";
import { accessStore } from "./lib/access.js";
import { mountMax, MAX_CONSENT_VERSION } from "./lib/max.js";

const app = express();
const config = readConfig();
const { maxBotToken, maxBotName, maxOnly } = config;
const maxConsentVersion = config.production
  ? "max-data-" + config.release.policyVersion
  : MAX_CONSENT_VERSION;
if (process.env.TRUST_PROXY)
  app.set(
    "trust proxy",
    process.env.TRUST_PROXY.split(",")
      .map((v) => v.trim())
      .filter(Boolean),
  );
const dataDir = config.dataDir;
mkdirSync(dataDir, { recursive: true });
const db = new DatabaseSync(`${dataDir}/ryadom.sqlite`);
db.exec(`PRAGMA journal_mode=WAL; PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS families (id TEXT PRIMARY KEY, invite TEXT UNIQUE, created TEXT);
CREATE TABLE IF NOT EXISTS members (id TEXT PRIMARY KEY, family TEXT REFERENCES families(id) ON DELETE CASCADE, token TEXT UNIQUE, name TEXT);
CREATE TABLE IF NOT EXISTS sessions (id TEXT PRIMARY KEY, family TEXT REFERENCES families(id) ON DELETE CASCADE, lesson TEXT, mode TEXT, answers TEXT DEFAULT '{}', revealed INTEGER DEFAULT 0, finished TEXT);
CREATE TABLE IF NOT EXISTS agreements (id TEXT PRIMARY KEY, family TEXT REFERENCES families(id) ON DELETE CASCADE, session TEXT UNIQUE REFERENCES sessions(id) ON DELETE CASCADE, text TEXT, created TEXT);`);
if (
  !db
    .prepare("PRAGMA table_info(members)")
    .all()
    .some((c) => c.name === "recovery")
)
  db.exec("ALTER TABLE members ADD COLUMN recovery TEXT");
db.exec(
  "CREATE UNIQUE INDEX IF NOT EXISTS members_recovery ON members(recovery)",
);
ensureRecoveryState(db);
const recoveryCode = () =>
  randomBytes(16).toString("hex").match(/.{4}/g).join("-");
const normalizeCode = (code) =>
  typeof code === "string" ? code.toLowerCase().replace(/[\s-]/g, "") : "";
db.exec(`CREATE TABLE IF NOT EXISTS proposals (
  session TEXT PRIMARY KEY REFERENCES sessions(id) ON DELETE CASCADE,
  text TEXT NOT NULL, revision INTEGER NOT NULL, approvals TEXT NOT NULL
)`);
db.exec(`CREATE TABLE IF NOT EXISTS saved_lessons (
  member TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
  lesson TEXT NOT NULL,created TEXT NOT NULL,PRIMARY KEY(member,lesson)
);`);
function savedLessons(member) {
  return db
    .prepare(
      "SELECT lesson FROM saved_lessons WHERE member=? ORDER BY created,lesson",
    )
    .all(member)
    .map((row) => row.lesson);
}
const CONSENT_VERSION = config.production
  ? "web-data-" + config.release.policyVersion
  : "pilot-data-v3-security";
db.exec(`CREATE TABLE IF NOT EXISTS preferences (member TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE, reviews INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS consents (member TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE, version TEXT NOT NULL, acceptedAt TEXT NOT NULL);`);
function consentFor(member) {
  return (
    db
      .prepare("SELECT version,acceptedAt FROM consents WHERE member=?")
      .get(member) ?? null
  );
}
function recordConsent(member, version = CONSENT_VERSION) {
  db.prepare(
    "INSERT INTO consents VALUES (?,?,?) ON CONFLICT(member) DO UPDATE SET version=excluded.version,acceptedAt=excluded.acceptedAt",
  ).run(member, version, new Date().toISOString());
}
const id = () => randomBytes(18).toString("hex");
function finishSession(session, text) {
  const now = new Date().toISOString();
  db.prepare("INSERT INTO agreements VALUES (?,?,?,?,?)").run(
    id(),
    session.family,
    session.id,
    text,
    now,
  );
  db.prepare("UPDATE sessions SET finished=? WHERE id=?").run(now, session.id);
}
function getProposal(sessionId) {
  const proposal = db
    .prepare("SELECT text,revision,approvals FROM proposals WHERE session=?")
    .get(sessionId);
  return proposal
    ? { ...proposal, approvals: JSON.parse(proposal.approvals) }
    : null;
}
const hash = (v) => createHash("sha256").update(v).digest("hex");
const access = accessStore(db);
const rateLimiter = persistentRateLimiter(`${dataDir}/security.sqlite`);
function applyQuota(req, res, scope, limit, windowMs, message) {
  try {
    const result = rateLimiter.take(scope, req.ip, { limit, windowMs });
    if (result.allowed) return true;
    res.set("Retry-After", String(result.retryAfter));
    res.status(result.capacity ? 503 : 429).json({
      error: result.capacity
        ? "Защита доступа временно перегружена. Попробуйте позже."
        : message,
    });
  } catch {
    console.error("Access rate-limit storage is unavailable");
    res.set("Retry-After", "60").status(503).json({
      error: "Проверка доступа временно недоступна. Попробуйте позже.",
    });
  }
  return false;
}
app.disable("x-powered-by");
app.enable("case sensitive routing");
app.use((req, res, next) => {
  if (config.production)
    res.set("Strict-Transport-Security", "max-age=31536000");
  res.set({
    "X-Content-Type-Options": "nosniff",
    "Referrer-Policy": "no-referrer",
    "Content-Security-Policy":
      "default-src 'self'; script-src 'self' https://st.max.ru; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'self' https://*.e2b.app https://max.ru https://*.max.ru",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=()",
  });
  next();
});
app.use(express.json({ limit: "32kb" }));
app.use((req, res, next) => {
  req.body ??= {};
  next();
});
const maxDownloads = new Map();
app.get("/max/download/:ticket", (req, res) => {
  res.set({ "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" });
  const key = hash(req.params.ticket),
    ticket = maxDownloads.get(key);
  if (!ticket || ticket.expires <= Date.now()) return res.status(404).end();
  // Recheck session ownership: logout/revocation/deletion cancels a pending download.
  const session = db
    .prepare("SELECT id FROM access_sessions WHERE id=? AND member=?")
    .get(ticket.session, ticket.member);
  if (!session) {
    maxDownloads.delete(key);
    return res.status(404).end();
  }
  res.type("application/json").attachment("ryadom-data.json");
  if (req.method === "HEAD") return res.end();
  maxDownloads.delete(key);
  res.send(ticket.content);
});
app.get("/readyz", (req, res) => {
  res.set("Cache-Control", "no-store");
  try {
    if (recoveryState(db).blocked)
      return res.status(503).json({ ready: false });
    db.prepare("SELECT 1").get();
    if (!rateLimiter.healthy()) throw new Error("Limiter unavailable");
    accessSync(dataDir, constants.R_OK | constants.W_OK);
    res.json({ ready: true });
  } catch {
    res.status(503).json({ ready: false });
  }
});
app.get("/healthz", (req, res) => {
  db.prepare("SELECT 1").get();
  res.json({ ok: true });
});
app.use("/api", (req, res, next) => {
  res.set("Cache-Control", "no-store");
  if (
    applyQuota(
      req,
      res,
      "api",
      180,
      60000,
      "Слишком много запросов. Подождите минуту.",
    )
  )
    next();
});
const fail = (res, text, status = 400) =>
  res.status(status).json({ error: text });
const validName = (n) =>
  typeof n === "string" && n.trim().length >= 1 && n.trim().length <= 40;
app.use("/api", (req, res, next) => {
  if (req.path === "/runtime-config") return next();
  if (recoveryState(db).blocked) {
    res.set("Retry-After", "61");
    return fail(
      res,
      "Сервис восстанавливается из резервной копии. После проверки оператором закройте и снова откройте мини-приложение MAX.",
      503,
    );
  }
  next();
});
app.post("/api/register", (req, res) => {
  if (maxOnly)
    return fail(res, "Создайте профиль через мини-приложение MAX.", 403);
  if (!validName(req.body.name) || req.body.consent !== true)
    return fail(res, "Укажите имя и подтвердите согласие.");
  const family = id(),
    token = id(),
    member = id(),
    invite = id(),
    code = recoveryCode();
  db.exec("BEGIN");
  try {
    db.prepare("INSERT INTO families VALUES (?,?,?)").run(
      family,
      invite,
      new Date().toISOString(),
    );
    db.prepare(
      "INSERT INTO members (id,family,token,name,recovery) VALUES (?,?,?,?,?)",
    ).run(
      member,
      family,
      hash(id()),
      req.body.name.trim(),
      hash(normalizeCode(code)),
    );
    access.create(member, token, req.body.deviceLabel);
    recordConsent(member);
    db.exec("COMMIT");
  } catch (e) {
    db.exec("ROLLBACK");
    throw e;
  }
  res.json({ token, recoveryCode: code });
});
app.post("/api/join", (req, res) => {
  if (maxOnly) return fail(res, "Откройте приглашение внутри MAX.", 403);
  if (!validName(req.body.name) || req.body.consent !== true)
    return fail(res, "Укажите имя и подтвердите согласие.");
  const f = db
    .prepare("SELECT * FROM families WHERE invite=?")
    .get(String(req.body.invite));
  if (!f) return fail(res, "Приглашение не найдено или отозвано.", 404);
  if (
    db.prepare("SELECT count(*) n FROM members WHERE family=?").get(f.id).n >= 2
  )
    return fail(res, "В этой паре уже два участника.");
  const token = id(),
    code = recoveryCode(),
    member = id();
  db.exec("BEGIN");
  try {
    db.prepare(
      "INSERT INTO members (id,family,token,name,recovery) VALUES (?,?,?,?,?)",
    ).run(
      member,
      f.id,
      hash(id()),
      req.body.name.trim(),
      hash(normalizeCode(code)),
    );
    access.create(member, token, req.body.deviceLabel);
    recordConsent(member);
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
  res.json({ token, recoveryCode: code });
});
// Recovery is deliberately separate from invitation and does not reveal whether a name exists.
app.post("/api/recover", (req, res) => {
  if (
    !applyQuota(
      req,
      res,
      "recovery",
      5,
      900000,
      "Слишком много попыток. Попробуйте через 15 минут.",
    )
  )
    return;
  const code = normalizeCode(req.body.code);
  const member = /^[a-f0-9]{32}$/.test(code)
    ? db.prepare("SELECT id FROM members WHERE recovery=?").get(hash(code))
    : null;
  if (!member)
    return fail(
      res,
      "Код не найден или уже использован. Проверьте запись.",
      400,
    );
  const token = id(),
    newCode = recoveryCode();
  access.reset(
    member.id,
    token,
    hash(normalizeCode(newCode)),
    req.body.deviceLabel,
  );
  res.json({ token, recoveryCode: newCode });
});
// Device connection is separate from account recovery and family invitations.
app.post("/api/connect-device", (req, res) => {
  if (
    !applyQuota(
      req,
      res,
      "device-connect",
      10,
      900000,
      "Слишком много попыток подключения. Попробуйте через 15 минут.",
    )
  )
    return;
  const result = access.connect(req.body.code, req.body.deviceLabel);
  if (result.error) return fail(res, result.error, result.status);
  res.json(result);
});
mountMax(app, {
  db,
  access,
  id,
  hash,
  recordConsent,
  validName,
  botToken: maxBotToken,
  botName: maxBotName,
  maxOnly,
  release: config.release,
  maxConsentVersion,
});
function expectedConsent(member) {
  return db
    .prepare("SELECT user_id FROM max_accounts WHERE member=?")
    .get(member)
    ? maxConsentVersion
    : CONSENT_VERSION;
}
app.use("/api", (req, res, next) => {
  const token = (req.headers.authorization || "").replace(/^Bearer /, "");
  const session = access.authenticate(token);
  if (!session) return fail(res, "Нужно войти в своё пространство.", 401);
  req.member = db
    .prepare("SELECT * FROM members WHERE id=?")
    .get(session.member);
  req.accessSession = session;
  next();
});
app.get("/api/state", (req, res) => {
  const m = req.member,
    f = db.prepare("SELECT * FROM families WHERE id=?").get(m.family);
  const members = db
    .prepare("SELECT id,name FROM members WHERE family=? ORDER BY rowid")
    .all(m.family);
  const sessions = db
    .prepare("SELECT * FROM sessions WHERE family=? ORDER BY rowid DESC")
    .all(m.family)
    .map((s) => {
      const answers = JSON.parse(s.answers);
      return {
        ...s,
        answers: s.revealed
          ? answers
          : Object.fromEntries(
              Object.entries(answers).map(([k, v]) => [
                k,
                k === m.id || s.mode === "together" ? v : null,
              ]),
            ),
        answered: Object.keys(answers),
        proposal: getProposal(s.id),
      };
    });
  res.json({
    me: m.id,
    savedLessons: savedLessons(m.id),
    recoveryEnabled: !!m.recovery,
    maxLinked: !!db
      .prepare("SELECT user_id FROM max_accounts WHERE member=?")
      .get(m.id),
    devices: access.list(m.id, req.accessSession.id),
    deviceCodeExpiresAt:
      db
        .prepare(
          "SELECT expires FROM device_codes WHERE member=? AND expires>?",
        )
        .get(m.id, Date.now())?.expires ?? null,
    consent: consentFor(m.id),
    consentVersion: expectedConsent(m.id),
    preferences: {
      reviews: !!db
        .prepare("SELECT reviews FROM preferences WHERE member=?")
        .get(m.id)?.reviews,
    },
    reviewPlan: db
      .prepare("SELECT reviews FROM preferences WHERE member=?")
      .get(m.id)?.reviews
      ? buildReviewPlan(sessions, lessons)
      : [],
    invite: f.invite,
    members,
    sessions,
    agreements: db
      .prepare("SELECT * FROM agreements WHERE family=? ORDER BY rowid DESC")
      .all(m.family),
  });
});
app.post("/api/lessons/:lesson/saved", (req, res) => {
  if (!lessons.some((lesson) => lesson.id === req.params.lesson))
    return fail(res, "Занятие не найдено.", 404);
  if (typeof req.body.saved !== "boolean")
    return fail(res, "Укажите, сохранить занятие или убрать его из списка.");
  if (req.body.saved)
    db.prepare("INSERT OR IGNORE INTO saved_lessons VALUES (?,?,?)").run(
      req.member.id,
      req.params.lesson,
      new Date().toISOString(),
    );
  else
    db.prepare("DELETE FROM saved_lessons WHERE member=? AND lesson=?").run(
      req.member.id,
      req.params.lesson,
    );
  res.json({ savedLessons: savedLessons(req.member.id) });
});
app.post("/api/device-code", (req, res) =>
  res.json(access.issueCode(req.member.id)),
);
app.post("/api/device-code/cancel", (req, res) => {
  db.prepare("DELETE FROM device_codes WHERE member=?").run(req.member.id);
  res.json({ ok: true });
});
app.post("/api/devices/revoke-others", (req, res) => {
  access.revokeOthers(req.member.id, req.accessSession.id);
  res.json({ ok: true });
});
app.post("/api/devices/:id/revoke", (req, res) => {
  const result = access.revoke(
    req.member.id,
    req.params.id,
    req.accessSession.id,
  );
  if (result.error) return fail(res, result.error, result.status);
  res.json(result);
});
app.post("/api/device-name", (req, res) => {
  if (!validName(req.body.label))
    return fail(
      res,
      "Название устройства должно содержать от 1 до 40 символов.",
    );
  db.prepare("UPDATE access_sessions SET label=? WHERE id=? AND member=?").run(
    req.body.label.trim(),
    req.accessSession.id,
    req.member.id,
  );
  res.json({ ok: true });
});
app.post("/api/preferences", (req, res) => {
  if (typeof req.body.reviews !== "boolean")
    return fail(res, "Выберите, показывать ли повторения.");
  db.prepare(
    "INSERT INTO preferences VALUES (?,?) ON CONFLICT(member) DO UPDATE SET reviews=excluded.reviews",
  ).run(req.member.id, req.body.reviews ? 1 : 0);
  res.json({ ok: true });
});
app.post("/api/consent", (req, res) => {
  if (req.body.consent !== true)
    return fail(
      res,
      "Подтвердите согласие или удалите профиль для прекращения обработки.",
    );
  recordConsent(req.member.id, expectedConsent(req.member.id));
  res.json({ ok: true });
});
app.post("/api/recovery-code", (req, res) => {
  const code = recoveryCode();
  db.prepare("UPDATE members SET recovery=? WHERE id=?").run(
    hash(normalizeCode(code)),
    req.member.id,
  );
  res.json({ recoveryCode: code });
});
function exportData(m, sessionId) {
  const sessions = db
    .prepare(
      "SELECT lesson,mode,answers,finished FROM sessions WHERE family=? ORDER BY rowid",
    )
    .all(m.family)
    .map((s) => ({
      lesson: s.lesson,
      mode: s.mode,
      finished: s.finished,
      ownAnswer:
        s.mode === "remote" ? (JSON.parse(s.answers)[m.id] ?? null) : null,
    }));
  return {
    version: 1,
    exportedAt: new Date().toISOString(),
    profile: { name: m.name },
    savedLessons: savedLessons(m.id),
    maxAccount:
      db
        .prepare("SELECT user_id AS userId FROM max_accounts WHERE member=?")
        .get(m.id) ?? null,
    devices: access
      .list(m.id, sessionId)
      .map(({ id, ...metadata }) => metadata),
    consent: consentFor(m.id),
    consentVersion: expectedConsent(m.id),
    preferences: {
      reviews: !!db
        .prepare("SELECT reviews FROM preferences WHERE member=?")
        .get(m.id)?.reviews,
    },
    sessions,
    sharedProposals: db
      .prepare(
        "SELECT s.lesson,s.finished,p.text,p.revision,p.approvals FROM proposals p JOIN sessions s ON s.id=p.session WHERE s.family=? ORDER BY s.rowid",
      )
      .all(m.family)
      .map((p) => ({
        lesson: p.lesson,
        text: p.text,
        revision: p.revision,
        finished: p.finished,
        myApproval: JSON.parse(p.approvals).includes(m.id),
      })),
    sharedAgreements: db
      .prepare(
        "SELECT text,created FROM agreements WHERE family=? ORDER BY rowid",
      )
      .all(m.family),
  };
}
app.get("/api/export", (req, res) =>
  res.json(exportData(req.member, req.accessSession.id)),
);
app.post("/api/max/export-ticket", (req, res) => {
  let origin;
  try {
    origin = new URL(process.env.PUBLIC_URL || "");
  } catch {
    return fail(res, "Для скачивания в MAX задайте PUBLIC_URL сервера.", 503);
  }
  if (
    origin.protocol !== "https:" ||
    origin.username ||
    origin.password ||
    origin.search ||
    origin.hash
  )
    return fail(res, "PUBLIC_URL должен быть HTTPS-адресом приложения.", 503);
  for (const [k, v] of maxDownloads)
    if (v.expires <= Date.now() || v.member === req.member.id)
      maxDownloads.delete(k);
  if (maxDownloads.size >= 1000)
    return fail(res, "Скачивание временно недоступно. Попробуйте позже.", 503);
  const ticket = id();
  maxDownloads.set(hash(ticket), {
    member: req.member.id,
    session: req.accessSession.id,
    expires: Date.now() + 60000,
    content: JSON.stringify(
      exportData(req.member, req.accessSession.id),
      null,
      2,
    ),
  });
  res.json({
    url: new URL("/max/download/" + ticket, origin).href,
    fileName: "ryadom-data.json",
  });
});
app.post("/api/logout", (req, res) => {
  access.logout(req.member.id, req.accessSession.id);
  res.json({ ok: true });
});
app.post("/api/name", (req, res) => {
  if (!validName(req.body.name))
    return fail(res, "Имя должно содержать от 1 до 40 символов.");
  db.prepare("UPDATE members SET name=? WHERE id=?").run(
    req.body.name.trim(),
    req.member.id,
  );
  res.json({ ok: true });
});
app.post("/api/start", (req, res) => {
  const { lesson, mode } = req.body;
  if (
    !lessons.some((l) => l.id === lesson) ||
    !["together", "remote"].includes(mode)
  )
    return fail(res, "Выберите занятие и формат.");
  const existing = db
    .prepare("SELECT id FROM sessions WHERE family=? AND finished IS NULL")
    .get(req.member.family);
  if (existing) return res.json({ id: existing.id });
  const sid = id();
  db.prepare(
    "INSERT INTO sessions (id,family,lesson,mode) VALUES (?,?,?,?)",
  ).run(sid, req.member.family, lesson, mode);
  res.json({ id: sid });
});
app.post("/api/session/:id/:action", (req, res) => {
  const s = db
    .prepare("SELECT * FROM sessions WHERE id=? AND family=?")
    .get(req.params.id, req.member.family);
  if (!s) return fail(res, "Занятие не найдено.", 404);
  if (s.finished) return fail(res, "Это занятие уже завершено.");
  const answers = JSON.parse(s.answers),
    lesson = lessons.find((l) => l.id === s.lesson);
  switch (req.params.action) {
    case "answer": {
      if (s.revealed) return fail(res, "Обсуждение уже началось.");
      const choice = req.body.choice;
      if (
        !Number.isInteger(choice) ||
        choice < 0 ||
        choice >= lesson.options.length
      )
        return fail(res, "Выберите один ответ.");
      const key = s.mode === "together" ? req.body.person : req.member.id;
      if (s.mode === "together" && !["first", "second"].includes(key))
        return fail(res, "Участник не выбран.");
      answers[key] = choice;
      const count =
        s.mode === "together"
          ? 2
          : db
              .prepare("SELECT count(*) n FROM members WHERE family=?")
              .get(s.family).n;
      const reveal = Object.keys(answers).length >= 2 && count >= 2;
      db.prepare("UPDATE sessions SET answers=?,revealed=? WHERE id=?").run(
        JSON.stringify(answers),
        reveal ? 1 : 0,
        s.id,
      );
      break;
    }
    case "complete": {
      if (!s.revealed)
        return fail(res, "Сначала дайте слово обоим участникам.");
      db.exec("BEGIN");
      try {
        db.prepare("DELETE FROM proposals WHERE session=?").run(s.id);
        db.prepare("UPDATE sessions SET finished=? WHERE id=?").run(
          new Date().toISOString(),
          s.id,
        );
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      break;
    }
    case "propose": {
      if (lesson.kind === "conversation")
        return fail(
          res,
          "У семейных разговоров нет обязательной договорённости. Завершите разговор.",
        );
      if (s.mode !== "remote" || !s.revealed)
        return fail(
          res,
          "Предложение доступно после ответов обоих участников.",
        );
      const text = req.body.text;
      if (
        typeof text !== "string" ||
        text.trim().length < 3 ||
        text.trim().length > 500
      )
        return fail(
          res,
          "Договорённость должна содержать от 3 до 500 символов.",
        );
      const previous = getProposal(s.id);
      if (
        !Number.isInteger(req.body.revision) ||
        req.body.revision !== (previous?.revision ?? 0)
      )
        return fail(
          res,
          "Близкий уже изменил текст. Прочитайте новую версию.",
          409,
        );
      db.prepare(
        `INSERT INTO proposals VALUES (?,?,?,?) ON CONFLICT(session) DO UPDATE SET text=excluded.text, revision=excluded.revision, approvals=excluded.approvals`,
      ).run(
        s.id,
        text.trim(),
        (previous?.revision ?? 0) + 1,
        JSON.stringify([req.member.id]),
      );
      break;
    }
    case "approve": {
      if (s.mode !== "remote" || !s.revealed)
        return fail(res, "Сначала пройдите историю вместе.");
      const proposal = getProposal(s.id);
      if (!proposal || req.body.revision !== proposal.revision)
        return fail(
          res,
          "Текст изменился. Прочитайте новую версию перед подтверждением.",
          409,
        );
      const approvals = [...new Set([...proposal.approvals, req.member.id])];
      const members = db
        .prepare("SELECT id FROM members WHERE family=?")
        .all(s.family);
      db.exec("BEGIN");
      try {
        db.prepare("UPDATE proposals SET approvals=? WHERE session=?").run(
          JSON.stringify(approvals),
          s.id,
        );
        if (
          members.length === 2 &&
          members.every((m) => approvals.includes(m.id))
        )
          finishSession(s, proposal.text);
        db.exec("COMMIT");
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
      break;
    }
    case "finish": {
      if (lesson.kind === "conversation")
        return fail(res, "Завершите разговор без обязательной договорённости.");
      if (s.mode === "remote")
        return fail(
          res,
          "Для сохранения нужны отдельные подтверждения обоих участников.",
        );
      if (!s.revealed) return fail(res, "Сначала ответьте и обсудите историю.");
      const text = req.body.text;
      if (
        typeof text !== "string" ||
        text.trim().length < 3 ||
        text.trim().length > 500
      )
        return fail(
          res,
          "Договорённость должна содержать от 3 до 500 символов.",
        );
      db.exec("BEGIN");
      try {
        finishSession(s, text.trim());
        db.exec("COMMIT");
      } catch (e) {
        db.exec("ROLLBACK");
        throw e;
      }
      break;
    }
    case "cancel":
      db.prepare("DELETE FROM sessions WHERE id=?").run(s.id);
      break;
    default:
      return fail(res, "Действие не найдено.", 404);
  }
  res.json({ ok: true });
});
app.post("/api/invite/rotate", (req, res) => {
  db.prepare("UPDATE families SET invite=? WHERE id=?").run(
    id(),
    req.member.family,
  );
  res.json({ ok: true });
});
app.delete("/api/account", (req, res) => {
  const m = req.member;
  db.prepare("DELETE FROM members WHERE id=?").run(m.id);
  if (!db.prepare("SELECT id FROM members WHERE family=?").get(m.family)) {
    db.prepare("DELETE FROM families WHERE id=?").run(m.family);
  } else {
    db.prepare("UPDATE families SET invite=? WHERE id=?").run(id(), m.family);
    db.prepare("DELETE FROM sessions WHERE family=? AND finished IS NULL").run(
      m.family,
    ); // Remove departed member's answer identifiers from history.
    for (const s of db
      .prepare("SELECT id,answers FROM sessions WHERE family=?")
      .all(m.family)) {
      const proposal = getProposal(s.id);
      if (proposal)
        db.prepare("UPDATE proposals SET approvals=? WHERE session=?").run(
          JSON.stringify(
            proposal.approvals.filter((member) => member !== m.id),
          ),
          s.id,
        );
      const a = JSON.parse(s.answers);
      delete a[m.id];
      db.prepare("UPDATE sessions SET answers=? WHERE id=?").run(
        JSON.stringify(a),
        s.id,
      );
    }
  }
  res.json({ ok: true });
});
app.use("/api", (req, res) => fail(res, "Маршрут не найден.", 404));
app.use(express.static("public"));
app.get("/", (req, res) =>
  res.sendFile(new URL("./public/index.html", import.meta.url).pathname),
);
app.use((err, req, res, next) => {
  if (err.type === "entity.parse.failed")
    return fail(res, "Некорректный JSON.", 400);
  if (err.type === "entity.too.large")
    return fail(res, "Слишком большой запрос.", 413);
  console.error(err.message);
  res
    .status(500)
    .json({ error: "Не удалось выполнить запрос. Попробуйте ещё раз." });
});
const port = Number(process.env.PORT || 3000);
const server = app.listen(port, "0.0.0.0", () =>
  console.log(`Рядом: http://0.0.0.0:${port}`),
);
function shutdown() {
  const timeout = setTimeout(() => process.exit(1), 10000);
  timeout.unref();
  server.close(() => {
    rateLimiter.close();
    db.close();
    clearTimeout(timeout);
    process.exit(0);
  });
  server.closeIdleConnections();
}
process.once("SIGTERM", shutdown);
process.once("SIGINT", shutdown);
