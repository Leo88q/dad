import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer, request } from "node:http";
import { connect, createServer as createTcpServer } from "node:net";
import { once } from "node:events";
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { spawn, spawnSync } from "node:child_process";

const binary = process.env.NGINX_BIN;
if (!binary) throw new Error("Run npm run test:edge (or supply NGINX_BIN)");
async function fixture(fn) {
  const dir = mkdtempSync(join(tmpdir(), "ryadom-edge-"));
  let hits = 0;
  const upstream = createServer((req, res) => {
    hits++;
    const answer = () => {
      res.setHeader("Content-Type", "application/json");
      res.end(
        JSON.stringify({
          source: req.headers["x-forwarded-for"],
          real: req.headers["x-real-ip"],
        }),
      );
    };
    if (req.url === "/slow") setTimeout(answer, 1200);
    else answer();
  });
  upstream.listen(0, "127.0.0.1");
  await once(upstream, "listening");
  const free = createTcpServer();
  free.listen(0, "127.0.0.1");
  await once(free, "listening");
  const port = free.address().port;
  await new Promise((r) => free.close(r));
  mkdirSync(join(dir, "logs"));
  mkdirSync(join(dir, "errors"));
  for (const file of readdirSync("deploy/nginx"))
    if (file.endsWith(".conf")) {
      let text = readFileSync(join("deploy/nginx", file), "utf8")
        .replaceAll("/etc/nginx", dir)
        .replaceAll("/tmp/nginx", join(dir, "nginx"))
        .replaceAll("/dev/stdout", join(dir, "access.log"));
      text = text
        .replace(
          "server app:3000;",
          `server 127.0.0.1:${upstream.address().port};`,
        )
        .replace("listen 8080;", `listen 127.0.0.1:${port};`)
        .replace(
          "set_real_ip_from 172.28.0.0/24;",
          "set_real_ip_from 127.0.0.2;",
        );
      if (file === "nginx.conf" && process.getuid?.() === 0)
        text = "user root;\n" + text; // test-only root runner; production runs UID 101.
      writeFileSync(join(dir, file), text);
    }
  for (const file of readdirSync("deploy/nginx/errors"))
    writeFileSync(
      join(dir, "errors", file),
      readFileSync(join("deploy/nginx/errors", file)),
    );
  writeFileSync(
    join(dir, "health.json"),
    readFileSync("deploy/nginx/health.json"),
  );
  const args = ["-p", dir + "/", "-c", join(dir, "nginx.conf")];
  const syntax = spawnSync(binary, [...args, "-t"], { encoding: "utf8" });
  if (syntax.status !== 0) {
    await new Promise((r) => upstream.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
  assert.equal(syntax.status, 0, syntax.stderr);
  const edge = spawn(binary, [...args, "-g", "daemon off;"], {
    stdio: ["ignore", "pipe", "pipe"],
  });
  let logs = "";
  edge.stdout.on("data", (x) => (logs += x));
  edge.stderr.on("data", (x) => (logs += x));
  async function call(
    path = "/",
    { source, proxy = false, body, method = body ? "POST" : "GET" } = {},
  ) {
    return new Promise((resolve, reject) => {
      const req = request(
        {
          hostname: "127.0.0.1",
          port,
          path,
          method,
          agent: false,
          localAddress: proxy ? "127.0.0.2" : "127.0.0.1",
          headers: {
            ...(source ? { "X-Forwarded-For": source } : {}),
            ...(body
              ? {
                  "Content-Length": Buffer.byteLength(body),
                  "Content-Type": "application/json",
                }
              : {}),
          },
        },
        (res) => {
          let text = "";
          res.on("data", (x) => (text += x));
          res.on("end", () =>
            resolve({ status: res.statusCode, headers: res.headers, text }),
          );
        },
      );
      req.on("error", reject);
      req.end(body);
    });
  }
  try {
    // Real TCP readiness, bounded retry; no sleeping blind startup timeout.
    const end = Date.now() + 5000;
    while (true) {
      try {
        await new Promise((resolve, reject) => {
          const s = connect(port, "127.0.0.1");
          s.once("connect", () => {
            s.destroy();
            resolve();
          });
          s.once("error", reject);
        });
        break;
      } catch (err) {
        if (Date.now() > end) throw new Error(logs);
        await new Promise((r) => setTimeout(r, 20));
      }
    }
    await fn({
      call,
      get hits() {
        return hits;
      },
      port,
    });
  } finally {
    if (edge.exitCode === null) {
      const exited = once(edge, "exit");
      edge.kill("SIGQUIT");
      await exited;
    }
    upstream.closeAllConnections();
    await new Promise((r) => upstream.close(r));
    rmSync(dir, { recursive: true, force: true });
  }
}
test("real nginx forwards ordinary traffic, but trusts only the configured proxy source", async () =>
  fixture(async (f) => {
    let r = await f.call("/api/state", { source: "198.51.100.1" });
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.text).source, "127.0.0.1");
    r = await f.call("/api/state", { source: "198.51.100.1", proxy: true });
    assert.equal(JSON.parse(r.text).source, "198.51.100.1");
    assert.equal(JSON.parse(r.text).real, "198.51.100.1");
    r = await f.call("/edge-health");
    assert.equal(r.status, 200);
    assert.equal(JSON.parse(r.text).component, "edge");
    assert.equal(f.hits, 2);
  }));
