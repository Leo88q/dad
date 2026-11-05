import { randomBytes, createHash } from "node:crypto";

export function ensureRecoveryState(db) {
  db.exec(`CREATE TABLE IF NOT EXISTS restore_state (
    id INTEGER PRIMARY KEY CHECK(id=1),review_pending INTEGER NOT NULL CHECK(review_pending IN (0,1)),
    auth_not_before INTEGER NOT NULL,restored_at TEXT NOT NULL,reviewed_at TEXT
  )`);
}
export function recoveryState(db, now = Date.now()) {
  const row = db.prepare("SELECT * FROM restore_state WHERE id=1").get();
  if (!row) return { blocked: false, reviewPending: false, authNotBefore: 0 };
  return {
    blocked: !!row.review_pending || now < row.auth_not_before,
    reviewPending: !!row.review_pending,
    authNotBefore: row.auth_not_before,
  };
}
const hasTable = (db, name) =>
  !!db
    .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
    .get(name);
const hasColumn = (db, table, column) =>
  db
    .prepare(`PRAGMA table_info(${table})`)
    .all()
    .some((row) => row.name === column);
// Only runs on the private restored copy, before it is published as ryadom.sqlite.
export function hardenRestoredDatabase(db, now = Date.now()) {
  ensureRecoveryState(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    for (const table of ["access_sessions", "device_codes", "max_launches"])
      if (hasTable(db, table)) db.exec(`DELETE FROM ${table}`);
    if (hasColumn(db, "members", "token"))
      for (const row of db.prepare("SELECT id FROM members").all()) {
        const unknowable = createHash("sha256")
          .update(randomBytes(32))
          .digest("hex");
        db.prepare("UPDATE members SET token=? WHERE id=?").run(
          unknowable,
          row.id,
        );
      }
    if (hasColumn(db, "members", "recovery"))
      db.exec("UPDATE members SET recovery=NULL");
    if (hasColumn(db, "families", "invite"))
      for (const row of db.prepare("SELECT id FROM families").all())
        db.prepare("UPDATE families SET invite=? WHERE id=?").run(
          randomBytes(18).toString("hex"),
          row.id,
        );
    db.prepare(
      "INSERT INTO restore_state VALUES (1,1,?,?,NULL) ON CONFLICT(id) DO UPDATE SET review_pending=1,auth_not_before=excluded.auth_not_before,restored_at=excluded.restored_at,reviewed_at=NULL",
    ).run(Math.floor(now / 1000) * 1000 + 61000, new Date(now).toISOString());
    db.exec("COMMIT");
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
export function releaseRestoredDatabase(db, now = Date.now()) {
  ensureRecoveryState(db);
  db.exec("BEGIN IMMEDIATE");
  try {
    const row = db.prepare("SELECT * FROM restore_state WHERE id=1").get();
    if (!row?.review_pending)
      throw new Error(
        "Нет восстановления, ожидающего проверки. Доступы не изменены.",
      );
    // MAX accepts clock skew up to 60s. Exclude even pre-release launches whose
    // signed timestamp was ahead of our clock, then wait for a genuinely new launch.
    const floor = Math.floor(now / 1000) * 1000 + 61000;
    db.prepare(
      "UPDATE restore_state SET review_pending=0,auth_not_before=?,reviewed_at=? WHERE id=1",
    ).run(floor, new Date(now).toISOString());
    db.exec("COMMIT");
    return { authNotBefore: floor };
  } catch (err) {
    db.exec("ROLLBACK");
    throw err;
  }
}
