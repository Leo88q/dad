import { test } from "node:test";
import assert from "node:assert/strict";
import {
  mkdtemp,
  mkdir,
  writeFile,
  readFile,
  readdir,
  rm,
  chmod,
  stat,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import { spawnSync, spawn } from "node:child_process";
import { once } from "node:events";
import {
  loadBackupKey,
  encryptBackup,
  decryptBackup,
  createEncryptedBackup,
} from "../lib/encrypted-backup.js";

async function workspace(fn) {
  const dir = await mkdtemp(join(tmpdir(), "ryadom-backup-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}
async function fixture(dir) {
  const dataDir = join(dir, "data"),
    archiveDir = join(dir, "archives"),
    keyFile = join(dir, "key");
  await mkdir(dataDir);
  await writeFile(keyFile, randomBytes(32).toString("hex"), { mode: 0o600 });
  const db = new DatabaseSync(join(dataDir, "ryadom.sqlite"));
  db.exec(
    `PRAGMA journal_mode=WAL; CREATE TABLE families(id TEXT PRIMARY KEY,invite TEXT); INSERT INTO families VALUES('pair','private-invite'); CREATE TABLE members(id TEXT PRIMARY KEY,token TEXT,recovery TEXT); INSERT INTO members VALUES('person','old-token','old-recovery'); CREATE TABLE sessions(id TEXT); CREATE TABLE agreements(text TEXT); INSERT INTO agreements VALUES('Private family thought');`,
  );
  return { dataDir, archiveDir, keyFile, db };
}
function run(script, args, env) {
  return spawnSync(process.execPath, [resolve("scripts", script), ...args], {
    env: { ...process.env, ...env },
    encoding: "utf8",
  });
}
test("encrypted backup snapshots committed WAL, verifies round trip, restricts permissions and never stores clear SQLite in archive directory", async () =>
  workspace(async (dir) => {
    const f = await fixture(dir);
    try {
      f.db
        .prepare("INSERT INTO agreements VALUES(?)")
        .run("Committed WAL text");
      const result = await createEncryptedBackup(f);
      assert.equal(result.ok, true);
      assert.match(result.sha256, /^[a-f0-9]{64}$/);
      assert.equal(
        (await stat(join(f.archiveDir, result.archive))).mode & 0o777,
        0o600,
      );
      assert.deepEqual(await readdir(f.archiveDir), [result.archive]);
      assert.equal(
        (await readFile(join(f.archiveDir, result.archive))).includes(
          Buffer.from("Private family thought"),
        ),
        false,
      );
      const key = await loadBackupKey(f.keyFile),
        out = join(dir, "restored.sqlite");
      await decryptBackup(join(f.archiveDir, result.archive), out, key);
      const check = new DatabaseSync(out, { readOnly: true });
      try {
        assert.equal(
          check.prepare("SELECT count(*) n FROM agreements").get().n,
          2,
        );
      } finally {
        check.close();
        key.fill(0);
      }
    } finally {
      f.db.close();
    }
  }));
test("wrong key, modified ciphertext, modified header and truncation never publish plaintext or overwrite existing output", async () =>
  workspace(async (dir) => {
    const key = randomBytes(32),
      plain = join(dir, "source"),
      archive = join(dir, "archive");
    await writeFile(plain, randomBytes(10000));
    await encryptBackup(plain, archive, key);
    const valid = await readFile(archive);
    for (const [name, body, k] of [
      ["wrong", valid, randomBytes(32)],
      ["body", Buffer.from(valid), key],
      ["header", Buffer.from(valid), key],
      ["short", valid.subarray(0, 25), key],
    ]) {
      if (name === "body") body[40] ^= 1;
      if (name === "header") body[0] ^= 1;
      const file = join(dir, name);
      await writeFile(file, body);
      await assert.rejects(decryptBackup(file, join(dir, "out"), k));
      await assert.rejects(stat(join(dir, "out")));
      assert.equal(
        (await readdir(dir)).some((n) => n.endsWith(".partial")),
        false,
      );
    }
    await writeFile(join(dir, "existing"), "DO NOT REPLACE");
    await assert.rejects(decryptBackup(archive, join(dir, "existing"), key));
    assert.equal(
      await readFile(join(dir, "existing"), "utf8"),
      "DO NOT REPLACE",
    );
    await assert.rejects(encryptBackup(plain, archive, key));
    assert.deepEqual(await readFile(archive), valid);
  }));
test("backup key requires private permissions, valid hex and explicit file", async () =>
  workspace(async (dir) => {
    const key = join(dir, "key");
    await writeFile(key, "a".repeat(64), { mode: 0o644 });
    await assert.rejects(loadBackupKey(key), /private/);
    await chmod(key, 0o600);
    assert.equal((await loadBackupKey(key)).length, 32);
    await writeFile(key, "not-a-key");
    await assert.rejects(loadBackupKey(key), /hexadecimal/);
    await assert.rejects(loadBackupKey(), /required/);
  }));
test("rotation preserves unrelated files and runs only after a verified replacement", async () =>
  workspace(async (dir) => {
    const f = await fixture(dir);
    try {
      await mkdir(f.archiveDir);
      await writeFile(join(f.archiveDir, "operator-notes"), "keep");
      await createEncryptedBackup({ ...f, keep: 2 });
      await createEncryptedBackup({ ...f, keep: 2 });
      await createEncryptedBackup({ ...f, keep: 2 });
      assert.equal(
        (await readdir(f.archiveDir)).filter((n) => n.endsWith(".enc")).length,
        2,
      );
      f.db.exec("DROP TABLE sessions");
      const before = (await readdir(f.archiveDir)).sort();
      await assert.rejects(
        createEncryptedBackup({ ...f, keep: 1 }),
        /required/,
      );
      assert.deepEqual((await readdir(f.archiveDir)).sort(), before);
      await assert.rejects(
        createEncryptedBackup({ ...f, keep: 0 }),
        /retention/,
      );
    } finally {
      f.db.close();
    }
  }));
test("CLI creates encrypted backup, health detects failure/staleness, and decrypt flows through hardened restore review lock", async () =>
  workspace(async (dir) => {
    const f = await fixture(dir);
    f.db.close();
    const env = {
      DATA_DIR: f.dataDir,
      BACKUP_DIR: f.archiveDir,
      BACKUP_KEY_FILE: f.keyFile,
    };
    let result = run("encrypted-backup.js", [], env);
    assert.equal(result.status, 0, result.stderr);
    let state = JSON.parse(
      await readFile(join(f.archiveDir, "backup-status.json"), "utf8"),
    );
    assert.equal(run("backup-health.js", [], env).status, 0);
    const out = join(dir, "snapshot.sqlite");
    result = run(
      "decrypt-backup.js",
      [join(f.archiveDir, state.archive), out],
      env,
    );
    assert.equal(result.status, 0, result.stderr);
    const restored = join(dir, "hardened");
    result = run("restore.js", [out, "--confirm-stopped"], {
      ...env,
      DATA_DIR: restored,
    });
    assert.equal(result.status, 0, result.stderr);
    const check = new DatabaseSync(join(restored, "ryadom.sqlite"));
    try {
      assert.equal(
        check.prepare("SELECT review_pending FROM restore_state").get()
          .review_pending,
        1,
      );
      assert.notEqual(
        check.prepare("SELECT token FROM members").get().token,
        "old-token",
      );
      assert.equal(
        check.prepare("SELECT recovery FROM members").get().recovery,
        null,
      );
      assert.equal(
        check.prepare("SELECT text FROM agreements").get().text,
        "Private family thought",
      );
    } finally {
      check.close();
    }
    state.verifiedAt = "2000-01-01T00:00:00Z";
    await writeFile(
      join(f.archiveDir, "backup-status.json"),
      JSON.stringify(state),
    );
    assert.equal(run("backup-health.js", [], env).status, 1);
    result = run("encrypted-backup.js", [], {
      ...env,
      BACKUP_KEY_FILE: join(dir, "missing"),
    });
    assert.equal(result.status, 1);
    assert.equal(
      JSON.parse(
        await readFile(join(f.archiveDir, "backup-status.json"), "utf8"),
      ).ok,
      false,
    );
    assert.equal(run("backup-health.js", [], env).status, 1);
  }));

test(
  "scheduled worker completes its first cycle immediately and stops promptly on SIGTERM",
  { timeout: 10000 },
  async () =>
    workspace(async (dir) => {
      const f = await fixture(dir);
      f.db.close();
      const worker = spawn(
        process.execPath,
        ["scripts/encrypted-backup.js", "--daemon"],
        {
          env: {
            ...process.env,
            DATA_DIR: f.dataDir,
            BACKUP_DIR: f.archiveDir,
            BACKUP_KEY_FILE: f.keyFile,
            BACKUP_INTERVAL_SECONDS: "60",
          },
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      try {
        let text = "";
        await new Promise((resolve, reject) => {
          worker.stdout.on("data", (chunk) => {
            text += chunk;
            if (text.includes("verifiedAt")) resolve();
          });
          worker.once("error", reject);
          worker.once("exit", (code) =>
            reject(new Error("Worker exited early: " + code)),
          );
        });
        const exited = once(worker, "exit");
        worker.kill("SIGTERM");
        const [code] = await exited;
        assert.equal(code, 0);
        assert.equal(
          run("backup-health.js", [], {
            BACKUP_DIR: f.archiveDir,
            BACKUP_INTERVAL_SECONDS: "60",
          }).status,
          0,
        );
      } finally {
        if (worker.exitCode === null) worker.kill("SIGKILL");
      }
    }),
);

test("concurrent backup workers cannot race archive rotation and stale locks fail safely", async () =>
  workspace(async (dir) => {
    const f = await fixture(dir);
    try {
      const outcomes = await Promise.allSettled([
        createEncryptedBackup({ ...f, keep: 1 }),
        createEncryptedBackup({ ...f, keep: 1 }),
      ]);
      assert.equal(outcomes.filter((r) => r.status === "fulfilled").length, 1);
      assert.match(
        outcomes.find((r) => r.status === "rejected").reason.message,
        /locked/,
      );
      const saved = await readdir(f.archiveDir);
      await mkdir(join(f.archiveDir, ".backup-cycle.lock"));
      await assert.rejects(createEncryptedBackup(f), /locked/);
      assert.deepEqual(
        (await readdir(f.archiveDir)).filter((n) => n !== ".backup-cycle.lock"),
        saved,
      );
    } finally {
      f.db.close();
    }
  }));
