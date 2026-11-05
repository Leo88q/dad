import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";
import { readFileSync } from "node:fs";
import { lessons } from "../public/content.js";
const base = "http://127.0.0.1:3221";
async function api(request, path, token, body) {
  const response = await request[body ? "post" : "get"](base + "/api" + path, {
    headers: token ? { Authorization: "Bearer " + token } : {},
    ...(body ? { data: body } : {}),
  });
  expect(response.ok(), `${path}: ${await response.text()}`).toBeTruthy();
  return response.json();
}
async function signedPage(browser, token, viewport) {
  const context = await browser.newContext({ viewport });
  await context.addInitScript((token) => {
    if (location.protocol === "http:")
      localStorage.setItem("ryadom-token", token);
  }, token);
  const page = await context.newPage();
  await page.goto(base);
  return { context, page };
}
async function saveCode(page) {
  await expect(page.locator("#recovery-secret")).toBeVisible();
  const code = await page.locator("#recovery-secret").inputValue();
  await page.locator("#code-saved").check();
  await page.locator("[data-action=code-done]").click();
  return code;
}
async function answer(page, index) {
  await page.locator("[data-action=to-answer]").click();
  await page.locator(`[data-choice="${index}"]`).click();
  await page.locator("[data-action=answer]").click();
}
async function revealed(request, token, lesson, mode = "together") {
  const s = await api(request, "/start", token, { lesson, mode });
  await api(request, `/session/${s.id}/answer`, token, {
    choice: 0,
    person: "first",
  });
  await api(request, `/session/${s.id}/answer`, token, {
    choice: 1,
    person: "second",
  });
  return s.id;
}

test("registration, one-phone lesson, recovery and real download", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await page.goto("/");
  await page.locator(".hero [data-lesson]").click();
  await page.locator("#reg-name").fill("Анна");
  await page.locator("[name=consent]").check();
  await page.locator("#register-form .btn.primary").click();
  const code = await saveCode(page);
  await page.locator("[data-mode=together]").click();
  await answer(page, 0);
  await expect(page.locator(".eyebrow")).toContainText(
    "Теперь второй участник",
  );
  await page.locator('[data-choice="1"]').click();
  await page.locator("[data-action=answer]").click();
  await page.locator("[data-action=to-agreement]").click();
  await page
    .locator("#agreement")
    .fill("Перед переводом звоним по знакомому номеру.");
  await page.locator("#agreement-form .btn.primary").click();
  await expect(page.locator(".success-art")).toBeVisible();
  await page.locator(".profile").click();
  const downloadPromise = page.waitForEvent("download");
  await page.locator("[data-action=export]").click();
  const download = await downloadPromise;
  expect(download.suggestedFilename()).toContain(".json");
  const exported = JSON.parse(readFileSync(await download.path(), "utf8"));
  expect(exported.profile.name).toBe("Анна");
  expect(exported.sharedAgreements).toHaveLength(1);
  expect(JSON.stringify(exported)).not.toContain(code);
  await page.locator("[data-action=logout]").click();
  await page.locator("[data-action=confirm-logout]").click();
  await page.locator("[data-action=restore]").click();
  await page.locator("#recovery-input").fill(code);
  await page.locator("#restore-form .btn.primary").click();
  const newCode = await saveCode(page);
  expect(newCode).not.toBe(code);
  await page.locator("[data-nav=agreements]").first().click();
  await expect(page.locator(".agreement")).toContainText(
    "Перед переводом звоним",
  );
  await page.emulateMedia({ media: "print" });
  await expect(page.locator(".sidebar")).toBeHidden();
  expect(errors).toEqual([]);
});

