import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { createHmac, randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { validateMaxInitData, MAX_CONSENT_VERSION } from "../lib/max.js";
const secret = "not-a-real-max-token-unit-fixture";
function launch(id, extra = {}, name = "Анна + 20% & семья") {
  const p = new URLSearchParams({
    query_id: randomUUID(),
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id, first_name: name }),
    ...extra,
  });
  const key = createHmac("sha256", "WebAppData").update(secret).digest();
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
test("MAX HMAC: one URL decode, ampersands/plus/percent, strict duplicates, dates and identity", () => {
  const raw = launch(10);
  const result = validateMaxInitData(raw, secret);
  assert.equal(result.userId, "10");
  assert.equal(result.firstName, "Анна + 20% & семья");
  assert.throws(() => validateMaxInitData(raw, "wrong"));
  assert.throws(() =>
    validateMaxInitData(
      raw + "&hash=" + new URLSearchParams(raw).get("hash"),
      secret,
    ),
  );
  assert.throws(() => validateMaxInitData(raw + "&user=x", secret));
  assert.throws(() =>
    validateMaxInitData(raw.replace("user=", "u%73er=") + "&user=x", secret),
  );
  assert.throws(() => validateMaxInitData(raw + "&x=%GG", secret));
  assert.throws(() =>
    validateMaxInitData(raw.replace(/hash=[a-f0-9]+/, "hash=a"), secret),
  );
  assert.throws(() =>
    validateMaxInitData(
      launch(10, { auth_date: String(Math.floor(Date.now() / 1000) - 3601) }),
      secret,
    ),
  );
  assert.throws(() =>
    validateMaxInitData(
      launch(10, { auth_date: String(Math.floor(Date.now() / 1000) + 61) }),
      secret,
    ),
  );
  assert.throws(() =>
    validateMaxInitData(launch(10, { auth_date: "1e10" }), secret),
  );
  for (const bad of [0, -1, 1.5, "123", Number.MAX_SAFE_INTEGER + 1])
    assert.throws(() => validateMaxInitData(launch(bad), secret));
  assert.throws(() =>
    validateMaxInitData(launch(10, { user: "not-json" }), secret),
  );
  assert.throws(() =>
    validateMaxInitData(launch(10, { query_id: "" }), secret),
  );
});
const dir = mkdtempSync(join(tmpdir(), "ryadom-max-"));
let child;
const origin = "http://127.0.0.1:3225";
async function req(path, token, body, method) {
  const r = await fetch(origin + "/api" + path, {
    method: method || (body ? "POST" : "GET"),
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, data: await r.json() };
}
async function auth(raw, extra = {}, token) {
  return req("/max/auth", token, { initData: raw, ...extra });
}
before(async () => {
  child = spawn(process.execPath, ["server.js"], {
    env: {
      ...process.env,
      PORT: "3225",
      DATA_DIR: dir,
      MAX_BOT_TOKEN: secret,
      MAX_BOT_NAME: "RyadomTestBot",
      PUBLIC_URL: "https://ryadom.example.invalid",
      MAX_ONLY: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => reject(new Error("MAX server startup timeout")),
      10000,
    );
    child.stdout.once("data", () => {
      clearTimeout(timer);
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

test("MAX API: verified signup with consent, login, replay/re-encoding protection, recovery and deletion", async () => {
  const raw = launch(1001);
  assert.equal((await auth(raw)).data.needsConsent, true);
  assert.equal((await req("/state", "not-a-token")).status, 401);
  assert.equal(
    (await auth(raw.replace("1001", "1002"), { consent: true })).status,
    403,
  );
  const a = await auth(raw, { consent: true });
  assert.equal(a.status, 200);
  assert.ok(a.data.token);
  assert.ok(a.data.recoveryCode);
  const token = a.data.token,
    initial = (await req("/state", token)).data;
  assert.equal(initial.maxLinked, true);
  assert.equal(initial.consent.version, MAX_CONSENT_VERSION);
  assert.equal(initial.devices.length, 1);
  assert.equal(initial.consentVersion, MAX_CONSENT_VERSION);
  assert.equal((await auth(raw)).status, 409);
  const alternate = new URLSearchParams(raw);
  const reordered = [...alternate]
    .reverse()
    .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
    .join("&");
  assert.equal(
    (await auth(reordered)).status,
    409,
    "same launch cannot be replayed by reordering/re-encoding",
  );
  assert.equal(
    (await auth(raw, {}, token)).data.authenticated,
    true,
    "valid cached session gets no new bearer",
  );
  const second = await auth(launch(1001));
  assert.equal(second.status, 200);
  assert.ok(second.data.token);
  assert.equal((await req("/state", second.data.token)).data.me, initial.me);
  assert.equal((await req("/state", second.data.token)).data.devices.length, 2);
  const exported = (await req("/export", token)).data;
  assert.deepEqual(exported.maxAccount, { userId: "1001" });
  assert.equal(exported.devices.length, 2);
  assert.ok(!JSON.stringify(exported).includes(token));
  const read = new DatabaseSync(join(dir, "ryadom.sqlite"));
  assert.equal(read.prepare("SELECT count(*) n FROM max_accounts").get().n, 1);
  assert.ok(
    !JSON.stringify(read.prepare("SELECT * FROM max_launches").all()).includes(
      raw,
    ),
  );
  read.close();
  const recovered = await req("/recover", null, { code: a.data.recoveryCode });
  assert.equal(recovered.status, 200);
  assert.equal((await req("/state", token)).status, 401);
  assert.equal((await req("/state", second.data.token)).status, 401);
  assert.equal(
    (await req("/state", recovered.data.token)).data.maxLinked,
    true,
  );
  assert.equal(
    (await req("/account", recovered.data.token, null, "DELETE")).status,
    200,
  );
  assert.equal(
    (await auth(raw, { consent: true })).status,
    409,
    "deleted account does not resurrect a used launch",
  );
  const recreated = await auth(launch(1001), { consent: true });
  assert.equal(recreated.status, 200);
  assert.notEqual(
    (await req("/state", recreated.data.token)).data.me,
    initial.me,
  );
});

test("MAX API: signed startapp invite creates separate partner, no third member or automatic pair switching", async () => {
  const a = (await auth(launch(2001), { consent: true, name: "Первый" })).data;
  const state = (await req("/state", a.token)).data;
  const invited = launch(2002, { start_param: "invite_" + state.invite });
  assert.equal((await auth(invited)).data.joining, true);
  const b = (await auth(invited, { consent: true, name: "Второй" })).data;
  const bs = (await req("/state", b.token)).data;
  assert.equal(bs.members.length, 2);
  assert.notEqual(bs.me, state.me);
  assert.equal(
    (
      await auth(launch(2003, { start_param: "invite_" + state.invite }), {
        consent: true,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await auth(launch(2004, { start_param: "invite_" + "a".repeat(36) }), {
        consent: true,
      })
    ).status,
    404,
  );
  const stranger = (await auth(launch(2005), { consent: true })).data;
  assert.equal(
    (await auth(launch(2001), {}, stranger.token)).status,
    409,
    "cached other identity must not be shown or merged",
  );
  const otherLaunch = await auth(
    launch(2001, { start_param: "invite_" + "b".repeat(36) }),
  );
  assert.equal(otherLaunch.data.inviteIgnored, true);
  assert.equal(
    (await req("/state", otherLaunch.data.token)).data.members.length,
    2,
  );
  assert.ok(
    !JSON.stringify(bs).includes("2001"),
    "partner MAX identifier is private",
  );
});

test("MAX API: existing browser profile needs explicit linking consent and cannot bind a second MAX identity", async () => {
  const original = (
    await req("/register", null, { name: "Мой старый профиль", consent: true })
  ).data;
  const before = (await req("/state", original.token)).data;
  const raw = launch(3001);
  const prompt = await auth(raw, {}, original.token);
  assert.equal(prompt.data.needsLinkConsent, true);
  assert.equal(prompt.data.profileName, "Мой старый профиль");
  assert.ok(!prompt.data.token);
  assert.equal(
    (await auth(raw, { consent: true }, original.token)).data.needsLinkConsent,
    true,
  );
  assert.equal(
    (await auth(raw, { linkExisting: true }, original.token)).data.needsConsent,
    true,
  );
  const linked = await auth(
    raw,
    { linkExisting: true, consent: true },
    original.token,
  );
  assert.equal(linked.status, 200);
  assert.equal(linked.data.linked, true);
  assert.ok(!linked.data.token);
  const after = (await req("/state", original.token)).data;
  assert.equal(after.me, before.me);
  assert.equal(after.maxLinked, true);
  assert.equal(after.devices.length, 1);
  assert.equal(
    (
      await auth(
        launch(3002),
        { linkExisting: true, consent: true },
        original.token,
      )
    ).status,
    409,
  );
  const reopened = await auth(launch(3001));
  assert.ok(reopened.data.token);
  assert.equal((await req("/state", reopened.data.token)).data.me, before.me);
});

test("MAX download: HTTPS, 60-second one-use capability, HEAD and revoke; no bearer in URL", async () => {
  const owner = (await auth(launch(4001), { consent: true })).data;
  const ticket = await req("/max/export-ticket", owner.token, {});
  assert.equal(ticket.status, 200);
  assert.ok(
    ticket.data.url.startsWith("https://ryadom.example.invalid/max/download/"),
  );
  assert.ok(!ticket.data.url.includes(owner.token));
  const local = origin + new URL(ticket.data.url).pathname;
  assert.equal((await fetch(local, { method: "HEAD" })).status, 200);
  const dl = await fetch(local);
  assert.equal(dl.status, 200);
  assert.equal(dl.headers.get("cache-control"), "no-store");
  assert.equal((await dl.json()).maxAccount.userId, "4001");
  assert.equal((await fetch(local)).status, 404);
  const cancelled = await req("/max/export-ticket", owner.token, {});
  await req("/logout", owner.token, {});
  assert.equal(
    (await fetch(origin + new URL(cancelled.data.url).pathname)).status,
    404,
  );
});
