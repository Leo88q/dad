import { randomBytes, createHash } from "node:crypto";

export const digest = (value) =>
  createHash("sha256").update(value).digest("hex");
const identifier = () => randomBytes(18).toString("hex");
export const normalizeDeviceCode = (code) =>
  typeof code === "string" ? code.toLowerCase().replace(/[\s-]/g, "") : "";
export const deviceLabel = (value) =>
  typeof value === "string" && value.trim().length
    ? value.trim().slice(0, 40)
    : "Устройство";

export function accessStore(db, clock = () => Date.now()) {
  db.exec(`CREATE TABLE IF NOT EXISTS access_sessions (
    id TEXT PRIMARY KEY, member TEXT NOT NULL REFERENCES members(id) ON DELETE CASCADE,
    token TEXT NOT NULL UNIQUE, label TEXT NOT NULL, created TEXT NOT NULL, lastSeen TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS access_member ON access_sessions(member);
  CREATE TABLE IF NOT EXISTS device_codes (
    member TEXT PRIMARY KEY REFERENCES members(id) ON DELETE CASCADE,
    code TEXT NOT NULL UNIQUE, expires INTEGER NOT NULL
  );`);
  const transaction = (fn) => {
    db.exec("BEGIN");
    try {
      const result = fn();
      db.exec("COMMIT");
      return result;
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  };
  function create(member, token, label) {
    const now = new Date(clock()).toISOString();
    const id = identifier();
    db.prepare("INSERT INTO access_sessions VALUES (?,?,?,?,?,?)").run(
      id,
      member,
      digest(token),
      deviceLabel(label),
      now,
      now,
    );
    return id;
  }
  function authenticate(token) {
    const hashed = digest(token);
    let session = db
      .prepare("SELECT * FROM access_sessions WHERE token=?")
      .get(hashed);
    if (!session) {
      // On the first authenticated request migrate the old single key. Replace
      // the legacy value so deleting this session can never reactivate it.
      const legacy = db
        .prepare("SELECT id FROM members WHERE token=?")
        .get(hashed);
      if (!legacy) return null;
      transaction(() => {
        create(legacy.id, token, "Ранее использованное устройство");
        db.prepare("UPDATE members SET token=? WHERE id=?").run(
          digest(identifier()),
          legacy.id,
        );
      });
      session = db
        .prepare("SELECT * FROM access_sessions WHERE token=?")
        .get(hashed);
    }
    if (clock() - Date.parse(session.lastSeen) >= 60000) {
      session.lastSeen = new Date(clock()).toISOString();
      db.prepare("UPDATE access_sessions SET lastSeen=? WHERE id=?").run(
        session.lastSeen,
        session.id,
      );
    }
    return session;
  }
  function reset(member, token, recoveryHash, label) {
    transaction(() => {
      db.prepare("DELETE FROM access_sessions WHERE member=?").run(member);
      db.prepare("DELETE FROM device_codes WHERE member=?").run(member);
      db.prepare("UPDATE members SET token=?,recovery=? WHERE id=?").run(
        digest(identifier()),
        recoveryHash,
        member,
      );
      create(member, token, label);
    });
  }
  function issueCode(member) {
    const code = randomBytes(12).toString("hex").match(/.{4}/g).join("-");
    const expires = clock() + 10 * 60 * 1000;
    db.prepare("DELETE FROM device_codes WHERE expires<=?").run(clock());
    db.prepare(
      "INSERT INTO device_codes VALUES (?,?,?) ON CONFLICT(member) DO UPDATE SET code=excluded.code,expires=excluded.expires",
    ).run(member, digest(normalizeDeviceCode(code)), expires);
    return { code, expiresAt: new Date(expires).toISOString() };
  }
  function connect(code, label) {
    const normalized = normalizeDeviceCode(code);
    const found = /^[a-f0-9]{24}$/.test(normalized)
      ? db
          .prepare("SELECT * FROM device_codes WHERE code=? AND expires>?")
          .get(digest(normalized), clock())
      : null;
    if (!found)
      return {
        error:
          "Код не найден, уже использован или истёк. Получите новый на подключённом устройстве.",
        status: 400,
      };
    if (
      db
        .prepare("SELECT count(*) n FROM access_sessions WHERE member=?")
        .get(found.member).n >= 5
    )
      return {
        error:
          "Уже подключены пять устройств. Отключите ненужное и попробуйте ещё раз.",
        status: 409,
      };
    const token = identifier();
    transaction(() => {
      db.prepare("DELETE FROM device_codes WHERE member=?").run(found.member);
      create(found.member, token, label);
    });
    return { token };
  }
  function list(member, current) {
    return db
      .prepare(
        "SELECT id,label,created,lastSeen FROM access_sessions WHERE member=? ORDER BY created,id",
      )
      .all(member)
      .map((s) => ({ ...s, current: s.id === current }));
  }
  function revoke(member, target, current) {
    if (target === current)
      return {
        error: "Для выхода на текущем устройстве используйте кнопку «Выйти».",
        status: 400,
      };
    const result = db
      .prepare("DELETE FROM access_sessions WHERE member=? AND id=?")
      .run(member, target);
    if (!result.changes)
      return { error: "Устройство не найдено или уже отключено.", status: 404 };
    db.prepare("DELETE FROM device_codes WHERE member=?").run(member);
    return { ok: true };
  }
  function revokeOthers(member, current) {
    transaction(() => {
      db.prepare("DELETE FROM access_sessions WHERE member=? AND id<>?").run(
        member,
        current,
      );
      db.prepare("DELETE FROM device_codes WHERE member=?").run(member);
    });
  }
  function logout(member, current) {
    transaction(() => {
      db.prepare("DELETE FROM access_sessions WHERE member=? AND id=?").run(
        member,
        current,
      );
      db.prepare("DELETE FROM device_codes WHERE member=?").run(member);
    });
  }
  return {
    create,
    authenticate,
    reset,
    issueCode,
    connect,
    list,
    revoke,
    revokeOthers,
    logout,
  };
}
