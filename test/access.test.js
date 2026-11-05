import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { accessStore, digest } from "../lib/access.js";
function fixture() {
  const db = new DatabaseSync(":memory:");
  db.exec(
    `PRAGMA foreign_keys=ON; CREATE TABLE members(id TEXT PRIMARY KEY,token TEXT UNIQUE,recovery TEXT);`,
  );
  db.prepare("INSERT INTO members VALUES (?,?,?)").run(
    "a",
    digest("old-a"),
    digest("recovery-a"),
  );
  db.prepare("INSERT INTO members VALUES (?,?,?)").run(
    "b",
    digest("old-b"),
    digest("recovery-b"),
  );
  let now = Date.UTC(2026, 0, 1);
  const access = accessStore(db, () => now);
  return { db, access, advance: (ms) => (now += ms) };
}

test("legacy key migrates once, survives repeated initialization and cannot resurrect after logout", () => {
  const { db, access } = fixture();
  try {
    const session = access.authenticate("old-a");
    assert.equal(session.member, "a");
    assert.equal(access.list("a", session.id).length, 1);
    assert.notEqual(
      db.prepare("SELECT token FROM members WHERE id=?").get("a").token,
      digest("old-a"),
    );
    assert.equal(access.authenticate("old-a").id, session.id);
    assert.equal(accessStore(db).authenticate("old-a").id, session.id);
    access.logout("a", session.id);
    assert.equal(access.authenticate("old-a"), null);
    assert.equal(access.list("a", session.id).length, 0);
    assert.equal(access.authenticate("garbage"), null);
  } finally {
    db.close();
  }
});

test("device codes are hashed, single-use, expire at ten minutes and are replaced on reissue", () => {
  const { db, access, advance } = fixture();
  try {
    access.authenticate("old-a");
    const first = access.issueCode("a");
    assert.match(first.code, /^(?:[a-f0-9]{4}-){5}[a-f0-9]{4}$/);
    assert.equal(
      JSON.stringify(db.prepare("SELECT * FROM device_codes").get()).includes(
        first.code,
      ),
      false,
    );
    const second = access.issueCode("a");
    assert.equal(access.connect(first.code, "Устройство").status, 400);
    const connected = access.connect(
      second.code.toUpperCase().replaceAll("-", " "),
      " Планшет ",
    );
    assert.ok(connected.token);
    const session = access.authenticate(connected.token);
    assert.equal(session.label, "Планшет");
    assert.equal(session.member, "a");
    assert.equal(access.connect(second.code, "Другое").status, 400);
    const expired = access.issueCode("a");
    advance(600000);
    assert.equal(access.connect(expired.code, "Другое").status, 400);
  } finally {
    db.close();
  }
});

test("revocation is scoped to one member, cancels pending codes and leaves this device connected", () => {
  const { db, access } = fixture();
  try {
    const a = access.authenticate("old-a"),
      b = access.authenticate("old-b");
    const token = access.connect(access.issueCode("a").code, "Второе").token;
    const second = access.authenticate(token),
      pending = access.issueCode("a");
    assert.equal(access.revoke("b", second.id, b.id).status, 404);
    assert.ok(access.authenticate(token));
    assert.equal(access.revoke("a", a.id, a.id).status, 400);
    assert.equal(access.revoke("a", second.id, a.id).ok, true);
    assert.equal(access.authenticate(token), null);
    assert.equal(access.connect(pending.code, "Третье").status, 400);
    assert.ok(access.authenticate("old-a"));
    assert.ok(access.authenticate("old-b"));
  } finally {
    db.close();
  }
});

test("recovery resets all devices and codes but not another member; logout affects only one session", () => {
  const { db, access } = fixture();
  try {
    const first = access.authenticate("old-a");
    access.authenticate("old-b");
    const secondToken = access.connect(
      access.issueCode("a").code,
      "Второе",
    ).token;
    const second = access.authenticate(secondToken);
    access.logout("a", second.id);
    assert.ok(access.authenticate("old-a"));
    assert.equal(access.authenticate(secondToken), null);
    const thirdToken = access.connect(
      access.issueCode("a").code,
      "Третье",
    ).token;
    const pending = access.issueCode("a");
    access.reset(
      "a",
      "recovered-token",
      digest("new-recovery"),
      "Новый телефон",
    );
    assert.equal(access.authenticate("old-a"), null);
    assert.equal(access.authenticate(thirdToken), null);
    assert.ok(access.authenticate("old-b"));
    assert.equal(access.list("a", first.id).length, 1);
    assert.equal(access.authenticate("recovered-token").label, "Новый телефон");
    assert.equal(access.connect(pending.code, "Вход").status, 400);
    assert.equal(
      db.prepare("SELECT recovery FROM members WHERE id=?").get("a").recovery,
      digest("new-recovery"),
    );
  } finally {
    db.close();
  }
});

test("maximum five devices, revoke-others preserves current session and deleting member cascades access", () => {
  const { db, access } = fixture();
  try {
    const current = access.authenticate("old-a");
    const tokens = [];
    for (let i = 0; i < 4; i++)
      tokens.push(
        access.connect(access.issueCode("a").code, "Устройство " + i).token,
      );
    const last = access.issueCode("a");
    assert.equal(access.connect(last.code, "Шестое").status, 409);
    assert.equal(access.list("a", current.id).length, 5);
    access.revokeOthers("a", current.id);
    assert.equal(access.list("a", current.id).length, 1);
    for (const token of tokens) assert.equal(access.authenticate(token), null);
    assert.ok(access.authenticate("old-a"));
    assert.equal(access.connect(last.code, "Шестое").status, 400);
    access.issueCode("a");
    db.prepare("DELETE FROM members WHERE id=?").run("a");
    assert.equal(
      db.prepare("SELECT count(*) n FROM access_sessions").get().n,
      0,
    );
    assert.equal(db.prepare("SELECT count(*) n FROM device_codes").get().n, 0);
  } finally {
    db.close();
  }
});

test("lastSeen is coarsened to a minute; labels are bounded and no IP or full user-agent is recorded", () => {
  const { db, access, advance } = fixture();
  try {
    const s = access.authenticate("old-a");
    advance(59000);
    assert.equal(access.authenticate("old-a").lastSeen, s.lastSeen);
    advance(1000);
    assert.notEqual(access.authenticate("old-a").lastSeen, s.lastSeen);
    const connected = access.connect(
      access.issueCode("a").code,
      "x".repeat(100),
    );
    assert.equal(access.authenticate(connected.token).label.length, 40);
    assert.deepEqual(
      Object.keys(access.list("a", s.id)[0]).sort(),
      ["created", "current", "id", "label", "lastSeen"].sort(),
    );
  } finally {
    db.close();
  }
});
