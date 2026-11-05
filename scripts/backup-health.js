import { readFile, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
try {
  const interval = Number(process.env.BACKUP_INTERVAL_SECONDS || 21600);
  if (!Number.isInteger(interval) || interval < 60 || interval > 604800)
    throw new Error("Invalid backup interval");
  const dir = resolve(process.env.BACKUP_DIR || "./backups/encrypted");
  const state = JSON.parse(
    await readFile(join(dir, "backup-status.json"), "utf8"),
  );
  const age = Date.now() - Date.parse(state.verifiedAt);
  if (
    state.ok !== true ||
    !Number.isFinite(age) ||
    age < -60000 ||
    age > (interval + 600) * 1000 ||
    !/^ryadom-\d{13}-[a-f0-9]{16}\.sqlite\.enc$/.test(state.archive)
  )
    throw new Error("Backup failed or is overdue");
  const file = await stat(join(dir, state.archive));
  if (!file.isFile() || file.size < 36)
    throw new Error("Latest archive is missing");
  console.log("Backup is current");
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
