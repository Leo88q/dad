import { test, expect } from "@playwright/test";
import { createHmac, randomInt, randomUUID } from "node:crypto";
import AxeBuilder from "@axe-core/playwright";
const base = "http://127.0.0.1:3226";
test.use({ baseURL: base });
function signedLaunch(id, name = "Нина", start_param = "") {
  const p = new URLSearchParams({
    query_id: randomUUID(),
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id, first_name: name }),
    ...(start_param ? { start_param } : {}),
  });
  const key = createHmac("sha256", "WebAppData")
    .update("not-a-real-max-token-e2e-fixture")
    .digest();
  p.set(
    "hash",
    createHmac("sha256", key)
      .update(
        [...p]
          .map(([k, v]) => `${k}=${v}`)
          .sort()
          .join("\n"),
      )
      .digest("hex"),
  );
  return p.toString();
}
async function bridge(page, raw, token = null) {
  await page.addInitScript(
    ({ raw, token }) => {
      if (token) localStorage.setItem("ryadom-token", token);
      window.__maxEvents = [];
      const log = (type, value) => window.__maxEvents.push({ type, value });
      const secure = JSON.parse(
        sessionStorage.getItem("fake-max-secure") || "{}",
      );
      window.WebApp = {
        initData: raw,
        initDataUnsafe: {
          user: { id: 999999, first_name: "НЕ ДОВЕРЯТЬ" },
          start_param: "invite_untrusted",
        },
        platform: "android",
        BackButton: {
          show: () => log("back-show"),
          hide: () => log("back-hide"),
          onClick: (fn) => {
            window.__nativeBack = fn;
          },
          offClick: () => {},
        },
        SecureStorage: {
          getItem: async (k) => secure[k] || "",
          setItem: async (k, v) => {
            secure[k] = v;
            sessionStorage.setItem("fake-max-secure", JSON.stringify(secure));
            log("secure-set");
          },
          removeItem: async (k) => {
            delete secure[k];
            sessionStorage.setItem("fake-max-secure", JSON.stringify(secure));
          },
        },
        getViewportSize: async () => ({ height: "844px", width: "390px" }),
        enableClosingConfirmation: () => log("closing-on"),
        disableClosingConfirmation: () => log("closing-off"),
        ScreenCapture: {
          disableScreenCapture: async () => log("screen-off"),
          enableScreenCapture: async () => log("screen-on"),
        },
        shareMaxContent: async (value) => log("share", value),
        downloadFile: async (url, name) => log("download", { url, name }),
      };
    },
    { raw, token },
  );
}
async function saveCode(page) {
  await expect(page.locator("#recovery-secret")).toBeVisible();
  await expect(page.locator("[data-action=download-code]")).toHaveCount(0);
  await page.locator("#code-saved").check();
  await page.locator("[data-action=code-done]").click();
}
async function register(page) {
  await page.locator("[name=consent]").check();
  await page.locator("#register-form .btn.primary").click();
  await saveCode(page);
}
async function api(request, path, token, body) {
  const r = await request[body ? "post" : "get"](base + "/api" + path, {
    headers: token ? { Authorization: "Bearer " + token } : {},
    ...(body ? { data: body } : {}),
  });
  expect(r.ok(), await r.text()).toBeTruthy();
  return r.json();
}
async function answer(page, choice) {
  await page.locator("[data-action=to-answer]").click();
  await page.locator(`[data-choice="${choice}"]`).click();
  await page.locator("[data-action=answer]").click();
}

