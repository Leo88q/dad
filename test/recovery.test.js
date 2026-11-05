import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  ensureRecoveryState,
  recoveryState,
  hardenRestoredDatabase,
  releaseRestoredDatabase,
} from "../lib/recovery.js";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, execFileSync, spawnSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
function fixture(requiredRecovery = false) {
  const db = new DatabaseSync(":memory:");
  db.exec(`CREATE TABLE families(id TEXT PRIMARY KEY,invite TEXT UNIQUE);INSERT INTO families VALUES ('family','old-invite');
 CREATE TABLE members(id TEXT PRIMARY KEY,token TEXT UNIQUE,recovery TEXT ${requiredRecovery ? "NOT NULL" : ""});INSERT INTO members VALUES ('member','old-token-hash','old-recovery-hash');
 CREATE TABLE access_sessions(id TEXT);INSERT INTO access_sessions VALUES ('session');CREATE TABLE device_codes(code TEXT);INSERT INTO device_codes VALUES ('code');CREATE TABLE max_launches(fingerprint TEXT);INSERT INTO max_launches VALUES ('launch');
 CREATE TABLE max_accounts(user_id TEXT,member TEXT);INSERT INTO max_accounts VALUES ('1','member');CREATE TABLE agreements(text TEXT);INSERT INTO agreements VALUES ('Проверяем звонком');`);
  return db;
}
test("restore hardening resets every old capability but preserves profile bindings and content behind review lock", () => {
  const db = fixture(),
    now = Date.UTC(2026, 10, 4, 12, 0, 0, 500);
  try {
    hardenRestoredDatabase(db, now);
    for (const table of ["access_sessions", "device_codes", "max_launches"])
      assert.equal(db.prepare(`SELECT count(*) n FROM ${table}`).get().n, 0);
    assert.notEqual(
      db.prepare("SELECT token FROM members").get().token,
      "old-token-hash",
    );
    assert.equal(
      db.prepare("SELECT recovery FROM members").get().recovery,
      null,
    );
    assert.notEqual(
      db.prepare("SELECT invite FROM families").get().invite,
      "old-invite",
    );
    assert.equal(
      db.prepare("SELECT text FROM agreements").get().text,
      "Проверяем звонком",
    );
    assert.equal(
      db.prepare("SELECT user_id FROM max_accounts").get().user_id,
      "1",
    );
    assert.equal(recoveryState(db, now).reviewPending, true);
    assert.equal(recoveryState(db, now + 86400000).blocked, true);
  } finally {
    db.close();
  }
});
test("restored service opens only after explicit review and a full future-clock-skew exclusion window", () => {
  const db = fixture(),
    now = Date.UTC(2026, 10, 4, 12, 0, 0, 500);
  try {
    ensureRecoveryState(db);
    assert.equal(recoveryState(db, now).blocked, false);
    assert.throws(() => releaseRestoredDatabase(db, now), /Нет восстановления/);
    hardenRestoredDatabase(db, now);
    const { authNotBefore } = releaseRestoredDatabase(db, now + 100000);
    assert.ok(authNotBefore > now + 100000 + 60000);
    assert.equal(recoveryState(db, authNotBefore - 1).blocked, true);
    assert.equal(recoveryState(db, authNotBefore).blocked, false);
    assert.equal(recoveryState(db, authNotBefore).reviewPending, false);
    assert.throws(() => releaseRestoredDatabase(db, now), /Нет восстановления/);
  } finally {
    db.close();
  }
});
test("failed restore hardening rolls back revocations and never partially commits a review state", () => {
  const db = fixture(true);
  try {
    assert.throws(() => hardenRestoredDatabase(db), /NOT NULL/);
    assert.equal(
      db.prepare("SELECT count(*) n FROM access_sessions").get().n,
      1,
    );
    assert.equal(
      db.prepare("SELECT token FROM members").get().token,
      "old-token-hash",
    );
    assert.equal(db.prepare("SELECT count(*) n FROM restore_state").get().n, 0);
  } finally {
    db.close();
  }
});
const secret = "restore-http-test-not-real-max-bot-token";
function launch(age = 0) {
  const p = new URLSearchParams({
    query_id: randomUUID(),
    auth_date: String(Math.floor(Date.now() / 1000) - age),
    user: JSON.stringify({ id: 91822, first_name: "Владелец" }),
  });
  const k = createHmac("sha256", "WebAppData").update(secret).digest();
  p.set(
    "hash",
    createHmac("sha256", k)
      .update(
        [...p]
          .map(([a, b]) => `${a}=${b}`)
          .sort()
          .join("\n"),
      )
      .digest("hex"),
  );
  return p.toString();
}
test("real backup/restore/restart: API locked, release confirmed, old keys/codes/invites/launches rejected, new MAX entry keeps data", async () => {
  const root = mkdtempSync(join(tmpdir(), "ryadom-restore-http-")),
    source = join(root, "source"),
    restored = join(root, "restored");
  let child;
  const env = (dir) => ({
    ...process.env,
    DATA_DIR: dir,
    PORT: "3229",
    MAX_BOT_TOKEN: secret,
    MAX_BOT_NAME: "RyadomRestoreTestBot",
    MAX_ONLY: "false",
    NODE_ENV: "test",
  });
  async function start(dir) {
    child = spawn(process.execPath, ["server.js"], {
      env: env(dir),
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve, reject) => {
      const t = setTimeout(
        () => reject(new Error("restore server startup timeout")),
        10000,
      );
      child.stdout.once("data", () => {
        clearTimeout(t);
        resolve();
      });
      child.once("error", reject);
    });
  }
  async function stop() {
    if (child?.exitCode === null)
      await new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill();
      });
  }
  async function req(path, token, body) {
    const r = await fetch("http://127.0.0.1:3229" + path, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, data: await r.json() };
  }
  try {
    await start(source);
    const oldLaunch = launch(120),
      a = (
        await req("/api/max/auth", null, { initData: oldLaunch, consent: true })
      ).data;
    assert.ok(a.token);
    const state = (await req("/api/state", a.token)).data;
    await req("/api/lessons/bank/saved", a.token, { saved: true });
    const code = (await req("/api/device-code", a.token, {})).data.code;
    const backup = JSON.parse(
      execFileSync(
        process.execPath,
        ["scripts/backup.js", join(root, "backups")],
        { env: env(source), encoding: "utf8" },
      ),
    );
    await req("/api/logout", a.token, {});
    await stop();
    const output = JSON.parse(
      execFileSync(
        process.execPath,
        ["scripts/restore.js", backup.file, "--confirm-stopped"],
        { env: env(restored), encoding: "utf8" },
      ),
    );
    assert.equal(output.accessReset, true);
    assert.equal(output.reviewRequired, true);
    assert.notEqual(output.sourceSha256, output.sha256);
    const noReview = spawnSync(
      process.execPath,
      ["scripts/release-restore.js", "--confirm-stopped"],
      { env: env(restored), encoding: "utf8" },
    );
    assert.notEqual(noReview.status, 0);
    await start(restored);
    assert.equal((await req("/healthz")).status, 200);
    assert.equal((await req("/readyz")).status, 503);
    assert.equal((await req("/api/runtime-config")).status, 200);
    for (const [path, token, body] of [
      ["/api/state", a.token],
      ["/api/max/auth", null, { initData: launch() }],
      ["/api/recover", null, { code: a.recoveryCode }],
      ["/api/register", null, { name: "Новый", consent: true }],
    ])
      assert.equal((await req(path, token, body)).status, 503);
    await stop();
    const release = JSON.parse(
      execFileSync(
        process.execPath,
        [
          "scripts/release-restore.js",
          "--confirm-stopped",
          "--confirm-reviewed",
        ],
        { env: env(restored), encoding: "utf8" },
      ),
    );
    assert.ok(Date.parse(release.opensAt) > Date.now());
    await start(restored);
    assert.equal((await req("/readyz")).status, 503);
    await stop();
    // Advance only the test database past the cooldown, without real sleeps or production bypass flags.
    const db = new DatabaseSync(join(restored, "ryadom.sqlite"));
    db.prepare("UPDATE restore_state SET auth_not_before=? WHERE id=1").run(
      Math.floor(Date.now() / 1000) * 1000 - 1000,
    );
    db.close();
    await start(restored);
    assert.equal((await req("/readyz")).status, 200);
    assert.equal((await req("/api/state", a.token)).status, 401);
    assert.equal(
      (await req("/api/recover", null, { code: a.recoveryCode })).status,
      400,
    );
    assert.equal(
      (
        await req("/api/connect-device", null, {
          code,
          deviceLabel: "Старый код",
        })
      ).status,
      400,
    );
    assert.equal(
      (
        await req("/api/join", null, {
          name: "Чужой",
          consent: true,
          invite: state.invite,
        })
      ).status,
      404,
    );
    assert.equal(
      (await req("/api/max/auth", null, { initData: oldLaunch })).status,
      403,
    );
    const fresh = await req("/api/max/auth", null, { initData: launch() });
    assert.equal(fresh.status, 200);
    const after = (await req("/api/state", fresh.data.token)).data;
    assert.equal(after.me, state.me);
    assert.deepEqual(after.savedLessons, ["bank"]);
    assert.equal(after.recoveryEnabled, false);
    assert.notEqual(after.invite, state.invite);
    assert.equal(after.devices.length, 1);
    assert.equal(existsSync(backup.file), true);
  } finally {
    await stop();
    rmSync(root, { recursive: true, force: true });
  }
});
