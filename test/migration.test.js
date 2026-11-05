import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn } from "node:child_process";

test("legacy database migration is repeatable and keeps profiles and progress", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ryadom-migration-"));
  const db = new DatabaseSync(join(dir, "ryadom.sqlite"));
  db.exec(`CREATE TABLE families(id TEXT PRIMARY KEY,invite TEXT UNIQUE,created TEXT);
 CREATE TABLE members(id TEXT PRIMARY KEY,family TEXT REFERENCES families(id) ON DELETE CASCADE,token TEXT UNIQUE,name TEXT);
 INSERT INTO families VALUES ('family','invitation','2026-01-01');`);
  const token = "legacy-token",
    hashed = createHash("sha256").update(token).digest("hex");
  db.prepare("INSERT INTO members VALUES (?,?,?,?)").run(
    "member",
    "family",
    hashed,
    "Старый профиль",
  );
  db.close();
  let server;
  const start = async () => {
    server = spawn(process.execPath, ["server.js"], {
      env: { ...process.env, PORT: "3220", DATA_DIR: dir },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(Error("Startup timeout")), 10000);
      server.stdout.once("data", () => {
        clearTimeout(t);
        resolve();
      });
      server.once("error", reject);
    });
  };
  const stop = () =>
    new Promise((resolve) => {
      server.once("exit", resolve);
      server.kill();
    });
  const request = async (path, body) => {
    const r = await fetch("http://127.0.0.1:3220/api" + path, {
      method: body ? "POST" : "GET",
      headers: {
        Authorization: "Bearer " + token,
        "Content-Type": "application/json",
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    assert.equal(r.status, 200);
    return r.json();
  };
  try {
    await start();
    const initialState = await request("/state");
    assert.equal(initialState.recoveryEnabled, false);
    assert.equal(initialState.devices.length, 1);
    const migratedDevice = initialState.devices[0].id;
    const edit = new DatabaseSync(join(dir, "ryadom.sqlite"));
    edit
      .prepare("INSERT INTO consents VALUES (?,?,?)")
      .run("member", "pilot-data-v1", "2026-01-01T00:00:00.000Z");
    edit.close();
    const oldConsent = await request("/state");
    assert.equal(oldConsent.consent.version, "pilot-data-v1");
    assert.equal(oldConsent.consentVersion, "pilot-data-v3-security");
    await request("/consent", { consent: true });
    assert.equal(
      (await request("/state")).consent.version,
      "pilot-data-v3-security",
    );
    const recovery = await request("/recovery-code", {});
    assert.ok(recovery.recoveryCode);
    const session = await request("/start", {
      lesson: "bank",
      mode: "together",
    });
    await request(`/session/${session.id}/answer`, {
      choice: 0,
      person: "first",
    });
    await stop();
    await start();
    const state = await request("/state");
    assert.equal(state.me, "member");
    assert.equal(state.members[0].name, "Старый профиль");
    assert.equal(state.recoveryEnabled, true);
    assert.equal(state.sessions[0].answers.first, 0);
    assert.equal(state.sessions[0].id, session.id);
    assert.equal(state.devices.length, 1);
    assert.equal(state.devices[0].id, migratedDevice);
    await request("/logout", {});
    const invalid = await fetch("http://127.0.0.1:3220/api/state", {
      headers: { Authorization: "Bearer " + token },
    });
    assert.equal(invalid.status, 401);
  } finally {
    if (server?.exitCode === null) await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