test("two independent browsers join by invitation and agree on the same text", async ({
  browser,
  request,
}, testInfo) => {
  const a = await api(request, "/register", null, {
    name: "Первый",
    consent: true,
  });
  const state = await api(request, "/state", a.token);
  const { context: ca, page: pa } = await signedPage(
    browser,
    a.token,
    testInfo.project.use.viewport,
  );
  const cb = await browser.newContext({
    viewport: testInfo.project.use.viewport,
  });
  const pb = await cb.newPage();
  try {
    await pb.goto(base + "/?invite=" + state.invite);
    await pb.locator("#reg-name").fill("Второй");
    await pb.locator("[name=consent]").check();
    await pb.locator("#register-form .btn.primary").click();
    await saveCode(pb);
    await pa.locator(".hero [data-lesson]").click();
    await pa.locator("[data-mode=remote]").click();
    await expect(pa.locator(".lesson-goal")).toBeVisible();
    await expect(pa.locator(".answer-note")).toHaveCount(0);
    await answer(pa, 0);
    await expect(pa.locator(".answer-note")).toHaveCount(0);
    await expect(pa.locator(".decision-checks")).toHaveCount(0);
    await expect(pa.locator(".lesson-panel h2")).toHaveText(
      "Ваш ответ сохранён",
    );
    await pb.locator("[data-resume]").click();
    await answer(pb, 1);
    await expect(pa.locator("[data-action=to-agreement]")).toBeVisible();
    await expect(pa.locator(".answer-note")).toHaveCount(2);
    await expect(pb.locator(".answer-note")).toHaveCount(2);
    await pa.locator("[data-action=to-agreement]").click();
    await pa.locator("#agreement").fill("Проверяем просьбу обратным звонком.");
    await pa.locator("#agreement-form .btn.primary").click();
    await expect(pa.locator(".approval-list")).toBeVisible();
    await pb.locator("[data-action=to-agreement]").click();
    await expect(pb.locator("[data-action=approve-proposal]")).toBeVisible();
    await pb.locator("[data-action=edit-proposal]").click();
    await pb
      .locator("#agreement")
      .fill("Сначала звоним по сохранённому номеру.");
    await pb.locator("#agreement-form .btn.primary").click();
    await expect(pa.locator(".discussion p")).toHaveText(
      "Сначала звоним по сохранённому номеру.",
    );
    await pa.locator("[data-action=approve-proposal]").click();
    await expect(pa.locator(".success-art")).toBeVisible();
    await expect(pb.locator(".success-art")).toBeVisible();
  } finally {
    await ca.close().catch(() => {});
    await cb.close().catch(() => {});
  }
});

test("family conversation ends warmly without mandatory agreement", async ({
  page,
  request,
}) => {
  const a = await api(request, "/register", null, {
    name: "Разговор",
    consent: true,
  });
  await revealed(request, a.token, "family-recipe");
  await page.addInitScript(
    (t) => localStorage.setItem("ryadom-token", t),
    a.token,
  );
  await page.goto("/");
  await page.locator("[data-resume]").click();
  await expect(page.locator("[data-action=to-agreement]")).toHaveCount(0);
  await page.locator("[data-action=complete-session]").click();
  await page.locator("[data-action=confirm-complete]").click();
  await expect(page.locator(".lesson-panel h2")).toHaveText(
    "Спасибо, что рассказали",
  );
  const state = await api(request, "/state", a.token);
  expect(state.agreements).toHaveLength(0);
  expect(state.sessions[0].finished).toBeTruthy();
});