test("oversized request is rejected as JSON before application receives it", async () =>
  fixture(async (f) => {
    const r = await f.call("/api/max/auth", { body: "x".repeat(40000) });
    assert.equal(r.status, 413);
    assert.equal(r.headers["x-ryadom-protection"], "edge-body");
    assert.ok(JSON.parse(r.text).error);
    assert.equal(f.hits, 0);
  }));
test("per-source API flood cannot bypass quotas by forging X-Forwarded-For", async () =>
  fixture(async (f) => {
    const results = [];
    for (let batch = 0; batch < 14; batch++)
      results.push(
        ...(await Promise.all(
          Array.from({ length: 5 }, (_, i) =>
            f.call("/api/state", { source: `198.51.100.${batch * 5 + i + 1}` }),
          ),
        )),
      );
    const denied = results.filter((r) => r.status === 429);
    assert.ok(denied.length > 20);
    assert.ok(f.hits < 40);
    assert.ok(
      denied.every(
        (r) =>
          r.headers["x-ryadom-protection"] === "edge-rate" &&
          Number(r.headers["retry-after"]) > 0 &&
          JSON.parse(r.text).error,
      ),
    );
  }));
test("aggregate API quota limits a distributed HTTP burst, not only one source", async () =>
  fixture(async (f) => {
    const results = await Promise.all(
      Array.from({ length: 120 }, (_, i) =>
        f.call("/api/state", { source: `198.51.100.${i + 1}`, proxy: true }),
      ),
    );
    assert.ok(results.some((r) => r.status === 429));
    assert.ok(f.hits < 100, "Distributed burst must not all reach Node");
  }));
test("authentication quota also covers trailing-slash variants", async () =>
  fixture(async (f) => {
    const results = [];
    for (let i = 0; i < 17; i++)
      results.push(await f.call(i % 2 ? "/api/max/auth/" : "/api/max/auth"));
    assert.ok(results.some((r) => r.status === 429));
    assert.ok(f.hits <= 12);
  }));
test("concurrent slow responses are bounded before the application", async () =>
  fixture(async (f) => {
    const results = await Promise.all(
      Array.from({ length: 28 }, () => f.call("/slow")),
    );
    const denied = results.filter((r) => r.status === 503);
    assert.ok(denied.length >= 8);
    assert.ok(f.hits <= 20);
    assert.ok(
      denied.every(
        (r) =>
          r.headers["x-ryadom-protection"] === "edge-capacity" &&
          Number(r.headers["retry-after"]) > 0,
      ),
    );
  }));
test(
  "incomplete slow headers time out without reaching application",
  { timeout: 10000 },
  async () =>
    fixture(async (f) => {
      const start = Date.now(),
        socket = connect(f.port, "127.0.0.1");
      let response = "";
      socket.on("data", (x) => (response += x));
      await once(socket, "connect");
      socket.write("GET / HTTP/1.1\r\nHost: localhost\r\nX-Slow: ");
      socket.on("error", (err) => {
        if (err.code !== "ECONNRESET") throw err;
      });
      await new Promise((r) => socket.once("close", r));
      assert.ok(Date.now() - start >= 4500);
      assert.ok(Date.now() - start < 8000);
      assert.ok(!response || response.includes("408"));
      assert.equal(f.hits, 0);
    }),
);
