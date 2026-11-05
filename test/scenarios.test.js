import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { lessons } from "../public/content.js";
import { collections } from "../public/scenarios.js";
import { selectLessons } from "../public/catalog.js";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

test("scenario library balances 36 distinct stories with complete guides, optional prompts and incident support", () => {
  assert.deepEqual(
    Object.fromEntries(
      ["safety", "conversation", "practice"].map((kind) => [
        kind,
        lessons.filter((l) => l.kind === kind).length,
      ]),
    ),
    { safety: 14, conversation: 11, practice: 11 },
  );
  for (const field of [
    "title",
    "story",
    "question",
    "explanation",
    "discussion",
  ])
    assert.equal(
      new Set(lessons.map((l) => l[field])).size,
      36,
      field + " must be distinct",
    );
  for (const l of lessons) {
    assert.ok(l.story.length >= 100, l.id + " story");
    assert.ok(l.explanation.length >= 120, l.id + " explanation");
    if (l.kind === "practice") {
      assert.ok(l.steps.length >= 3);
      assert.ok(l.steps.every((step) => step.length > 20));
    }
    if (l.kind === "conversation") {
      assert.equal(l.agreement, "");
      assert.ok(l.extraQuestions.length >= 2);
    }
    if (l.kind === "safety")
      assert.ok(l.ifAlreadyHappened.length > 70, l.id + " incident guidance");
  }
});
test("all six collections have valid unique IDs and cover every scenario without orphan or duplicate placement", () => {
  assert.equal(collections.length, 6);
  assert.equal(new Set(collections.map((c) => c.id)).size, 6);
  const ids = collections.flatMap((c) => c.lessonIds);
  assert.equal(ids.length, 36);
  assert.equal(new Set(ids).size, 36);
  assert.deepEqual([...ids].sort(), lessons.map((l) => l.id).sort());
  for (const c of collections) {
    assert.ok(c.description.length > 20);
    assert.ok(c.lessonIds.length >= 4);
  }
});
test("collection, time, search and saved filters combine without searching private content", () => {
  const connection = collections.find((c) => c.id === "connection");
  assert.deepEqual(
    selectLessons(lessons, {
      collectionIds: connection.lessonIds,
      maxMinutes: 5,
      query: "голосовое",
    }).map((l) => l.id),
    ["voice-message"],
  );
  const support = collections.find((c) => c.id === "support");
  assert.deepEqual(
    selectLessons(lessons, {
      collectionIds: support.lessonIds,
      maxMinutes: 5,
    }).map((l) => l.id),
    ["next-meeting"],
  );
  assert.equal(
    selectLessons(lessons, { collectionIds: [], maxMinutes: 5 }).length,
    0,
  );
  assert.equal(
    selectLessons(lessons, {
      view: "saved",
      saved: ["bank"],
      collectionIds: connection.lessonIds,
    }).length,
    0,
  );
  assert.ok(
    selectLessons(lessons, { maxMinutes: 5 }).every((l) => l.minutes <= 5),
  );
});
const dir = mkdtempSync(join(tmpdir(), "ryadom-scenarios-"));
let child;
before(async () => {
  child = spawn(process.execPath, ["server.js"], {
    env: {
      ...process.env,
      PORT: "3230",
      DATA_DIR: dir,
      MAX_BOT_TOKEN: "",
      MAX_ONLY: "false",
      NODE_ENV: "test",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(
      () => reject(new Error("scenario server timeout")),
      10000,
    );
    child.stdout.once("data", () => {
      clearTimeout(t);
      resolve();
    });
    child.once("error", reject);
  });
});
after(async () => {
  if (child?.exitCode === null)
    await new Promise((resolve) => {
      child.once("exit", resolve);
      child.kill();
    });
  rmSync(dir, { recursive: true, force: true });
});
async function req(path, token, body) {
  const r = await fetch("http://127.0.0.1:3230/api" + path, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  const data = await r.json();
  assert.equal(r.status, 200, path + ": " + JSON.stringify(data));
  return data;
}
test("all 36 scenarios start, accept both one-phone answers and finish with preserved history over HTTP", async () => {
  const account = await req("/register", null, {
    name: "Проверяем библиотеку",
    consent: true,
  });
  for (const l of lessons) {
    const session = await req("/start", account.token, {
      lesson: l.id,
      mode: "together",
    });
    await req(`/session/${session.id}/answer`, account.token, {
      choice: 0,
      person: "first",
    });
    await req(`/session/${session.id}/answer`, account.token, {
      choice: 2,
      person: "second",
    });
    await req(`/session/${session.id}/complete`, account.token, {});
  }
  const state = await req("/state", account.token);
  assert.equal(state.sessions.length, 36);
  assert.ok(state.sessions.every((s) => s.finished && s.revealed));
  assert.deepEqual(
    state.sessions.map((s) => s.lesson).sort(),
    lessons.map((l) => l.id).sort(),
  );
  assert.equal(state.agreements.length, 0);
});

test("editorial depth covers every unchanged option with specific notes and bounded safety checks", () => {
  const notes = [];
  for (const lesson of lessons) {
    assert.ok(lesson.goal.length > 40, lesson.id);
    assert.deepEqual(
      lesson.sourceOptions,
      lesson.options,
      lesson.id + " option text changed: review note alignment",
    );
    assert.equal(lesson.optionNotes.length, lesson.options.length);
    for (const note of lesson.optionNotes) {
      assert.ok(note.length > 100, lesson.id);
      notes.push(note);
    }
    if (lesson.kind === "safety") {
      assert.equal(lesson.verify.length, 2);
      for (const pair of lesson.verify) {
        assert.equal(pair.length, 2);
        assert.ok(pair.every((text) => text.length > 15));
      }
      assert.ok(lesson.variation.question.length > 20);
      assert.ok(lesson.variation.note.length > 70);
      assert.ok(lesson.limit.length > 40);
    }
    if (lesson.kind === "practice")
      assert.ok(lesson.selfCheck.length > 65, lesson.id);
    if (lesson.kind === "conversation") assert.equal(lesson.agreement, "");
  }
  assert.equal(notes.length, 108);
  assert.equal(new Set(notes).size, 108);
});