test("draft survives reload and network failure; voluntary reviews can be disabled", async ({
  page,
  request,
}) => {
  const a = await api(request, "/register", null, {
    name: "Черновик",
    consent: true,
  });
  await revealed(request, a.token, "bank");
  await page.addInitScript(
    (t) => localStorage.setItem("ryadom-token", t),
    a.token,
  );
  await page.goto("/");
  await page.locator("[data-resume]").click();
  await page.locator("[data-action=to-agreement]").click();
  await page.locator("#agreement").fill("Сохраняем спокойствие и проверяем.");
  await page.reload();
  await page.locator("[data-resume]").click();
  await page.locator("[data-action=to-agreement]").click();
  await expect(page.locator("#agreement")).toHaveValue(
    "Сохраняем спокойствие и проверяем.",
  );
  await page.route("**/api/state", (route) => route.abort());
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(page.locator(".connection")).toBeVisible();
  await expect(page.locator("#agreement")).toHaveValue(
    "Сохраняем спокойствие и проверяем.",
  );
  await page.unroute("**/api/state");
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect(page.locator(".connection")).toHaveCount(0);
  await page.locator("#agreement-form .btn.primary").click();
  await expect(page.locator(".success-art")).toBeVisible();
  await page.locator(".profile").click();
  await page.locator("[data-action=toggle-reviews]").click();
  await expect(page.locator("[data-action=toggle-reviews]")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  await page.locator("[data-nav=home]").first().click();
  await expect(page.locator(".review-panel")).toContainText("Звонок");
  await page.locator(".profile").click();
  await page.locator("[data-action=toggle-reviews]").click();
  await page.locator("[data-nav=home]").first().click();
  await expect(page.locator(".review-panel")).toHaveCount(0);
});

test("WCAG automated scan, keyboard entry and narrow layout at enlarged text", async ({
  page,
}) => {
  await page.goto("/");
  await page.keyboard.press("Tab");
  await expect(page.locator(".skip-link")).toBeFocused();
  const scan = async () => {
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(
      result.violations.map((v) => ({
        id: v.id,
        impact: v.impact,
        nodes: v.nodes.map((n) => n.target),
      })),
    ).toEqual([]);
  };
  await scan();
  await page.locator("[data-nav=lessons]").first().click();
  await expect(page.locator(".lesson-card")).toHaveCount(lessons.length);
  await scan();
  await page.locator("[data-action=font]").click();
  await page.setViewportSize({ width: 320, height: 740 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth + 1,
    ),
  ).toBeTruthy();
  await scan();
  await page.locator("[data-lesson=new-number]").click();
  await scan();
  await page.keyboard.press("Escape");
  await expect(page.locator("[role=dialog]")).toHaveCount(0);
});

test("own devices connect without replacing profile, can be renamed and revoked from another browser", async ({
  page,
  browser,
  request,
}, testInfo) => {
  const owner = await api(request, "/register", null, {
    name: "Мой профиль",
    consent: true,
    deviceLabel: "Первый браузер",
  });
  await page.addInitScript((t) => {
    if (location.protocol === "http:") localStorage.setItem("ryadom-token", t);
  }, owner.token);
  await page.goto("/");
  await page.locator(".profile").click();
  await page.locator("[data-action=prepare-device]").click();
  await page.locator("[data-action=generate-device-code]").click();
  const code = await page.locator("#device-code-secret").inputValue();
  expect(code).toMatch(/^(?:[a-f0-9]{4}-){5}[a-f0-9]{4}$/);
  const otherContext = await browser.newContext({
    viewport: testInfo.project.use.viewport,
  });
  try {
    const other = await otherContext.newPage();
    await other.goto(base);
    await other.locator("[data-action=connect-device]").first().click();
    await other.locator("#connect-code").fill(code);
    await other.locator("#connect-label").fill("Мой второй браузер");
    await other.locator("#device-connect-form .btn.primary").click();
    await expect(other.locator(".device-row")).toHaveCount(2);
    await expect(other.locator("#device-label")).toHaveValue(
      "Мой второй браузер",
    );
    await other.locator("#device-label").fill("Мой планшет");
    await other.locator("#device-name-form .btn.secondary").click();
    await expect(other.locator(".device-row")).toContainText([
      "Первый браузер",
      "Мой планшет",
    ]);
    await expect(page.locator("#device-code-secret")).toHaveCount(0);
    await page.locator("[data-action=close]").click();
    await expect(page.locator(".device-row")).toHaveCount(2);
    await expect(page.locator(".device-list")).toContainText("Мой планшет");
    await page.locator("[data-revoke-device]").click();
    await page.locator("[data-action=confirm-revoke-device]").click();
    await expect(page.locator(".device-row")).toHaveCount(1);
    await expect
      .poll(() => other.evaluate(() => localStorage.getItem("ryadom-token")))
      .toBeNull();
    await expect(other.locator(".device-row")).toHaveCount(0);
    await expect(other.locator("[data-action=restore]")).toBeVisible();
    const state = await api(request, "/state", owner.token);
    expect(state.members).toHaveLength(1);
    expect(state.devices).toHaveLength(1);
    const result = await new AxeBuilder({ page })
      .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
      .analyze();
    expect(result.violations).toEqual([]);
  } finally {
    await otherContext.close();
  }
});

test("a delayed private-state response cannot restore a profile after logout", async ({
  page,
  request,
}) => {
  const account = await api(request, "/register", null, {
    name: "Приватный профиль",
    consent: true,
  });
  await page.addInitScript(
    (token) => localStorage.setItem("ryadom-token", token),
    account.token,
  );
  await page.goto("/");
  await expect(page.locator(".profile")).toContainText("Приватный профиль");
  let release,
    waiting = false;
  const gate = new Promise((resolve) => {
    release = resolve;
  });
  await page.route("**/api/state", async (route) => {
    const response = await route.fetch();
    waiting = true;
    await gate;
    await route.fulfill({ response });
  });
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await expect.poll(() => waiting).toBeTruthy();
  await page.locator(".profile").click();
  await page.locator("[data-action=logout]").click();
  await page.locator("[data-action=confirm-logout]").click();
  release();
  await page.unrouteAll({ behavior: "wait" });
  await expect(page.locator(".profile")).toContainText("Добро пожаловать");
  await expect(page.locator("body")).not.toContainText("Приватный профиль");
});

test("catalog search and personal saved stories persist without appearing for the partner", async ({
  page,
  request,
}) => {
  const a = await api(request, "/register", null, {
    name: "Читаем вместе",
    consent: true,
  });
  const initial = await api(request, "/state", a.token);
  const b = await api(request, "/join", null, {
    name: "Близкий",
    consent: true,
    invite: initial.invite,
  });
  await page.addInitScript(
    (token) => localStorage.setItem("ryadom-token", token),
    a.token,
  );
  await page.goto("/");
  await page.locator("[data-nav=lessons]").first().click();
  await page.locator("#catalog-query").fill("ЗВОНОК БАНКА");
  await page.locator("#catalog-search [type=submit]").click();
  await expect(page.locator(".lesson-card")).toHaveCount(1);
  await page.locator("[data-save-lesson=bank]").click();
  await expect(page.locator("[data-save-lesson=bank]")).toHaveAttribute(
    "aria-pressed",
    "true",
  );
  expect((await api(request, "/state", b.token)).savedLessons).toEqual([]);
  await page.locator("[data-nav=home]").first().click();
  await expect(page.locator(".saved-section")).toContainText("Звонок");
  await page.reload();
  await expect(page.locator(".saved-section")).toBeVisible();
  await page.locator("[data-action=open-saved]").click();
  await expect(page.locator(".lesson-card")).toHaveCount(1);
  await page.locator("#catalog-query").fill("несуществующая история");
  await page.locator("#catalog-search [type=submit]").click();
  await expect(page.locator(".empty")).toBeVisible();
  await page.locator("[data-action=catalog-reset]").click();
  await expect(page.locator(".lesson-card")).toHaveCount(lessons.length);
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(
    scan.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((node) => node.target),
    })),
  ).toEqual([]);
});

