import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
process.umask(0o077);
try {
  if (process.argv.length !== 3)
    throw new Error("Usage: node scripts/backup-key.js /private/path/key");
  writeFileSync(process.argv[2], randomBytes(32).toString("hex") + "\n", {
    mode: 0o600,
    flag: "wx",
  });
  console.log(
    "Key created. Store an independent offline copy; the key is never printed.",
  );
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
}
