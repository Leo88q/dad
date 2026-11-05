import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performance } from "node:perf_hooks";

// Isolated local smoke load; never writes into the application's real database.
const dir = mkdtempSync(join(tmpdir(), "ryadom-load-"));
const port = "3223",
  durations = [];
let server,
  failures = 0,
  requests = 0;
async function api(path, token, body) {
  const start = performance.now();
  const response = await fetch(`http://127.0.0.1:${port}/api${path}`, {
    method: body ? "POST" : "GET",
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: "Bearer " + token } : {}),
    },
    ...(body ? { body: JSON.stringify(body) } : {}),
    signal: AbortSignal.timeout(5000),
  });
  durations.push(performance.now() - start);
  requests++;
  if (!response.ok) throw new Error(`${path}: HTTP ${response.status}`);
  return response.json();
}
async function pair(i) {
  const a = (await api("/register", null, { name: `Пара ${i}`, consent: true }))
    .token;
  const invite = (await api("/state", a)).invite;
  const b = (
    await api("/join", null, { name: `Близкий ${i}`, consent: true, invite })
  ).token;
  const sid = (await api("/start", a, { lesson: "bank", mode: "remote" })).id;
  await Promise.all([
    api(`/session/${sid}/answer`, a, { choice: 0 }),
    api(`/session/${sid}/answer`, b, { choice: 1 }),
  ]);
  await api(`/session/${sid}/propose`, a, {
    text: `Проверяем просьбу ${i}`,
    revision: 0,
  });
  await api(`/session/${sid}/approve`, b, { revision: 1 });
  const states = await Promise.all([api("/state", a), api("/state", b)]);
  if (
    states.some(
      (s) =>
        s.agreements.length !== 1 ||
        s.agreements[0].text !== `Проверяем просьбу ${i}` ||
        !s.sessions[0].finished,
    )
  )
    throw new Error("Нарушена изоляция или потеряно завершение занятия");
}
try {
  server = spawn(process.execPath, ["server.js"], {
    env: { ...process.env, DATA_DIR: dir, PORT: port },
    stdio: ["ignore", "pipe", "pipe"],
  });
  await new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(Error("Startup timeout")), 10000);
    server.stdout.once("data", () => {
      clearTimeout(t);
      resolve();
    });
    server.once("error", reject);
    server.once("exit", (code) => {
      clearTimeout(t);
      reject(Error(`Server exited: ${code}`));
    });
  });
  const start = performance.now();
  for (let batch = 0; batch < 4; batch++)
    await Promise.all(
      Array.from({ length: 3 }, (_, j) =>
        pair(batch * 3 + j).catch((err) => {
          failures++;
          console.error(err.message);
        }),
      ),
    );
  durations.sort((a, b) => a - b);
  const percentile = (p) =>
    Math.round(
      durations[
        Math.min(durations.length - 1, Math.floor(durations.length * p))
      ] || 0,
    );
  console.log(
    JSON.stringify(
      {
        ok: failures === 0,
        pairs: 12,
        concurrentPairs: 3,
        requests,
        failedPairs: failures,
        durationMs: Math.round(performance.now() - start),
        latencyMs: {
          p50: percentile(0.5),
          p95: percentile(0.95),
          max: percentile(1),
        },
      },
      null,
      2,
    ),
  );
  if (failures) process.exitCode = 1;
} catch (err) {
  console.error(err.message);
  process.exitCode = 1;
} finally {
  if (server && server.exitCode === null)
    await new Promise((resolve) => {
      server.once("exit", resolve);
      server.kill();
    });
  rmSync(dir, { recursive: true, force: true });
}
