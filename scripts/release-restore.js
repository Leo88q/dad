import { DatabaseSync } from "node:sqlite";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { releaseRestoredDatabase } from "../lib/recovery.js";
let db;
try {
  if (
    !process.argv.includes("--confirm-stopped") ||
    !process.argv.includes("--confirm-reviewed")
  )
    throw new Error(
      "Нужны --confirm-stopped и --confirm-reviewed. Проверьте удаления и отозванные права после даты архива. Не выпускайте непроверенную копию.",
    );
  const file = resolve(process.env.DATA_DIR || "./data", "ryadom.sqlite");
  if (!existsSync(file)) throw new Error("Восстановленная база не найдена.");
  db = new DatabaseSync(file);
  const { authNotBefore } = releaseRestoredDatabase(db);
  db.close();
  db = null;
  console.log(
    JSON.stringify({
      ok: true,
      opensAt: new Date(authNotBefore).toISOString(),
      note: "После указанного времени заново откройте MAX. Старые ключи, коды и приглашения не восстановлены.",
    }),
  );
} catch (error) {
  try {
    db?.close();
  } catch {}
  console.error("Выпуск восстановления отменён: " + error.message);
  process.exitCode = 1;
}
