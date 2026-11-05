import { DatabaseSync, backup } from "node:sqlite";
import {
  existsSync,
  mkdirSync,
  chmodSync,
  writeFileSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";

process.umask(0o077);

const source = resolve(process.env.DATA_DIR || "./data", "ryadom.sqlite");
const dir = resolve(process.argv[2] || "./backups");
let db, target;
try {
  if (!existsSync(source))
    throw new Error(
      "База не найдена. Запустите приложение или проверьте DATA_DIR.",
    );
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  const name = `ryadom-${new Date().toISOString().replace(/[:.]/g, "-")}-${randomBytes(3).toString("hex")}.sqlite`;
  target = join(dir, name);
  db = new DatabaseSync(source, { readOnly: true });
  await backup(db, target); // Consistent SQLite online snapshot, including committed WAL changes.
  db.close();
  db = null;
  chmodSync(target, 0o600);
  const check = new DatabaseSync(target, { readOnly: true });
  try {
    if (check.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
      throw new Error("Проверка целостности не пройдена.");
  } finally {
    check.close();
  }
  const digest = createHash("sha256")
    .update(readFileSync(target))
    .digest("hex");
  writeFileSync(target + ".sha256", `${digest}  ${name}\n`, {
    mode: 0o600,
    flag: "wx",
  });
  console.log(JSON.stringify({ ok: true, file: target, sha256: digest }));
} catch (err) {
  db?.close();
  if (target) {
    rmSync(target, { force: true });
    rmSync(target + ".sha256", { force: true });
  }
  console.error(`Резервная копия не создана: ${err.message}`);
  process.exitCode = 1;
}
