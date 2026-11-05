import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { persistentRateLimiter, networkIdentity } from "../lib/rate-limit.js";

async function workspace(fn) {
  const dir = mkdtempSync(join(tmpdir(), "ryadom-limits-"));
  try {
    await fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}
test("network quotas normalize mapped IPv4, equivalent IPv6 and rotating IPv6 addresses in a /64", () => {
  assert.equal(networkIdentity("::ffff:192.0.2.1"), "192.0.2.1");
  assert.equal(networkIdentity("::ffff:c000:201"), "192.0.2.1");
  assert.equal(
    networkIdentity("2001:db8:1:2::1"),
    networkIdentity("2001:0db8:0001:0002:ffff::2"),
  );
  assert.notEqual(
    networkIdentity("2001:db8:1:2::1"),
    networkIdentity("2001:db8:1:3::1"),
  );
  assert.equal(networkIdentity("not an ip"), "unknown");
});
test("quotas persist after close/reopen with exact expiry, bounded retry and separate action scope", async () =>
  workspace(async (dir) => {
    const file = join(dir, "security.sqlite");
    let store = persistentRateLimiter(file);
    const policy = { limit: 2, windowMs: 60000, now: 100000 };
    assert.equal(store.take("api", "192.0.2.1", policy).allowed, true);
    assert.equal(store.take("api", "::ffff:192.0.2.1", policy).allowed, true);
    store.close();
    store = persistentRateLimiter(file);
    try {
      const blocked = store.take("api", "192.0.2.1", {
        ...policy,
        now: 100001,
      });
      assert.equal(blocked.allowed, false);
      assert.equal(blocked.retryAfter, 60);
      assert.equal(store.take("recover", "192.0.2.1", policy).allowed, true);
      assert.equal(store.take("api", "192.0.2.2", policy).allowed, true);
      assert.equal(
        store.take("api", "192.0.2.1", { ...policy, now: 160000 }).allowed,
        true,
      );
      assert.throws(
        () => store.take("api", "192.0.2.1", { limit: 0, windowMs: 1000 }),
        /policy/,
      );
    } finally {
      store.close();
    }
    assert.equal(statSync(file).mode & 0o777, 0o600);
    const db = new DatabaseSync(file, { readOnly: true });
    try {
      const rows = db.prepare("SELECT * FROM rate_limits").all();
      assert.ok(rows.every((r) => /^[a-f0-9]{64}$/.test(r.key)));
      assert.deepEqual(
        db
          .prepare("PRAGMA table_info(rate_limits)")
          .all()
          .map((c) => c.name),
        ["key", "count", "expires"],
      );
    } finally {
      db.close();
    }
  }));
test("capacity fails closed without evicting active quotas and expired records are reclaimed", async () =>
  workspace(async (dir) => {
    const store = persistentRateLimiter(join(dir, "limits"), { maxEntries: 2 }),
      p = { limit: 2, windowMs: 1000, now: 100000 };
    try {
      store.take("api", "192.0.2.1", p);
      store.take("api", "192.0.2.2", p);
      assert.deepEqual(store.take("api", "192.0.2.3", p), {
        allowed: false,
        capacity: true,
        retryAfter: 60,
      });
      assert.equal(store.take("api", "192.0.2.1", p).allowed, true);
      assert.equal(store.take("api", "192.0.2.1", p).allowed, false);
      assert.equal(
        store.take("api", "192.0.2.3", { ...p, now: 161000 }).allowed,
        true,
      );
    } finally {
      store.close();
    }
  }));
function childResult(child) {
  return new Promise((resolve, reject) => {
    let text = "",
      err = "";
    child.stdout.on("data", (x) => (text += x));
    child.stderr.on("data", (x) => (err += x));
    child.once("error", reject);
    child.once("exit", (code) =>
      code === 0 ? resolve(text) : reject(new Error(err)),
    );
  });
}
test("two independent processes share one atomic quota without lost increments", async () =>
  workspace(async (dir) => {
    const file = join(dir, "security.sqlite");
    persistentRateLimiter(file).close();
    const code = `import {persistentRateLimiter} from ${JSON.stringify("file://" + resolve("lib/rate-limit.js"))};const s=persistentRateLimiter(process.argv[1]);let n=0;for(let i=0;i<30;i++)if(s.take('api','192.0.2.1',{limit:25,windowMs:60000}).allowed)n++;s.close();console.log(n);`;
    const launch = () =>
      spawn(process.execPath, ["--input-type=module", "-e", code, file], {
        stdio: ["ignore", "pipe", "pipe"],
      });
    const results = await Promise.all([
      childResult(launch()),
      childResult(launch()),
    ]);
    assert.equal(
      results.reduce((n, s) => n + Number(s.trim()), 0),
      25,
    );
  }));
async function start(dir) {
  const child = spawn(process.execPath, ["server.js"], {
    env: {
      ...process.env,
      PORT: "3235",
      NODE_ENV: "test",
      DATA_DIR: dir,
      TRUST_PROXY: "",
      MAX_ONLY: "false",
      MAX_BOT_TOKEN: "",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    let text = "";
    const timer = setTimeout(
      () => reject(new Error("Server start timeout")),
      8000,
    );
    child.stdout.on("data", (x) => {
      text += x;
      if (text.includes("http://")) {
        clearTimeout(timer);
        resolve();
      }
    });
    child.once("error", reject);
    child.once("exit", () => {
      clearTimeout(timer);
      reject(new Error("Server exited"));
    });
  });
  return child;
}
async function stop(child) {
  const exited = once(child, "exit");
  child.kill("SIGTERM");
  await exited;
}
test(
  "HTTP limits survive actual server restart, ignore forged forwarding headers and return Retry-After",
  { timeout: 20000 },
  async () =>
    workspace(async (dir) => {
      let child = await start(dir);
      const request = (path, headers = {}) =>
        fetch("http://127.0.0.1:3235/api" + path, {
          method: "POST",
          headers: { "Content-Type": "application/json", ...headers },
          body: JSON.stringify({ code: "invalid" }),
        });
      try {
        const upperCase = await fetch("http://127.0.0.1:3235/API/recover", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: "invalid" }),
        });
        assert.equal(
          upperCase.status,
          404,
          "Uppercase aliases must not bypass protected API paths",
        );
        for (let i = 0; i < 5; i++)
          assert.equal(
            (
              await request("/recover", {
                "X-Forwarded-For": `192.0.2.${i + 1}`,
              })
            ).status,
            400,
          );
        let result = await request("/recover", {
          "X-Forwarded-For": "203.0.113.1",
        });
        assert.equal(result.status, 429);
        assert.ok(Number(result.headers.get("retry-after")) > 0);
        await stop(child);
        child = await start(dir);
        result = await request("/recover");
        assert.equal(result.status, 429);
        assert.ok(Number(result.headers.get("retry-after")) <= 900);
        for (let i = 0; i < 10; i++)
          assert.equal((await request("/connect-device")).status, 400);
        assert.equal((await request("/connect-device")).status, 429);
        let successes = 0;
        for (let i = 0; i < 181; i++) {
          result = await fetch("http://127.0.0.1:3235/api/runtime-config");
          if (result.status === 429) break;
          assert.equal(result.status, 200);
          successes++;
        }
        assert.equal(successes, 162);
        assert.equal(result.status, 429);
        assert.ok(Number(result.headers.get("retry-after")) <= 60);
      } finally {
        await stop(child);
      }
    }),
);

test(
  "unavailable quota writes fail closed with HTTP 503 and recover without consuming an attempt",
  { timeout: 15000 },
  async () =>
    workspace(async (dir) => {
      const child = await start(dir);
      const lock = new DatabaseSync(join(dir, "security.sqlite"));
      try {
        lock.exec("BEGIN IMMEDIATE");
        const response = await fetch("http://127.0.0.1:3235/api/recover", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: "invalid" }),
        });
        assert.equal(response.status, 503);
        assert.equal(response.headers.get("retry-after"), "60");
        assert.match((await response.json()).error, /недоступна/);
        lock.exec("ROLLBACK");
        const next = await fetch("http://127.0.0.1:3235/api/recover", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ code: "invalid" }),
        });
        assert.equal(next.status, 400);
      } finally {
        if (lock.isTransaction) lock.exec("ROLLBACK");
        lock.close();
        await stop(child);
      }
    }),
);