test("MAX Bridge mock: verified entry, secure storage, native sharing, back button and HTTPS download", async ({
  page,
}) => {
  const errors = [];
  page.on("pageerror", (e) => errors.push(e.message));
  await bridge(page, signedLaunch(randomInt(1000000, 900000000)));
  await page.goto("/");
  await expect(page.locator("#reg-name")).toHaveValue("Нина");
  await expect(page.locator("#register-form")).toContainText(
    "идентификатора MAX",
  );
  await expect(page.locator("[data-action=restore]")).toHaveCount(0);
  await register(page);
  expect(
    await page.evaluate(() => localStorage.getItem("ryadom-token")),
  ).toBeNull();
  expect(
    await page.evaluate(() =>
      window.__maxEvents.some((x) => x.type === "secure-set"),
    ),
  ).toBeTruthy();
  await page.locator("[data-nav=family]").click();
  await page.locator("[data-action=invite]").click();
  await expect(page.locator("#invite-url")).toHaveValue(
    /^https:\/\/max\.ru\/RyadomTestBot\?startapp=invite_[a-f0-9]{36}$/,
  );
  await page.locator("[data-action=share]").click();
  expect(
    await page.evaluate(
      () => window.__maxEvents.find((x) => x.type === "share").value.link,
    ),
  ).toContain("https://max.ru/RyadomTestBot?startapp=invite_");
  await page.evaluate(() => window.__nativeBack());
  await expect(page.locator("[role=dialog]")).toHaveCount(0);
  await page.evaluate(() => window.__nativeBack());
  await expect(page.locator(".hero")).toBeVisible();
  await page.locator(".hero [data-lesson]").click();
  await page.locator("[data-mode=together]").click();
  await expect(page.locator("[data-action=to-answer]")).toBeVisible();
  expect(
    await page.evaluate(() =>
      window.__maxEvents.some((x) => x.type === "closing-on"),
    ),
  ).toBeTruthy();
  await page.evaluate(() => window.__nativeBack());
  await expect(page.locator("[data-resume]")).toBeVisible();
  await page.locator(".profile").click();
  await expect(
    page
      .locator(".settings-section")
      .filter({ hasText: "Профиль связан с MAX" }),
  ).toBeVisible();
  const axe = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(axe.violations.map((v) => v.id)).toEqual([]);
  await page.locator("[data-action=export]").click();
  await expect
    .poll(() =>
      page.evaluate(
        () => window.__maxEvents.filter((x) => x.type === "download").length,
      ),
    )
    .toBe(1);
  const dl = await page.evaluate(
    () => window.__maxEvents.find((x) => x.type === "download").value,
  );
  expect(dl.url).toMatch(
    /^https:\/\/ryadom\.example\.invalid\/max\/download\/[a-f0-9]{36}$/,
  );
  expect(dl.name).toBe("ryadom-data.json");
  await page.reload();
  await expect(page.locator(".profile")).toContainText("Нина");
  await expect(page.locator("#register-form")).toHaveCount(0);
  expect(errors).toEqual([]);
});

test("MAX signed startapp joins two independent identities and completes a remote agreement", async ({
  page,
  browser,
  request,
}, info) => {
  const aId = randomInt(1000000, 900000000),
    bId = randomInt(1000000, 900000000);
  const a = await api(request, "/max/auth", null, {
    initData: signedLaunch(aId, "Первый"),
    consent: true,
  });
  const state = await api(request, "/state", a.token);
  await bridge(page, signedLaunch(aId, "Первый"));
  await page.goto("/");
  await expect(page.locator(".profile")).toContainText("Первый");
  const context = await browser.newContext({
    viewport: info.project.use.viewport,
  });
  const second = await context.newPage();
  try {
    await bridge(second, signedLaunch(bId, "Второй", "invite_" + state.invite));
    await second.goto(base);
    await expect(second.locator("#register-form")).toContainText(
      "Присоединиться",
    );
    await register(second);
    await page.locator(".hero [data-lesson]").click();
    await page.locator("[data-mode=remote]").click();
    await answer(page, 0);
    await expect(second.locator("[data-resume]")).toBeVisible();
    await second.locator("[data-resume]").click();
    await answer(second, 1);
    await expect(page.locator("[data-action=to-agreement]")).toBeVisible();
    await page.locator("[data-action=to-agreement]").click();
    await page
      .locator("#agreement")
      .fill("Проверяем просьбу звонком близкому.");
    await page.locator("#agreement-form .btn.primary").click();
    await second.locator("[data-action=to-agreement]").click();
    await expect(
      second.locator("[data-action=approve-proposal]"),
    ).toBeVisible();
    await second.locator("[data-action=approve-proposal]").click();
    await expect(page.locator(".success-art")).toBeVisible();
    await expect(second.locator(".success-art")).toBeVisible();
  } finally {
    await context.close();
  }
});