test("new scenarios offer collections, practical steps, optional conversation prompts and safety support", async ({
  page,
  request,
}) => {
  const account = await api(request, "/register", null, {
    name: "Выбираем историю",
    consent: true,
  });
  await page.addInitScript(
    (token) => localStorage.setItem("ryadom-token", token),
    account.token,
  );
  await page.goto("/");
  await expect(page.locator(".collection-card")).toHaveCount(6);
  async function chooseAndAnswer(id) {
    await page.locator(`[data-lesson=${id}]`).click();
    await expect(page.locator(".lesson-goal")).toContainText(
      lessons.find((l) => l.id === id).goal,
    );
    await page.locator("[data-mode=together]").click();
    await expect(page.locator(".answer-note")).toHaveCount(0);
    await answer(page, 0);
    await expect(page.locator(".answer-note")).toHaveCount(0);
    await page.locator('[data-choice="2"]').click();
    await page.locator("[data-action=answer]").click();
    const lesson = lessons.find((l) => l.id === id);
    await expect(page.locator(".answer-note")).toHaveText([
      lesson.optionNotes[0],
      lesson.optionNotes[2],
    ]);
  }
  async function finish() {
    await page.locator("[data-action=complete-session]").click();
    await page.locator("[data-action=confirm-complete]").click();
    await expect(page.locator(".success-art")).toBeVisible();
    await page.locator(".lesson-actions [data-nav=home]").click();
  }
  await page.locator("[data-collection-id=connection]").click();
  await page.locator("#catalog-minutes").selectOption("5");
  await chooseAndAnswer("voice-message");
  await expect(page.locator(".practice-check")).toContainText(
    lessons.find((l) => l.id === "voice-message").selfCheck,
  );
  await expect(page.locator(".practice-guide li")).toHaveCount(4);
  await expect(page.locator(".practice-guide")).toContainText("владелец");
  await finish();
  await page.locator("[data-collection-id=support]").click();
  await chooseAndAnswer("listening-without-advice");
  await expect(page.locator("[data-action=to-agreement]")).toHaveCount(0);
  await page.locator(".lesson-extra summary").click();
  await expect(page.locator(".lesson-extra li")).toHaveCount(2);
  await finish();
  await page.locator("[data-collection-id=messages]").click();
  await chooseAndAnswer("familiar-voice");
  await page.locator(".lesson-extra summary").click();
  await expect(page.locator(".lesson-extra")).toContainText("Не скрывайте");
  await page.locator(".decision-checks summary").click();
  await expect(page.locator(".decision-checks dt")).toHaveCount(2);
  await page.locator(".scenario-variation summary").click();
  await expect(page.locator(".scenario-variation")).toContainText(
    lessons.find((l) => l.id === "familiar-voice").variation.note,
  );
  await expect(page.locator(".content-limit")).toBeVisible();
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(
    scan.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((node) => node.target),
    })),
  ).toEqual([]);
  await page.locator("[data-action=to-agreement]").click();
  await page.locator("#agreement-form .btn.primary").click();
  await expect(page.locator(".success-art")).toBeVisible();
  await page.locator(".lesson-actions [data-nav=agreements]").click();
  await expect(page.locator(".agreement")).toContainText("независимой связью");
});

