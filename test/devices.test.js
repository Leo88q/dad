import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const dir = mkdtempSync(join(tmpdir(), "ryadom-devices-"));
let server;
const base = "http://127.0.0.1:3224/api";
async function request(path, token, body) {
  const r = await fetch(base + path, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
  });
  return { status: r.status, headers: r.headers, data: await r.json() };
}
before(async () => {
  server = spawn(process.execPath, ["server.js"], {
    env: { ...process.env, PORT: "3224", DATA_DIR: dir },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Error("Startup timeout")), 10000);
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

test("API: connect same profile, private devices, revoke, recover all, rename and cancel pending code", async () => {
  const original = (
    await request("/register", null, {
      name: "Владелец",
      consent: true,
      deviceLabel: "Мой компьютер",
    })
  ).data;
  const a = original.token;
  const before = (await request("/state", a)).data;
  assert.equal(before.devices.length, 1);
  assert.equal(before.devices[0].current, true);
  assert.equal(before.devices[0].label, "Мой компьютер");
  const b = (
    await request("/join", null, {
      name: "Близкий",
      consent: true,
      invite: before.invite,
    })
  ).data.token;
  assert.equal((await request("/device-code")).status, 401);
  const code = (await request("/device-code", a, {})).data;
  const connected = await request("/connect-device", null, {
    code: code.code,
    deviceLabel: "Мой планшет",
  });
  assert.equal(connected.status, 200);
  const a2 = connected.data.token;
  const second = (await request("/state", a2)).data;
  assert.equal(second.me, before.me);
  assert.equal(second.members.length, 2);
  assert.equal(second.devices.length, 2);
  assert.equal(second.deviceCodeExpiresAt, null);
  const secondId = second.devices.find((d) => d.current).id;
  assert.equal(
    (await request("/connect-device", null, { code: code.code })).status,
    400,
  );
  const partner = (await request("/state", b)).data;
  assert.equal(partner.devices.length, 1);
  assert.notEqual(partner.devices[0].id, secondId);
  assert.equal(
    (await request(`/devices/${secondId}/revoke`, b, {})).status,
    404,
  );
  assert.equal(
    (await request(`/devices/${secondId}/revoke`, a2, {})).status,
    400,
  );
  assert.equal(
    (await request("/device-name", a2, { label: "Новый планшет" })).status,
    200,
  );
  assert.equal((await request("/device-name", a2, { label: "" })).status, 400);
  assert.equal(
    (await request("/state", a)).data.devices.find((d) => d.id === secondId)
      .label,
    "Новый планшет",
  );
  const pending = (await request("/device-code", a, {})).data;
  await request("/device-code/cancel", a, {});
  assert.equal(
    (await request("/connect-device", null, { code: pending.code })).status,
    400,
  );
  await request(`/devices/${secondId}/revoke`, a, {});
  assert.equal((await request("/state", a2)).status, 401);
  assert.equal((await request("/state", a)).status, 200);
  const another = (await request("/device-code", a, {})).data;
  const a3 = (await request("/connect-device", null, { code: another.code }))
    .data.token;
  const outstanding = (await request("/device-code", a, {})).data;
  const recovered = (
    await request("/recover", null, {
      code: original.recoveryCode,
      deviceLabel: "После восстановления",
    })
  ).data;
  assert.ok(recovered.token);
  assert.equal((await request("/state", a)).status, 401);
  assert.equal((await request("/state", a3)).status, 401);
  assert.equal(
    (await request("/connect-device", null, { code: outstanding.code })).status,
    400,
  );
  const restored = (await request("/state", recovered.token)).data;
  assert.equal(restored.devices.length, 1);
  assert.equal(restored.devices[0].label, "После восстановления");
  assert.equal(restored.me, before.me);
  assert.equal((await request("/state", b)).status, 200);
  const exported = (await request("/export", recovered.token)).data;
  assert.equal(exported.devices.length, 1);
  assert.equal("id" in exported.devices[0], false);
  assert.equal("token" in exported.devices[0], false);
  await request("/logout", recovered.token, {});
  assert.equal((await request("/state", recovered.token)).status, 401);
});

test("API: two devices of one profile cannot count as two people or approve for a partner", async () => {
  const a = (
    await request("/register", null, { name: "Один человек", consent: true })
  ).data.token;
  const state = (await request("/state", a)).data;
  const b = (
    await request("/join", null, {
      name: "Другой человек",
      consent: true,
      invite: state.invite,
    })
  ).data.token;
  const code = (await request("/device-code", a, {})).data.code;
  const a2 = (await request("/connect-device", null, { code })).data.token;
  const sid = (await request("/start", a, { lesson: "bank", mode: "remote" }))
    .data.id;
  await request(`/session/${sid}/answer`, a, { choice: 0 });
  await request(`/session/${sid}/answer`, a2, { choice: 1 });
  const waiting = (await request("/state", b)).data.sessions[0];
  assert.equal(waiting.answered.length, 1);
  assert.equal(waiting.revealed, 0);
  await request(`/session/${sid}/answer`, b, { choice: 2 });
  await request(`/session/${sid}/propose`, a, {
    text: "Проверяем независимо",
    revision: 0,
  });
  await request(`/session/${sid}/approve`, a2, { revision: 1 });
  assert.equal((await request("/state", a)).data.agreements.length, 0);
  await request(`/session/${sid}/approve`, b, { revision: 1 });
  assert.equal((await request("/state", a)).data.agreements.length, 1);
});

test("API: connection attempts are limited without revealing names or session tokens", async () => {
  let response;
  for (let i = 0; i < 11; i++)
    response = await request("/connect-device", null, { code: "not-a-code" });
  assert.equal(response.status, 429);
  assert.ok(Number(response.headers.get("Retry-After")) > 0);
  assert.equal(Object.keys(response.data).join(","), "error");
});
