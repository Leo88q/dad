import { createEncryptedBackup } from "../lib/encrypted-backup.js";
import { writeFile, rename, rm } from "node:fs/promises";
import { join, resolve } from "node:path";
import { setTimeout } from "node:timers/promises";
import { randomBytes } from "node:crypto";
process.umask(0o077);
const daemon = process.argv.includes("--daemon");
const interval = Number(process.env.BACKUP_INTERVAL_SECONDS || 21600);
const keep = Number(process.env.BACKUP_KEEP || 56);
const dir = resolve(process.env.BACKUP_DIR || "./backups/encrypted");
let stopping = false;
const shutdown = new AbortController();
for (const signal of ["SIGINT", "SIGTERM"])
  process.on(signal, () => {
    stopping = true;
    shutdown.abort();
  });
async function status(value) {
  const path = join(dir, "backup-status.json"),
    temp = path + "." + randomBytes(8).toString("hex");
  try {
    await writeFile(temp, JSON.stringify(value) + "\n", {
      mode: 0o600,
      flag: "wx",
    });
    await rename(temp, path);
  } finally {
    await rm(temp, { force: true });
  }
}
try {
  if (!Number.isInteger(interval) || interval < 60 || interval > 604800)
    throw new Error("BACKUP_INTERVAL_SECONDS must be 60..604800");
  if (!Number.isInteger(keep) || keep < 1 || keep > 3650)
    throw new Error("BACKUP_KEEP must be 1..3650");
  do {
    let failed = false;
    try {
      const result = await createEncryptedBackup({
        dataDir: process.env.DATA_DIR || "./data",
        archiveDir: dir,
        keyFile: process.env.BACKUP_KEY_FILE,
        keep,
      });
      await status(result);
      console.log(JSON.stringify(result));
    } catch (err) {
      failed = true;
      try {
        await status({ ok: false, failedAt: new Date().toISOString() });
      } catch {}
      console.error("Encrypted backup failed:", err.message);
      if (!daemon) throw new Error("Backup cycle failed");
    }
    if (!daemon || stopping) break;
    try {
      await setTimeout(
        (failed ? Math.min(interval, 300) : interval) * 1000,
        null,
        { signal: shutdown.signal },
      );
    } catch (err) {
      if (err.name !== "AbortError") throw err;
    }
  } while (!stopping);
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
