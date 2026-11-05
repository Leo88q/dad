import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { selectLessons } from "../public/catalog.js";
const items = [
  {
    id: "one",
    title: "Семейный звонок",
    description: "Тёплый разговор",
    category: "Семья",
    story: "скрытый-текст",
  },
  {
    id: "two",
    title: "Просьба из банка",
    description: "Без спешки",
    category: "Безопасность",
  },
];
test("catalog search: Russian case, е/ё, whitespace and all words; no search in answers/story", () => {
  assert.deepEqual(
    selectLessons(items, { query: "  ТЕПЛЫЙ   ЗВОНОК " }).map((x) => x.id),
    ["one"],
  );
  assert.equal(selectLessons(items, { query: "звонок банка" }).length, 0);
  assert.equal(selectLessons(items, { query: "скрытый-текст" }).length, 0);
  assert.equal(selectLessons(items, { query: "<script>" }).length, 0);
});
test("catalog filters combine personal saved, completion, category and search without changing source", () => {
  assert.deepEqual(
    selectLessons(items, {
      view: "saved",
      saved: ["one"],
      category: "Семья",
      query: "разговор",
    }).map((x) => x.id),
    ["one"],
  );
  assert.equal(
    selectLessons(items, {
      view: "saved",
      saved: ["one"],
      category: "Безопасность",
    }).length,
    0,
  );
  assert.deepEqual(
    selectLessons(items, { view: "new", completed: ["one"] }).map((x) => x.id),
    ["two"],
  );
  assert.equal(selectLessons(items, { view: "saved" }).length, 0);
  assert.equal(items.length, 2);
});
const dir = mkdtempSync(join(tmpdir(), "ryadom-catalog-"));
let server;
const base = "http://127.0.0.1:3227/api";
async function req(path, token, body, method) {
  const r = await fetch(base + path, {
    method: method || (body ? "POST" : "GET"),
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, data: await r.json() };
}
before(async () => {
  server = spawn(process.execPath, ["server.js"], {
    env: {
      ...process.env,
      PORT: "3227",
      DATA_DIR: dir,
      MAX_BOT_TOKEN: "",
      MAX_ONLY: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("catalog startup timeout")),
      10000,
    );
    server.stdout.once("data", () => {
      clearTimeout(t);
      resolve();
    });
    server.once("error", reject);
  });
});
after(async () => {
  if (server?.exitCode === null)
    await new Promise((resolve) => {
      server.once("exit", resolve);
      server.kill();
    });
  rmSync(dir, { recursive: true, force: true });
});
test("saved lessons API: private, idempotent, exportable, survives recovery and cascades on deletion", async () => {
  const a = (await req("/register", null, { name: "Первый", consent: true }))
    .data;
  const initial = (await req("/state", a.token)).data;
  assert.deepEqual(initial.savedLessons, []);
  const b = (
    await req("/join", null, {
      name: "Второй",
      consent: true,
      invite: initial.invite,
    })
  ).data;
  assert.equal(
    (await req("/lessons/bank/saved", a.token, { saved: true })).status,
    200,
  );
  await req("/lessons/bank/saved", a.token, { saved: true });
  assert.deepEqual((await req("/state", a.token)).data.savedLessons, ["bank"]);
  assert.deepEqual((await req("/state", b.token)).data.savedLessons, []);
  await req("/lessons/new-number/saved", b.token, {
    saved: true,
    member: initial.me,
  });
  assert.deepEqual((await req("/export", a.token)).data.savedLessons, ["bank"]);
  assert.deepEqual((await req("/export", b.token)).data.savedLessons, [
    "new-number",
  ]);
  const recovered = (await req("/recover", null, { code: a.recoveryCode }))
    .data;
  assert.deepEqual((await req("/state", recovered.token)).data.savedLessons, [
    "bank",
  ]);
  assert.equal(
    (await req("/lessons/bank/saved", a.token, { saved: false })).status,
    401,
  );
  await req("/lessons/bank/saved", recovered.token, { saved: false });
  await req("/lessons/bank/saved", recovered.token, { saved: false });
  assert.deepEqual(
    (await req("/state", recovered.token)).data.savedLessons,
    [],
  );
  await req("/lessons/bank/saved", recovered.token, { saved: true });
  await req("/account", recovered.token, null, "DELETE");
  const db = new DatabaseSync(join(dir, "ryadom.sqlite"), { readOnly: true });
  assert.equal(
    db
      .prepare("SELECT count(*) n FROM saved_lessons WHERE member=?")
      .get(initial.me).n,
    0,
  );
  assert.equal(db.prepare("SELECT count(*) n FROM saved_lessons").get().n, 1);
  db.close();
  assert.deepEqual((await req("/state", b.token)).data.savedLessons, [
    "new-number",
  ]);
});
test("saved lessons API rejects anonymous, unknown lessons and non-boolean intent", async () => {
  assert.equal(
    (await req("/lessons/bank/saved", null, { saved: true })).status,
    401,
  );
  const a = (await req("/register", null, { name: "Проверка", consent: true }))
    .data;
  assert.equal(
    (await req("/lessons/not-a-lesson/saved", a.token, { saved: true })).status,
    404,
  );
  for (const saved of [null, "true", 1, [], {}])
    assert.equal(
      (await req("/lessons/bank/saved", a.token, { saved })).status,
      400,
    );
  assert.deepEqual((await req("/state", a.token)).data.savedLessons, []);
});
