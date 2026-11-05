import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "ryadom-test-")),
  port = 3218;
let server;
const request = async (path, token, body, method) => {
  const r = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method: method || (body ? "POST" : "GET"),
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, data: await r.json() };
};
before(async () => {
  server = spawn(process.execPath, ["server.js"], {
    env: { ...process.env, PORT: String(port), DATA_DIR: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const timeout = setTimeout(
      () => reject(Error("Server startup timeout")),
      10000,
    );
    server.stdout.on("data", () => {
      clearTimeout(timeout);
      resolve();
    });
    server.on("error", reject);
  });
});
after(() => {
  server?.kill();
  rmSync(dir, { recursive: true, force: true });
});
test("complete two-device journey, privacy, authorization and deletion", async () => {
  assert.equal((await request("/state")).status, 401);
  assert.equal((await request("/register", null, { name: "A" })).status, 400);
  const a = (await request("/register", null, { name: "Анна", consent: true }))
    .data.token;
  let s = (await request("/state", a)).data;
  const invite = s.invite;
  const b = (
    await request("/join", null, { name: "Мама", consent: true, invite })
  ).data.token;
  assert.equal(
    (await request("/join", null, { name: "Третий", consent: true, invite }))
      .status,
    400,
  );
  const outsider = (
    await request("/register", null, { name: "Друг", consent: true })
  ).data.token;
  const sid = (await request("/start", a, { lesson: "bank", mode: "remote" }))
    .data.id;
  assert.equal(
    (await request("/start", b, { lesson: "parcel", mode: "remote" })).data.id,
    sid,
  );
  assert.equal(
    (await request(`/session/${sid}/answer`, outsider, { choice: 0 })).status,
    404,
  );
  assert.equal(
    (await request(`/session/${sid}/finish`, a, { text: "Too early" })).status,
    400,
  );
  assert.equal(
    (await request(`/session/${sid}/answer`, a, { choice: 9 })).status,
    400,
  );
  await request(`/session/${sid}/answer`, a, { choice: 0 });
  s = (await request("/state", b)).data;
  assert.equal(s.sessions[0].revealed, 0);
  assert.deepEqual(Object.values(s.sessions[0].answers), [null]);
  await request(`/session/${sid}/answer`, b, { choice: 1 });
  s = (await request("/state", a)).data;
  assert.equal(s.sessions[0].revealed, 1);
  assert.deepEqual(Object.values(s.sessions[0].answers), [0, 1]);
  assert.equal(
    (await request(`/session/${sid}/answer`, a, { choice: 2 })).status,
    400,
  );
  assert.equal(
    (
      await request(`/session/${sid}/finish`, a, {
        text: "Без второго согласия",
      })
    ).status,
    400,
  );
  assert.equal(
    (
      await request(`/session/${sid}/propose`, a, {
        text: "Перезваниваем в банк сами.",
        revision: 0,
      })
    ).status,
    200,
  );
  assert.equal((await request("/state", b)).data.agreements.length, 0);
  assert.equal(
    (await request(`/session/${sid}/approve`, b, { revision: 1 })).status,
    200,
  );
  s = (await request("/state", b)).data;
  assert.equal(s.agreements.length, 1);
  assert.ok(s.sessions[0].finished);
  await request("/invite/rotate", a, {});
  assert.equal(
    (await request("/join", null, { name: "X", consent: true, invite })).status,
    404,
  );
  await request("/account", a, null, "DELETE");
  assert.equal((await request("/state", a)).status, 401);
  s = (await request("/state", b)).data;
  assert.equal(s.members.length, 1);
  assert.equal(s.agreements.length, 1);
  assert.equal(Object.keys(s.sessions[0].answers).length, 1);
  await request("/account", b, null, "DELETE");
  assert.equal((await request("/state", b)).status, 401);
});
test("one-device session and cancellation", async () => {
  const a = (
    await request("/register", null, { name: "Вместе", consent: true })
  ).data.token;
  const sid = (
    await request("/start", a, { lesson: "family-memory", mode: "together" })
  ).data.id;
  assert.equal(
    (await request(`/session/${sid}/answer`, a, { choice: 0, person: "fake" }))
      .status,
    400,
  );
  await request(`/session/${sid}/answer`, a, { choice: 0, person: "first" });
  let s = (await request("/state", a)).data;
  assert.equal(s.sessions[0].revealed, 0);
  await request(`/session/${sid}/answer`, a, { choice: 2, person: "second" });
  s = (await request("/state", a)).data;
  assert.equal(s.sessions[0].revealed, 1);
  await request(`/session/${sid}/cancel`, a, {});
  assert.equal((await request("/state", a)).data.sessions.length, 0);
});

test("single-use recovery keeps progress, revokes old access, rotates code and exports no secrets", async () => {
  const registered = (
    await request("/register", null, { name: "Восстановление", consent: true })
  ).data;
  assert.match(registered.recoveryCode, /^(?:[a-f0-9]{4}-){7}[a-f0-9]{4}$/);
  let a = registered.token;
  const original = (await request("/state", a)).data;
  assert.equal(original.recoveryEnabled, true);
  assert.equal(
    JSON.stringify(original).includes(registered.recoveryCode),
    false,
  );
  const sid = (await request("/start", a, { lesson: "bank", mode: "together" }))
    .data.id;
  await request(`/session/${sid}/answer`, a, { choice: 1, person: "first" });
  const recovered = await request("/recover", null, {
    code: registered.recoveryCode.toUpperCase().replaceAll("-", " "),
  });
  assert.equal(recovered.status, 200);
  assert.notEqual(recovered.data.recoveryCode, registered.recoveryCode);
  assert.equal((await request("/state", a)).status, 401);
  a = recovered.data.token;
  let s = (await request("/state", a)).data;
  assert.equal(s.me, original.me);
  assert.equal(s.sessions[0].id, sid);
  assert.equal(s.sessions[0].answers.first, 1);
  assert.equal(
    (await request("/recover", null, { code: registered.recoveryCode })).status,
    400,
  );
  const rotated = (await request("/recovery-code", a, {})).data.recoveryCode;
  assert.equal(
    (await request("/recover", null, { code: recovered.data.recoveryCode }))
      .status,
    400,
  );
  const again = (await request("/recover", null, { code: rotated })).data;
  assert.ok(again.token);
  a = again.token;
  const exported = (await request("/export", a)).data;
  assert.equal(exported.profile.name, "Восстановление");
  assert.equal(exported.sessions.length, 1);
  for (const secret of [a, again.recoveryCode, s.invite, original.me])
    assert.equal(JSON.stringify(exported).includes(secret), false);
  await request("/account", a, null, "DELETE");
  assert.equal(
    (await request("/recover", null, { code: again.recoveryCode })).status,
    400,
  );
  const limited = await request("/recover", null, { code: "invalid" });
  assert.equal(limited.status, 429);
});

test("invalid JSON is a client error, health and security headers are available", async () => {
  const bad = await fetch(`http://127.0.0.1:${port}/api/register`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{broken",
  });
  assert.equal(bad.status, 400);
  const h = await fetch(`http://127.0.0.1:${port}/healthz`);
  assert.equal(h.status, 200);
  assert.deepEqual(await h.json(), { ok: true });
  assert.equal(h.headers.get("x-content-type-options"), "nosniff");
});

test("remote agreement requires two independent approvals of exactly the same revision", async () => {
  const a = (
    await request("/register", null, { name: "Первый", consent: true })
  ).data.token;
  const invite = (await request("/state", a)).data.invite;
  const b = (
    await request("/join", null, { name: "Второй", consent: true, invite })
  ).data.token;
  const outsider = (
    await request("/register", null, { name: "Не в паре", consent: true })
  ).data.token;
  const sid = (await request("/start", a, { lesson: "bank", mode: "remote" }))
    .data.id;
  assert.equal(
    (
      await request(`/session/${sid}/propose`, a, {
        text: "Ещё рано",
        revision: 0,
      })
    ).status,
    400,
  );
  await request(`/session/${sid}/answer`, a, { choice: 0 });
  await request(`/session/${sid}/answer`, b, { choice: 2 });
  assert.equal(
    (await request(`/session/${sid}/approve`, b, { revision: 1 })).status,
    409,
  );
  assert.equal(
    (
      await request(`/session/${sid}/propose`, outsider, {
        text: "Чужой текст",
        revision: 0,
      })
    ).status,
    404,
  );
  assert.equal(
    (
      await request(`/session/${sid}/propose`, a, {
        text: "Первый текст",
        revision: 0,
      })
    ).status,
    200,
  );
  await request(`/session/${sid}/approve`, a, { revision: 1 });
  let state = (await request("/state", b)).data;
  assert.equal(state.agreements.length, 0);
  assert.equal(state.sessions[0].proposal.approvals.length, 1);
  assert.equal(
    (
      await request(`/session/${sid}/propose`, b, {
        text: "Второй текст",
        revision: 0,
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(`/session/${sid}/propose`, b, {
        text: "Второй текст",
        revision: 1,
      })
    ).status,
    200,
  );
  assert.equal(
    (await request(`/session/${sid}/approve`, a, { revision: 1 })).status,
    409,
  );
  state = (await request("/state", a)).data;
  assert.equal(state.agreements.length, 0);
  assert.equal(state.sessions[0].proposal.revision, 2);
  assert.deepEqual(state.sessions[0].proposal.approvals, [
    state.members.find((m) => m.id !== state.me).id,
  ]);
  assert.equal(
    (await request(`/session/${sid}/approve`, a, { revision: 2 })).status,
    200,
  );
  state = (await request("/state", a)).data;
  assert.equal(state.agreements.length, 1);
  assert.equal(state.agreements[0].text, "Второй текст");
  assert.ok(state.sessions[0].finished);
  assert.equal(
    (await request(`/session/${sid}/approve`, b, { revision: 2 })).status,
    400,
  );
  await request("/account", b, null, "DELETE");
  const remaining = (await request("/state", a)).data;
  assert.deepEqual(remaining.sessions[0].proposal.approvals, [remaining.me]);
});

test("preferences are private, consent is recorded and logout revokes the server key", async () => {
  const registered = (
    await request("/register", null, { name: "Настройки", consent: true })
  ).data;
  const a = registered.token;
  const state = (await request("/state", a)).data;
  assert.equal(state.preferences.reviews, false);
  assert.deepEqual(state.reviewPlan, []);
  assert.equal(state.consent.version, "pilot-data-v3-security");
  assert.ok(Number.isFinite(Date.parse(state.consent.acceptedAt)));
  const b = (
    await request("/join", null, {
      name: "Близкий",
      consent: true,
      invite: state.invite,
    })
  ).data.token;
  assert.equal(
    (await request("/preferences", a, { reviews: "yes" })).status,
    400,
  );
  assert.equal(
    (await request("/preferences", a, { reviews: true })).status,
    200,
  );
  assert.equal((await request("/state", b)).data.preferences.reviews, false);
  const sid = (await request("/start", a, { lesson: "bank", mode: "together" }))
    .data.id;
  await request(`/session/${sid}/answer`, a, { choice: 0, person: "first" });
  await request(`/session/${sid}/answer`, a, { choice: 1, person: "second" });
  assert.equal((await request(`/session/${sid}/complete`, a, {})).status, 200);
  const after = (await request("/state", a)).data;
  assert.equal(after.agreements.length, 0);
  assert.equal(after.reviewPlan.length, 1);
  assert.equal(after.reviewPlan[0].intervalDays, 3);
  assert.equal((await request("/state", b)).data.reviewPlan.length, 0);
  assert.equal(
    (await request("/export", a)).data.consent.version,
    "pilot-data-v3-security",
  );
  assert.equal((await request("/logout", a, {})).status, 200);
  assert.equal((await request("/state", a)).status, 401);
  assert.equal((await request("/state", b)).status, 200);
});

test("conversation completion keeps answers without forcing or inventing an agreement", async () => {
  const a = (
    await request("/register", null, { name: "Разговор", consent: true })
  ).data.token;
  const sid = (
    await request("/start", a, { lesson: "family-recipe", mode: "together" })
  ).data.id;
  assert.equal((await request(`/session/${sid}/complete`, a, {})).status, 400);
  await request(`/session/${sid}/answer`, a, { choice: 0, person: "first" });
  await request(`/session/${sid}/answer`, a, { choice: 2, person: "second" });
  assert.equal(
    (
      await request(`/session/${sid}/finish`, a, {
        text: "Обязательное обещание",
      })
    ).status,
    400,
  );
  assert.equal((await request(`/session/${sid}/complete`, a, {})).status, 200);
  const state = (await request("/state", a)).data;
  assert.equal(state.agreements.length, 0);
  assert.ok(state.sessions[0].finished);
  assert.deepEqual(state.sessions[0].answers, { first: 0, second: 2 });
});
