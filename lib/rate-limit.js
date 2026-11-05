import { DatabaseSync } from "node:sqlite";
import { randomBytes, createHmac } from "node:crypto";
import { chmodSync } from "node:fs";
import { isIP } from "node:net";

// One quota for IPv4 and its IPv4-mapped IPv6 representation; group IPv6 /64.
export function networkIdentity(address) {
  if (typeof address !== "string" || !isIP(address)) return "unknown";
  if (isIP(address) === 4) return address;
  const normalized = new URL(
    `http://[${address.split("%")[0]}]/`,
  ).hostname.slice(1, -1);
  const [left, right] = normalized.split("::");
  const a = left ? left.split(":") : [],
    b = right ? right.split(":") : [];
  const words =
    right === undefined
      ? a
      : [...a, ...Array(8 - a.length - b.length).fill("0"), ...b];
  const n = words.map((w) => parseInt(w, 16));
  if (n.slice(0, 5).every((w) => w === 0) && n[5] === 65535)
    return `${n[6] >> 8}.${n[6] & 255}.${n[7] >> 8}.${n[7] & 255}`;
  return (
    n
      .slice(0, 4)
      .map((w) => w.toString(16))
      .join(":") + "/64"
  );
}

export function persistentRateLimiter(file, { maxEntries = 50000 } = {}) {
  if (!Number.isInteger(maxEntries) || maxEntries < 1)
    throw new Error("Invalid limiter capacity");
  const db = new DatabaseSync(file);
  try {
    if (file !== ":memory:") chmodSync(file, 0o600);
    db.exec(`PRAGMA busy_timeout=5000; PRAGMA journal_mode=WAL;
      CREATE TABLE IF NOT EXISTS limiter_secret(id INTEGER PRIMARY KEY CHECK(id=1), value BLOB NOT NULL);
      CREATE TABLE IF NOT EXISTS rate_limits(key TEXT PRIMARY KEY, count INTEGER NOT NULL, expires INTEGER NOT NULL);
      CREATE INDEX IF NOT EXISTS rate_limits_expiry ON rate_limits(expires);`);
    db.prepare("INSERT OR IGNORE INTO limiter_secret VALUES(1,?)").run(
      randomBytes(32),
    );
  } catch (err) {
    db.close();
    throw err;
  }
  const secret = Buffer.from(
    db.prepare("SELECT value FROM limiter_secret WHERE id=1").get().value,
  );
  const get = db.prepare("SELECT count,expires FROM rate_limits WHERE key=?");
  const put = db.prepare(
    "INSERT INTO rate_limits VALUES(?,?,?) ON CONFLICT(key) DO UPDATE SET count=excluded.count,expires=excluded.expires",
  );
  const prune = db.prepare("DELETE FROM rate_limits WHERE expires<=?");
  let lastPruned = 0;
  return {
    take(scope, address, { limit, windowMs, now = Date.now() }) {
      if (
        !Number.isSafeInteger(limit) ||
        limit < 1 ||
        !Number.isSafeInteger(windowMs) ||
        windowMs < 1 ||
        !Number.isSafeInteger(now) ||
        now < 0 ||
        typeof scope !== "string" ||
        !scope.length ||
        scope.length > 64
      )
        throw new Error("Invalid limiter policy");
      const key = createHmac("sha256", secret)
        .update(scope + "\0" + networkIdentity(address))
        .digest("hex");
      db.exec("BEGIN IMMEDIATE");
      try {
        if (now - lastPruned >= 60000 || now < lastPruned) {
          prune.run(now);
          lastPruned = now;
        }
        let row = get.get(key);
        if (row && row.expires <= now) row = null;
        if (!row) {
          // Capacity denial is fail-closed and never evicts somebody else's active quota.
          if (
            db.prepare("SELECT count(*) n FROM rate_limits").get().n >=
            maxEntries
          ) {
            db.exec("COMMIT");
            return { allowed: false, capacity: true, retryAfter: 60 };
          }
          row = { count: 1, expires: now + windowMs };
          put.run(key, row.count, row.expires);
        } else if (row.count >= limit) {
          db.exec("COMMIT");
          return {
            allowed: false,
            capacity: false,
            retryAfter: Math.max(1, Math.ceil((row.expires - now) / 1000)),
          };
        } else {
          row.count++;
          put.run(key, row.count, row.expires);
        }
        db.exec("COMMIT");
        return {
          allowed: true,
          remaining: limit - row.count,
          retryAfter: Math.max(1, Math.ceil((row.expires - now) / 1000)),
        };
      } catch (err) {
        db.exec("ROLLBACK");
        throw err;
      }
    },
    healthy() {
      return db.prepare("SELECT 1 AS ok").get().ok === 1;
    },
    close() {
      secret.fill(0);
      db.close();
    },
  };
}
