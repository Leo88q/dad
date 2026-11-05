import { test } from "node:test";
import assert from "node:assert/strict";
import { readConfig } from "../lib/config.js";
import { spawn, spawnSync } from "node:child_process";
import { createHmac, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const secret = "production-configuration-test-not-real-bot-token";
const valid = {
  NODE_ENV: "production",
  MAX_ONLY: "true",
  MAX_BOT_TOKEN: secret,
  MAX_BOT_NAME: "RyadomReleaseBot",
  DATA_DIR: "/srv/ryadom/data",
  PUBLIC_URL: "https://ryadom-release-check.ru",
  OPERATOR_NAME: "Оператор тестовой конфигурации",
  SUPPORT_EMAIL: "support@ryadom-release-check.ru",
  PRIVACY_POLICY_URL: "https://ryadom-release-check.ru/privacy",
  TERMS_URL: "https://ryadom-release-check.ru/terms",
  DATA_POLICY_VERSION: "2026-11-04",
};
test("configuration: development stays usable, production requires MAX, persistent path and operator documents", () => {
  assert.equal(readConfig({}).production, false);
  assert.equal(readConfig({}).release, null);
  const parsed = readConfig(valid);
  assert.equal(parsed.production, true);
  assert.equal(parsed.release.policyVersion, "2026-11-04");
  for (const field of Object.keys(valid).filter((key) => key !== "NODE_ENV"))
    assert.throws(
      () => readConfig({ ...valid, [field]: "" }),
      undefined,
      field,
    );
  assert.throws(() => readConfig({ ...valid, DATA_DIR: "./data" }), /DATA_DIR/);
});
test("configuration: production rejects unsafe URLs and placeholder domains without echoing secrets", () => {
  for (const key of ["PUBLIC_URL", "PRIVACY_POLICY_URL", "TERMS_URL"])
    for (const value of [
      "http://host.ru",
      "https://localhost",
      "https://host.invalid",
      "https://example.com",
      "https://host.test",
      "https://127.0.0.1",
      "https://user:pass@host.ru",
      "https://host.ru/#secret",
      "javascript:alert(1)",
    ])
      assert.throws(() => readConfig({ ...valid, [key]: value }));
  assert.throws(
    () => readConfig({ ...valid, PUBLIC_URL: "https://host.ru/app" }),
    /PUBLIC_URL/,
  );
  try {
    readConfig({ ...valid, MAX_ONLY: "false" });
    assert.fail();
  } catch (err) {
    assert.ok(!err.message.includes(secret));
  }
});
test("configuration: operator contacts and consent revisions are validated, not silently substituted", () => {
  for (const value of ["", "x", "Bad\nHeader"])
    assert.throws(() => readConfig({ ...valid, OPERATOR_NAME: value }));
  for (const value of [
    "support",
    "x@example.invalid",
    "x@example.com",
    "X@EXAMPLE.COM",
    "mail\r\n@host.ru",
  ])
    assert.throws(() => readConfig({ ...valid, SUPPORT_EMAIL: value }));
  for (const value of ["", "<script>", "../revision", "a".repeat(65)])
    assert.throws(() => readConfig({ ...valid, DATA_POLICY_VERSION: value }));
  assert.equal(
    readConfig({ ...valid, DATA_POLICY_VERSION: "2026-11-05" }).release
      .policyVersion,
    "2026-11-05",
  );
});
test("preflight validates production even in a development shell and does not print bot secrets", () => {
  const bad = spawnSync(process.execPath, ["scripts/preflight.js"], {
    env: {
      ...process.env,
      NODE_ENV: "development",
      MAX_ONLY: "true",
      MAX_BOT_TOKEN: secret,
      MAX_BOT_NAME: "",
      PUBLIC_URL: "",
      OPERATOR_NAME: "",
    },
    encoding: "utf8",
  });
  assert.equal(bad.status, 1);
  assert.ok(!bad.stderr.includes(secret));
  const good = spawnSync(process.execPath, ["scripts/preflight.js"], {
    env: { ...process.env, ...valid },
    encoding: "utf8",
  });
  assert.equal(good.status, 0);
  assert.equal(JSON.parse(good.stdout).configurationValid, true);
  assert.ok(!good.stdout.includes(secret));
});
function launch() {
  const p = new URLSearchParams({
    query_id: randomUUID(),
    auth_date: String(Math.floor(Date.now() / 1000)),
    user: JSON.stringify({ id: 77201, first_name: "Участник" }),
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
test("production HTTP: readiness, HSTS, public operator metadata, real consent revision and renewal after restart", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ryadom-release-"));
  let child;
  async function start(version) {
    child = spawn(process.execPath, ["server.js"], {
      env: {
        ...process.env,
        ...valid,
        PORT: "3228",
        DATA_DIR: dir,
        DATA_POLICY_VERSION: version,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    await new Promise((resolve, reject) => {
      const timer = setTimeout(
        () => reject(new Error("production startup timeout")),
        10000,
      );
      child.stdout.once("data", () => {
        clearTimeout(timer);
        resolve();
      });
      child.once("error", reject);
      child.once("exit", (code) => {
        if (code !== null && code !== 0) {
          clearTimeout(timer);
          reject(new Error("production server stopped"));
        }
      });
    });
  }
  async function stop() {
    if (child?.exitCode === null)
      await new Promise((resolve) => {
        child.once("exit", resolve);
        child.kill();
      });
  }
  async function req(path, body, token) {
    const r = await fetch("http://127.0.0.1:3228" + path, {
      method: body ? "POST" : "GET",
      headers: {
        "Content-Type": "application/json",
        ...(token ? { Authorization: "Bearer " + token } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    return { status: r.status, headers: r.headers, data: await r.json() };
  }
  try {
    await start("revision-1");
    const ready = await req("/readyz");
    assert.equal(ready.status, 200);
    assert.equal(ready.data.ready, true);
    assert.match(ready.headers.get("strict-transport-security"), /max-age/);
    const pub = await req("/api/runtime-config");
    assert.equal(pub.data.release.operatorName, valid.OPERATOR_NAME);
    assert.equal(pub.data.release.policyVersion, "revision-1");
    assert.ok(!JSON.stringify(pub.data).includes(secret));
    assert.equal(
      (await req("/api/register", { name: "Не MAX", consent: true })).status,
      403,
    );
    const a = await req("/api/max/auth", { initData: launch(), consent: true });
    assert.equal(a.status, 200);
    assert.equal(
      (await req("/api/state", null, a.data.token)).data.consent.version,
      "max-data-revision-1",
    );
    await stop();
    await start("revision-2");
    const old = (await req("/api/state", null, a.data.token)).data;
    assert.equal(old.consent.version, "max-data-revision-1");
    assert.equal(old.consentVersion, "max-data-revision-2");
    const raw = launch();
    assert.equal(
      (await req("/api/max/auth", { initData: raw })).data.needsConsent,
      true,
    );
    const renewed = await req("/api/max/auth", {
      initData: raw,
      consent: true,
    });
    assert.equal(
      (await req("/api/state", null, renewed.data.token)).data.consent.version,
      "max-data-revision-2",
    );
    renameSync(dir, dir + "-temporarily-unavailable");
    try {
      assert.equal((await req("/readyz")).status, 503);
    } finally {
      renameSync(dir + "-temporarily-unavailable", dir);
    }
  } finally {
    await stop();
    rmSync(dir, { recursive: true, force: true });
  }
});
