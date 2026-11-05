import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { JSDOM, VirtualConsole } from "jsdom";
import { spawn } from "node:child_process";
import { readFileSync, mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { lessons } from "../public/content.js";
import { collections } from "../public/scenarios.js";
import { selectLessons } from "../public/catalog.js";

const dir = mkdtempSync(join(tmpdir(), "ryadom-ui-")),
  port = 3219,
  base = `http://127.0.0.1:${port}`;
let server;
const windows = [];
before(async () => {
  server = spawn(process.execPath, ["server.js"], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Error("Server timeout")), 10000);
    server.stdout.once("data", () => {
      clearTimeout(t);
      resolve();
    });
    server.once("error", reject);
  });
});
after(() => {
  for (const w of windows) w.close();
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});
async function waitFor(fn, label = "UI update") {
  const end = Date.now() + 4000;
  while (Date.now() < end) {
    if (fn()) return;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error(`Timeout: ${label}`);
}
async function browser({
  token,
  storage = {},
  runtimeFailsOnce = false,
  release = null,
} = {}) {
  const errors = [];
  const vc = new VirtualConsole();
  vc.on("jsdomError", (e) => errors.push(e));
  const dom = new JSDOM(readFileSync("public/index.html", "utf8"), {
    url: base,
    runScripts: "outside-only",
    virtualConsole: vc,
    pretendToBeVisual: true,
  });
  const w = dom.window;
  windows.push(w);
  w.fetch = async (url, opts) => {
    if (url === "/api/runtime-config" && runtimeFailsOnce) {
      runtimeFailsOnce = false;
      return Promise.resolve({ ok: false });
    }
    const response = await fetch(new URL(url, base), opts);
    if (release && url === "/api/runtime-config" && response.ok) {
      const data = await response.json();
      return { ok: true, json: async () => ({ ...data, release }) };
    }
    return response;
  };
  w.scrollTo = () => {};
  w.confirm = () => false;
  w.setInterval = () => 0;
  w.__lessons = lessons;
  w.__collections = collections;
  w.__selectLessons = selectLessons;
  if (token) w.localStorage.setItem("ryadom-token", token);
  for (const [key, value] of Object.entries(storage))
    w.sessionStorage.setItem(key, value);
  w.eval(
    readFileSync("public/max.js", "utf8").replace(
      "export const maxPlatform =",
      "window.__maxPlatform =",
    ),
  );
  const source = readFileSync("public/app.js", "utf8")
    .replace(
      /import\s*\{\s*collections\s*\}\s*from\s*['"]\.\/scenarios\.js['"];?/,
      "const collections=window.__collections;",
    )
    .replace(
      /import\s*\{\s*selectLessons\s*\}\s*from\s*['"]\.\/catalog\.js['"];?/,
      "const selectLessons=window.__selectLessons;",
    )
    .replace(
      /import\s*\{\s*maxPlatform\s*\}\s*from\s*['"]\.\/max\.js['"];?/,
      "const maxPlatform=window.__maxPlatform;",
    )
    .replace(
      /import\s*\{\s*lessons\s*\}\s*from\s*['"]\.\/content\.js['"];?/,
      "const lessons=window.__lessons;",
    );
  // Exercise the actual application and DOM events without a bundler. No app logic is mocked.
  await w.eval(`(async()=>{${source}\n})()`);
  return {
    w,
    errors,
    q: (s) => w.document.querySelector(s),
    click(s) {
      const el = w.document.querySelector(s);
      assert.ok(el, `element ${s}`);
      el.click();
    },
  };
}
function submit(w, id) {
  w.document
    .querySelector(id)
    .dispatchEvent(new w.Event("submit", { bubbles: true, cancelable: true }));
}

test("interface: registration, recovery backup, complete lesson, print view, logout and restore", async () => {
  const { w, q, click, errors } = await browser();
  assert.match(q("h1").textContent, /Хорошо, что вы рядом/);
  click('[data-lesson="new-number"]');
  q("#reg-name").value = "<Мама>";
  q("[name=consent]").checked = true;
  submit(w, "#register-form");
  await waitFor(() => q("#recovery-secret"), "recovery code after signup");
  const code = q("#recovery-secret").value;
  assert.equal(q('[data-action="code-done"]').disabled, true);
  q("#code-saved").checked = true;
  q("#code-saved").dispatchEvent(new w.Event("change", { bubbles: true }));
  click('[data-action="code-done"]');
  assert.ok(q('[data-mode="together"]'));
  click('[data-mode="together"]');
  await waitFor(() => q('[data-action="to-answer"]'), "story");
  click('[data-action="to-answer"]');
  click('[data-choice="0"]');
  click('[data-action="answer"]');
  await waitFor(
    () => q(".eyebrow")?.textContent === "Теперь второй участник",
    "second participant",
  );
  assert.equal(q('[data-action="answer"]').disabled, true);
  click('[data-choice="1"]');
  click('[data-action="answer"]');
  await waitFor(() => q('[data-action="to-agreement"]'), "review");
  assert.match(q(".lesson-panel").textContent, /позвонить человеку/i);
  click('[data-action="to-agreement"]');
  q("#agreement").value = "Сначала звоним друг другу.";
  submit(w, "#agreement-form");
  await waitFor(() => q(".success-art"), "lesson completion");
  click('[data-nav="agreements"]');
  assert.match(q(".agreement").textContent, /Сначала звоним друг другу/);
  assert.ok(q('[data-action="print"]'));
  click('[data-nav="settings"]');
  assert.equal(q("#name").value, "<Мама>");
  assert.equal(q("Мама"), null); // Name remains escaped HTML.
  click('[data-action="logout"]');
  click('[data-action="confirm-logout"]');
  await waitFor(
    () => w.localStorage.getItem("ryadom-token") === null,
    "server logout",
  );
  assert.equal(w.localStorage.getItem("ryadom-token"), null);
  click('[data-action="restore"]');
  q("#recovery-input").value = code;
  submit(w, "#restore-form");
  await waitFor(() => q("#recovery-secret"), "replacement code");
  assert.notEqual(q("#recovery-secret").value, code);
  q("#code-saved").checked = true;
  q("#code-saved").dispatchEvent(new w.Event("change", { bubbles: true }));
  click('[data-action="code-done"]');
  click('[data-nav="agreements"]');
  assert.match(q(".agreement").textContent, /Сначала звоним друг другу/);
  assert.deepEqual(errors, []);
});

test("interface: restoring with an invalid code shows a readable error and keeps form usable", async () => {
  const { w, q, click, errors } = await browser();
  click('[data-action="restore"]');
  q("#recovery-input").value = "wrong";
  submit(w, "#restore-form");
  await waitFor(() => q(".error")?.textContent.includes("Код не найден"));
  assert.equal(q("#restore-form .btn").disabled, false);
  click('[data-action="close"]');
  click('[data-action="font"]');
  assert.equal(w.document.documentElement.classList.contains("large"), true);
  assert.deepEqual(errors, []);
});

async function uiRequest(path, token, body) {
  const r = await fetch(base + "/api" + path, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  assert.equal(r.status, 200, `API ${path}`);
  return r.json();
}
function refreshBrowser(b) {
  b.w.document.dispatchEvent(new b.w.Event("visibilitychange"));
}

test("interface: two devices negotiate, changed text resets consent, both see saved agreement", async () => {
  const a = (
    await uiRequest("/register", null, { name: "Анна", consent: true })
  ).token;
  const initial = await uiRequest("/state", a);
  const b = (
    await uiRequest("/join", null, {
      name: "Ирина",
      consent: true,
      invite: initial.invite,
    })
  ).token;
  const sid = (await uiRequest("/start", a, { lesson: "bank", mode: "remote" }))
    .id;
  await uiRequest(`/session/${sid}/answer`, a, { choice: 0 });
  await uiRequest(`/session/${sid}/answer`, b, { choice: 1 });
  const first = await browser({ token: a }),
    second = await browser({ token: b });
  first.click("[data-resume]");
  first.click('[data-action="to-agreement"]');
  first.q("#agreement").value = "Сначала проверяем, потом действуем.";
  first
    .q("#agreement")
    .dispatchEvent(new first.w.Event("input", { bubbles: true }));
  submit(first.w, "#agreement-form");
  await waitFor(() => first.q(".approval-list"), "first proposal");
  assert.match(first.q(".notice[role=status]").textContent, /Ждём/);
  refreshBrowser(second);
  await waitFor(() => second.q("[data-resume]"));
  // Opening after refresh uses the server proposal, not an outdated local form.
  await waitFor(async () => true);
  second.click("[data-resume]");
  if (second.q('[data-action="to-agreement"]'))
    second.click('[data-action="to-agreement"]');
  await waitFor(() => second.q(".approval-list"), "second sees proposal");
  second.click('[data-action="edit-proposal"]');
  second.q("#agreement").value = "Сначала созваниваемся по знакомому номеру.";
  second
    .q("#agreement")
    .dispatchEvent(new second.w.Event("input", { bubbles: true }));
  submit(second.w, "#agreement-form");
  await waitFor(() => second.q(".approval-list"), "revised proposal");
  refreshBrowser(first);
  await waitFor(
    () => first.q(".discussion p")?.textContent.includes("созваниваемся"),
    "first sees revision",
  );
  assert.ok(first.q('[data-action="approve-proposal"]'));
  assert.equal(
    first.q('[data-action="approve-proposal"]').dataset.revision,
    "2",
  );
  first.click('[data-action="approve-proposal"]');
  await waitFor(() => first.q(".success-art"), "first completion");
  refreshBrowser(second);
  await waitFor(() => second.q(".success-art"), "second completion");
  for (const person of [first, second]) {
    person.click('[data-nav="agreements"]');
    assert.match(person.q(".agreement").textContent, /Сначала созваниваемся/);
    assert.deepEqual(person.errors, []);
  }
});

test("interface: agreement draft survives navigation and reload of the same tab, and clears on logout", async () => {
  const token = (
    await uiRequest("/register", null, { name: "Черновик", consent: true })
  ).token;
  const sid = (
    await uiRequest("/start", token, { lesson: "bank", mode: "together" })
  ).id;
  await uiRequest(`/session/${sid}/answer`, token, {
    choice: 0,
    person: "first",
  });
  await uiRequest(`/session/${sid}/answer`, token, {
    choice: 1,
    person: "second",
  });
  const original = await browser({ token });
  original.click("[data-resume]");
  original.click('[data-action="to-agreement"]');
  original.q("#agreement").value = "Мой незаконченный текст";
  original
    .q("#agreement")
    .dispatchEvent(new original.w.Event("input", { bubbles: true }));
  const storage = Object.fromEntries(
    Object.keys(original.w.sessionStorage).map((key) => [
      key,
      original.w.sessionStorage.getItem(key),
    ]),
  );
  original.click('[data-nav="home"]');
  original.click("[data-resume]");
  original.click('[data-action="to-agreement"]');
  assert.equal(original.q("#agreement").value, "Мой незаконченный текст");
  const restored = await browser({ token, storage });
  restored.click("[data-resume]");
  restored.click('[data-action="to-agreement"]');
  assert.equal(restored.q("#agreement").value, "Мой незаконченный текст");
  restored.click('[data-nav="settings"]');
  restored.click('[data-action="logout"]');
  restored.click('[data-action="confirm-logout"]');
  await waitFor(
    () => restored.w.localStorage.getItem("ryadom-token") === null,
    "server logout",
  );
  assert.equal(restored.w.sessionStorage.length, 0);
  assert.deepEqual(restored.errors, []);
});

test("interface: a stale draft cannot overwrite a newer proposal or approve unseen text", async () => {
  const a = (
    await uiRequest("/register", null, { name: "Первый", consent: true })
  ).token;
  const invite = (await uiRequest("/state", a)).invite;
  const b = (
    await uiRequest("/join", null, { name: "Второй", consent: true, invite })
  ).token;
  const sid = (await uiRequest("/start", a, { lesson: "bank", mode: "remote" }))
    .id;
  await uiRequest(`/session/${sid}/answer`, a, { choice: 0 });
  await uiRequest(`/session/${sid}/answer`, b, { choice: 1 });
  await uiRequest(`/session/${sid}/propose`, a, {
    text: "Начальное предложение",
    revision: 0,
  });
  const editor = await browser({ token: b });
  editor.click("[data-resume]");
  editor.click('[data-action="edit-proposal"]');
  editor.q("#agreement").value = "Мой текст на основе старой версии";
  editor
    .q("#agreement")
    .dispatchEvent(new editor.w.Event("input", { bubbles: true }));
  await uiRequest(`/session/${sid}/propose`, a, {
    text: "Обновлённое предложение близкого",
    revision: 1,
  });
  submit(editor.w, "#agreement-form");
  await waitFor(
    () => editor.q('[data-action="reload-proposal"]'),
    "stale draft warning",
  );
  assert.equal(
    editor.q("#agreement").value,
    "Мой текст на основе старой версии",
  );
  assert.equal(editor.q("#agreement-form .btn.primary").disabled, true);
  const beforeApproval = await uiRequest("/state", b);
  assert.equal(beforeApproval.agreements.length, 0);
  assert.equal(
    beforeApproval.sessions[0].proposal.text,
    "Обновлённое предложение близкого",
  );
  assert.equal(
    beforeApproval.sessions[0].proposal.approvals.includes(beforeApproval.me),
    false,
  );
  editor.click('[data-action="reload-proposal"]');
  assert.match(
    editor.q(".discussion p").textContent,
    /Обновлённое предложение близкого/,
  );
  assert.equal(
    editor.q('[data-action="approve-proposal"]').dataset.revision,
    "2",
  );
  editor.click('[data-action="approve-proposal"]');
  await waitFor(() => editor.q(".success-art"), "confirmed current version");
  assert.deepEqual(editor.errors, []);
});

test("interface: a failed startup configuration recovers through retry without losing saved access", async () => {
  const account = await uiRequest("/register", null, {
    name: "После восстановления",
    consent: true,
  });
  const b = await browser({ token: account.token, runtimeFailsOnce: true });
  assert.ok(b.q(".entry-gate"));
  assert.equal(b.q(".profile"), null);
  b.click("button[data-action=max-retry]");
  await waitFor(
    () => b.q(".profile")?.textContent.includes("После восстановления"),
    "recover browser startup",
  );
  assert.equal(b.q(".entry-gate"), null);
  assert.deepEqual(b.errors, []);
});

test("interface: private saved stories, combined catalog search, empty state, reset and reload", async () => {
  const account = await uiRequest("/register", null, {
    name: "Читатель",
    consent: true,
  });
  const b = await browser({ token: account.token });
  b.click("[data-nav=lessons]");
  assert.equal(
    b.w.document.querySelectorAll(".lesson-card").length,
    lessons.length,
  );
  b.click("[data-save-lesson=bank]");
  await waitFor(
    () =>
      b.q("[data-save-lesson=bank]")?.getAttribute("aria-pressed") === "true",
    "save story",
  );
  b.click("[data-catalog-view=saved]");
  assert.equal(b.w.document.querySelectorAll(".lesson-card").length, 1);
  b.q("#catalog-query").value = "неизвестная история";
  submit(b.w, "#catalog-search");
  await waitFor(() => b.q(".empty"), "empty search");
  b.click("[data-action=catalog-reset]");
  assert.equal(
    b.w.document.querySelectorAll(".lesson-card").length,
    lessons.length,
  );
  const reloaded = await browser({ token: account.token });
  reloaded.click("[data-action=open-saved]");
  assert.equal(reloaded.w.document.querySelectorAll(".lesson-card").length, 1);
  reloaded.click("[data-save-lesson=bank]");
  await waitFor(() => reloaded.q(".empty"), "remove saved");
  assert.deepEqual(b.errors, []);
  assert.deepEqual(reloaded.errors, []);
});

test("interface: configured operator, support and policy links appear in settings and privacy without pilot placeholders", async () => {
  const account = await uiRequest("/register", null, {
    name: "Пользователь",
    consent: true,
  });
  const release = {
    operatorName: "ООО «Рядом» <проверка>",
    supportEmail: "support@ryadom-release-check.ru",
    privacyURL: "https://ryadom-release-check.ru/privacy",
    termsURL: "https://ryadom-release-check.ru/terms",
    policyVersion: "2026-11-04",
  };
  const b = await browser({ token: account.token, release });
  const opened = [];
  b.w.open = (url) => opened.push(url);
  b.click("[data-nav=settings]");
  assert.ok(b.q(".service-info").textContent.includes(release.operatorName));
  assert.equal(b.q(".service-info").querySelector("проверка"), null);
  b.click("[data-action=privacy]");
  assert.ok(
    !b
      .q("#modal-root")
      .textContent.includes(
        "Оператор и документы публичного сервиса ещё не настроены",
      ),
  );
  b.click("#modal-root [data-action=legal-open]");
  await waitFor(() => opened.length === 1, "open policy");
  assert.equal(opened[0], release.privacyURL);
  assert.deepEqual(b.errors, []);
});

test("interface: home collections, short-time filtering and reset expose the complete library", async () => {
  const b = await browser();
  assert.equal(b.w.document.querySelectorAll(".collection-card").length, 6);
  b.click("[data-collection-id=support]");
  assert.equal(b.w.document.querySelectorAll(".lesson-card").length, 4);
  const duration = b.q("#catalog-minutes");
  duration.value = "5";
  duration.dispatchEvent(new b.w.Event("change", { bubbles: true }));
  assert.equal(b.w.document.querySelectorAll(".lesson-card").length, 1);
  assert.ok(b.q("[data-lesson=next-meeting]"));
  b.q("#catalog-query").value = "несуществующее";
  submit(b.w, "#catalog-search");
  await waitFor(() => b.q(".empty"), "empty collection search");
  b.click("[data-action=catalog-reset]");
  assert.equal(b.w.document.querySelectorAll(".lesson-card").length, 36);
  assert.equal(b.q("#catalog-collection").value, "all");
  assert.equal(b.q("#catalog-minutes").value, "0");
  assert.deepEqual(b.errors, []);
});