test("editorial artwork loads and redesigned registration dialog remains accessible and scrollable", async ({
  page,
}) => {
  await page.goto("/");
  const hero = page.locator(".hero-art img");
  await expect(hero).toBeVisible();
  expect(
    await hero.evaluate((img) => img.complete && img.naturalWidth > 0),
  ).toBeTruthy();
  for (const art of ["together", "invitation", "growth"]) {
    const response = await page.request.get(`/art/${art}.webp`);
    expect(response.ok()).toBeTruthy();
    expect(response.headers()["content-type"]).toContain("image/webp");
    expect((await response.body()).length).toBeLessThan(110000);
  }
  await page.locator(".hero [data-lesson]").click();
  const dialog = page.getByRole("dialog", { name: "Давайте познакомимся" });
  await expect(dialog).toBeVisible();
  await expect(dialog.locator(".dialog-art img")).toBeVisible();
  expect(
    await dialog.evaluate((el) => el.scrollWidth <= el.clientWidth + 1),
  ).toBeTruthy();
  const scan = await new AxeBuilder({ page })
    .include(".modal")
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(
    scan.violations.map((v) => ({
      id: v.id,
      nodes: v.nodes.map((n) => n.target),
    })),
  ).toEqual([]);
  await page.locator("#reg-name").fill("Проверка окна");
  await page.locator("[name=consent]").check();
  await page.locator("#register-form .btn.primary").scrollIntoViewIfNeeded();
  await expect(page.locator("#register-form .btn.primary")).toBeInViewport();
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
});