test("MAX account mismatch does not expose a cached profile, including background refresh", async ({
  page,
  request,
}) => {
  const a = await api(request, "/max/auth", null, {
    initData: signedLaunch(randomInt(1000000, 900000000), "Секретный профиль"),
    consent: true,
  });
  let stateRequests = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/state")) stateRequests++;
  });
  await bridge(
    page,
    signedLaunch(randomInt(1000000, 900000000), "Другой"),
    a.token,
  );
  await page.goto("/");
  await expect(page.locator(".connection")).toContainText(
    "другим аккаунтом MAX",
  );
  await page.evaluate(() =>
    document.dispatchEvent(new Event("visibilitychange")),
  );
  await page.waitForTimeout(4200);
  expect(stateRequests).toBe(0);
  await expect(page.locator("body")).not.toContainText("Секретный профиль");
  await page.locator("[data-action=max-clear-cached]").click();
  await expect(page.locator("#reg-name")).toHaveValue("Другой");
  await register(page);
  await expect(page.locator(".profile")).toContainText("Другой");
});

test("MAX-only deployment rejects browser signup and gives a clear error without signed Bridge data", async ({
  page,
  request,
}) => {
  await page.route("https://st.max.ru/js/max-web-app.js", (route) =>
    route.fulfill({
      contentType: "application/javascript",
      body: "/* no native MAX context */",
    }),
  );
  let stateRequests = 0;
  page.on("request", (r) => {
    if (r.url().endsWith("/api/state")) stateRequests++;
  });
  await page.goto("/");
  await expect(page.locator(".connection")).toContainText("через бота в MAX");
  await expect(page.locator(".entry-gate h1")).toBeVisible();
  await expect(page.locator(".hero")).toHaveCount(0);
  await expect(
    page.locator('[href="https://max.ru/RyadomTestBot"]'),
  ).toBeVisible();
  await expect(page.locator("#register-form")).toHaveCount(0);
  const scan = await new AxeBuilder({ page })
    .withTags(["wcag2a", "wcag2aa", "wcag21aa"])
    .analyze();
  expect(scan.violations.map((v) => v.id)).toEqual([]);
  expect(stateRequests).toBe(0);
  const reg = await request.post(base + "/api/register", {
    data: { name: "Без MAX", consent: true },
  });
  expect(reg.status()).toBe(403);
  const fake = await request.post(base + "/api/max/auth", {
    data: {
      initData:
        "user=" + encodeURIComponent('{"id":123}') + "&hash=" + "0".repeat(64),
      consent: true,
    },
  });
  expect(fake.status()).toBe(403);
  // A late-arriving SDK can recover without losing the app or requiring a reload.
  await page.evaluate(
    (raw) => {
      window.WebApp = {
        initData: raw,
        platform: "web",
        openLink: async (url) => {
          window.__externalDownload = url;
        },
      };
    },
    signedLaunch(randomInt(1000000, 900000000), "Веб MAX"),
  );
  await page.locator("button[data-action=max-retry]").click();
  await expect(page.locator("#reg-name")).toHaveValue("Веб MAX");
  await register(page);
  await page.locator(".profile").click();
  await page.locator("[data-action=export]").click();
  await expect
    .poll(() => page.evaluate(() => window.__externalDownload || ""))
    .toMatch(/^https:\/\/ryadom\.example\.invalid\/max\/download\//);
});
