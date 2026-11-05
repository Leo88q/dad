import { test } from "node:test";
import assert from "node:assert/strict";
import { DatabaseSync } from "node:sqlite";
import {
  mkdtempSync,
  rmSync,
  existsSync,
  readFileSync,
  writeFileSync,
  statSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { execFileSync, spawnSync } from "node:child_process";

test("online backup includes WAL, restores in empty directory, checks integrity and refuses overwrite or corruption", () => {
  const root = mkdtempSync(join(tmpdir(), "ryadom-backup-"));
  const source = join(root, "ryadom.sqlite");
  const db = new DatabaseSync(source);
  try {
    db.exec(`PRAGMA journal_mode=WAL;
    CREATE TABLE families(id TEXT); CREATE TABLE members(id TEXT,name TEXT);
    CREATE TABLE sessions(id TEXT,finished TEXT); CREATE TABLE agreements(text TEXT);
    INSERT INTO families VALUES ('pair'); INSERT INTO members VALUES ('first','Анна');
    INSERT INTO sessions VALUES ('lesson','2026-01-01'); INSERT INTO agreements VALUES ('Перезваниваем сами');`);
    assert.ok(existsSync(source + "-wal"));
    const output = execFileSync(
      process.execPath,
      ["scripts/backup.js", join(root, "backups")],
      { env: { ...process.env, DATA_DIR: root }, encoding: "utf8" },
    );
    const backup = JSON.parse(output);
    assert.equal(backup.ok, true);
    assert.equal(statSync(backup.file).mode & 0o777, 0o600);
    const restoreDir = join(root, "restored");
    const run = (dir) =>
      spawnSync(
        process.execPath,
        ["scripts/restore.js", backup.file, "--confirm-stopped"],
        { env: { ...process.env, DATA_DIR: dir }, encoding: "utf8" },
      );
    assert.equal(run(restoreDir).status, 0);
    const restored = new DatabaseSync(join(restoreDir, "ryadom.sqlite"), {
      readOnly: true,
    });
    try {
      assert.equal(
        restored.prepare("SELECT text FROM agreements").get().text,
        "Перезваниваем сами",
      );
      assert.equal(
        restored.prepare("PRAGMA integrity_check").get().integrity_check,
        "ok",
      );
    } finally {
      restored.close();
    }
    const again = run(restoreDir);
    assert.notEqual(again.status, 0);
    assert.match(again.stderr, /Ничего не перезаписано/);
    const checksum = readFileSync(backup.file + ".sha256", "utf8");
    writeFileSync(
      backup.file + ".sha256",
      "0".repeat(64) + "  backup.sqlite\n",
    );
    const corrupt = run(join(root, "bad"));
    assert.notEqual(corrupt.status, 0);
    assert.match(corrupt.stderr, /сумма/);
    assert.equal(existsSync(join(root, "bad", "ryadom.sqlite")), false);
    writeFileSync(backup.file + ".sha256", checksum);
    const missing = spawnSync(
      process.execPath,
      ["scripts/backup.js", join(root, "empty-backups")],
      {
        env: { ...process.env, DATA_DIR: join(root, "absent") },
        encoding: "utf8",
      },
    );
    assert.notEqual(missing.status, 0);
    assert.equal(existsSync(join(root, "absent", "ryadom.sqlite")), false);
  } finally {
    db.close();
    rmSync(root, { recursive: true, force: true });
  }
});
