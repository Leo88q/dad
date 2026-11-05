import {
  loadBackupKey,
  decryptBackup,
  digestFile,
} from "../lib/encrypted-backup.js";
import { writeFile, rm } from "node:fs/promises";
import { resolve } from "node:path";
process.umask(0o077);
let key,
  published = false,
  target;
try {
  if (process.argv.length !== 4)
    throw new Error(
      "Usage: node scripts/decrypt-backup.js encrypted-file new-output.sqlite",
    );
  const source = resolve(process.argv[2]);
  target = resolve(process.argv[3]);
  key = await loadBackupKey(process.env.BACKUP_KEY_FILE);
  await decryptBackup(source, target, key);
  published = true;
  await writeFile(target + ".sha256", `${await digestFile(target)}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  console.log(
    JSON.stringify({
      ok: true,
      file: target,
      next: "Use scripts/restore.js with a separate empty DATA_DIR and --confirm-stopped; never serve this un-hardened decrypted file directly.",
    }),
  );
} catch (err) {
  if (published) await rm(target, { force: true });
  console.error("Decryption failed:", err.message);
  process.exitCode = 1;
} finally {
  key?.fill(0);
}
