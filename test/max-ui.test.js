import { test } from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { readFileSync } from "node:fs";
function client(bridge, { fast = false } = {}) {
  const dom = new JSDOM(
    "<!doctype html><html><head></head><body></body></html>",
    { url: "https://ryadom.example.invalid", runScripts: "outside-only" },
  );
  const w = dom.window;
  w.WebApp = bridge;
  w.fetch = async () => ({
    ok: true,
    json: async () => ({
      maxEnabled: false,
      maxOnly: false,
      maxBotName: "RyadomTestBot",
    }),
  });
  if (fast) {
    const schedule = w.setTimeout.bind(w);
    w.setTimeout = (fn) => schedule(fn, 5);
  }
  w.eval(
    readFileSync("public/max.js", "utf8").replace(
      "export const maxPlatform =",
      "window.maxPlatform =",
    ),
  );
  return { w, platform: w.maxPlatform, close: () => w.close() };
}
test("MAX UI: quota failure and failed removal do not resurrect an old local key", async () => {
  const c = client();
  try {
    await c.platform.init();
    c.w.localStorage.setItem("ryadom-token", "old");
    c.w.Storage.prototype.setItem = () => {
      throw new Error("quota");
    };
    c.w.Storage.prototype.removeItem = () => {
      throw new Error("blocked");
    };
    await c.platform.setToken("new");
    assert.equal(await c.platform.getToken(), "new");
    await c.platform.setToken(null);
    assert.equal(await c.platform.getToken(), null);
  } finally {
    c.close();
  }
});
test("MAX UI: unresponsive viewport/SecureStorage time out and preserve a working local fallback", async () => {
  const never = () => new Promise(() => {});
  const c = client(
    {
      initData: "signed-data",
      platform: "android",
      getViewportSize: never,
      SecureStorage: { getItem: never, setItem: never, removeItem: never },
    },
    { fast: true },
  );
  try {
    await c.platform.init();
    assert.equal(c.platform.active, true);
    await c.platform.setToken("fallback");
    assert.equal(c.w.localStorage.getItem("ryadom-token"), "fallback");
    assert.equal(await c.platform.getToken(), "fallback");
    await c.platform.setToken(null);
    assert.equal(await c.platform.getToken(), null);
  } finally {
    c.close();
  }
});
test("MAX UI: web MAX opens the HTTPS export externally, native MAX uses downloadFile, unsafe URLs fail", async () => {
  const calls = [];
  const sdk = {
    initData: "signed-data",
    platform: "web",
    openLink: async (url) => calls.push(["external", url]),
    downloadFile: async (...args) => calls.push(["native", ...args]),
  };
  const c = client(sdk);
  try {
    await c.platform.init();
    await c.platform.download(
      "https://ryadom.example.invalid/max/download/ticket",
      "ryadom-data.json",
    );
    assert.equal(calls[0][0], "external");
    sdk.platform = "android";
    await c.platform.download(
      "https://ryadom.example.invalid/max/download/new-ticket",
      "ryadom-data.json",
    );
    assert.equal(calls[1][0], "native");
    for (const url of [
      "javascript:alert(1)",
      "http://ryadom.example.invalid/x",
      "https://user:password@example.com/x",
    ])
      await assert.rejects(() => c.platform.download(url, "x"));
    assert.equal(calls.length, 2);
  } finally {
    c.close();
  }
});
test("MAX UI: Bridge rejection objects are converted into readable share/download errors", async () => {
  const reject = () =>
    Promise.reject({ error: { code: "client.download_file.request_timeout" } });
  const c = client({
    initData: "signed-data",
    platform: "android",
    shareMaxContent: reject,
    downloadFile: reject,
  });
  try {
    await c.platform.init();
    await assert.rejects(
      () => c.platform.share("Привет", "https://max.ru/RyadomTestBot"),
      /Скопируйте ссылку/,
    );
    await assert.rejects(
      () => c.platform.download("https://example.com/file", "file.json"),
      /MAX не смог скачать/,
    );
  } finally {
    c.close();
  }
});
