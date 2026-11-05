import { DatabaseSync } from "node:sqlite";
import {
  existsSync,
  mkdirSync,
  copyFileSync,
  chmodSync,
  readFileSync,
  constants,
  rmSync,
  linkSync,
} from "node:fs";
import { resolve, join } from "node:path";
import { createHash, randomBytes } from "node:crypto";
import { hardenRestoredDatabase } from "../lib/recovery.js";
process.umask(0o077);
let scratch, db;
try {
  if (!process.argv[2] || !process.argv.includes("--confirm-stopped"))
    throw new Error(
      "Укажите файл копии и --confirm-stopped. Остановите приложение; восстановление разрешено только в пустой каталог данных.",
    );
  const source = resolve(process.argv[2]),
    dir = resolve(process.env.DATA_DIR || "./data"),
    target = join(dir, "ryadom.sqlite");
  if (
    [target, target + "-wal", target + "-shm", target + "-journal"].some(
      existsSync,
    )
  )
    throw new Error(
      "Целевая база или WAL уже существует. Ничего не перезаписано. Выберите пустой DATA_DIR.",
    );
  if (!existsSync(source + ".sha256"))
    throw new Error("Нет контрольной суммы .sha256 рядом с копией.");
  const expected = readFileSync(source + ".sha256", "utf8").split(/\s+/)[0];
  const sourceDigest = createHash("sha256")
    .update(readFileSync(source))
    .digest("hex");
  if (!/^[a-f0-9]{64}$/.test(expected) || expected !== sourceDigest)
    throw new Error("Контрольная сумма не совпадает.");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  scratch = join(
    dir,
    ".restore-" + randomBytes(12).toString("hex") + ".sqlite",
  );
  copyFileSync(source, scratch, constants.COPYFILE_EXCL);
  chmodSync(scratch, 0o600);
  if (
    createHash("sha256").update(readFileSync(scratch)).digest("hex") !==
    sourceDigest
  )
    throw new Error(
      "Файл копии изменился во время восстановления. Публикация отменена.",
    );
  db = new DatabaseSync(scratch);
  db.exec("PRAGMA journal_mode=DELETE; PRAGMA foreign_keys=ON;");
  if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
    throw new Error("Нарушена целостность базы.");
  for (const table of ["families", "members", "sessions", "agreements"])
    if (
      !db
        .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name=?")
        .get(table)
    )
      throw new Error("В копии нет обязательных таблиц Рядом.");
  hardenRestoredDatabase(db);
  if (db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok")
    throw new Error("Нарушена целостность восстановленной базы.");
  if (db.prepare("PRAGMA foreign_key_check").all().length)
    throw new Error("Нарушены связи восстановленной базы.");
  db.close();
  db = null;
  const restoredDigest = createHash("sha256")
    .update(readFileSync(scratch))
    .digest("hex");
  if ([target + "-wal", target + "-shm", target + "-journal"].some(existsSync))
    throw new Error(
      "В каталоге появился работающий экземпляр БД. Публикация отменена.",
    );
  // Atomic exclusive publication: never overwrite a file created after the check.
  // Both paths are in the same directory/filesystem. No original credentials are published.
  linkSync(scratch, target);
  rmSync(scratch);
  scratch = null;
  console.log(
    JSON.stringify({
      ok: true,
      file: target,
      sourceSha256: sourceDigest,
      sha256: restoredDigest,
      accessReset: true,
      reviewRequired: true,
      note: "Ключи, коды и приглашения аннулированы. API закрыт до проверки оператором и явного release-restore.",
    }),
  );
} catch (error) {
  try {
    db?.close();
  } catch {}
  if (scratch)
    for (const suffix of ["", "-wal", "-shm", "-journal"])
      rmSync(scratch + suffix, { force: true });
  console.error("Восстановление не выполнено: " + error.message);
  process.exitCode = 1;
}
