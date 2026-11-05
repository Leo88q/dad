import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
} from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import {
  mkdir,
  mkdtemp,
  readFile,
  writeFile,
  stat,
  open,
  link,
  unlink,
  rm,
  readdir,
} from "node:fs/promises";
import { pipeline } from "node:stream/promises";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";
import { DatabaseSync, backup } from "node:sqlite";

const magic = Buffer.from("RYADOM01");
const archiveName = /^ryadom-\d{13}-[a-f0-9]{16}\.sqlite\.enc$/;
export async function loadBackupKey(file) {
  if (!file) throw new Error("BACKUP_KEY_FILE is required");
  const s = await stat(file);
  if (!s.isFile() || s.mode & 0o077)
    throw new Error("Backup key must be a private regular file (0600 or 0400)");
  const text = (await readFile(file, "utf8")).trim();
  if (!/^[a-f0-9]{64}$/i.test(text))
    throw new Error(
      "Backup key must contain exactly 64 hexadecimal characters",
    );
  return Buffer.from(text, "hex");
}
async function exclusivePublish(scratch, target) {
  // Same filesystem; no replacement of existing archives or concurrent output.
  await link(scratch, target);
  await unlink(scratch);
}
export async function encryptBackup(source, target, key) {
  const scratch = target + "." + randomBytes(8).toString("hex") + ".partial";
  const nonce = randomBytes(12),
    cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(magic);
  try {
    await writeFile(scratch, Buffer.concat([magic, nonce]), {
      mode: 0o600,
      flag: "wx",
    });
    await pipeline(
      createReadStream(source),
      cipher,
      createWriteStream(scratch, { flags: "a" }),
    );
    const fd = await open(scratch, "a");
    try {
      await fd.write(cipher.getAuthTag());
      await fd.sync();
    } finally {
      await fd.close();
    }
    await exclusivePublish(scratch, target);
  } finally {
    await rm(scratch, { force: true });
  }
}
export async function decryptBackup(source, target, key) {
  const scratch = target + "." + randomBytes(8).toString("hex") + ".partial";
  const fd = await open(source, "r");
  try {
    const size = (await fd.stat()).size;
    if (size < 36) throw new Error("Encrypted archive is truncated");
    const header = Buffer.alloc(20),
      tag = Buffer.alloc(16);
    await fd.read(header, 0, 20, 0);
    await fd.read(tag, 0, 16, size - 16);
    if (!header.subarray(0, 8).equals(magic))
      throw new Error("Unknown backup format");
    const cipher = createDecipheriv("aes-256-gcm", key, header.subarray(8));
    cipher.setAAD(magic);
    cipher.setAuthTag(tag);
    // Unauthenticated plaintext stays private and unpublished until final() succeeds.
    await pipeline(
      createReadStream(source, {
        fd: fd.fd,
        autoClose: false,
        start: 20,
        end: size - 17,
      }),
      cipher,
      createWriteStream(scratch, { flags: "wx", mode: 0o600 }),
    );
    const out = await open(scratch, "r+");
    try {
      await out.sync();
    } finally {
      await out.close();
    }
    await exclusivePublish(scratch, target);
  } finally {
    await fd.close();
    await rm(scratch, { force: true });
  }
}
export async function digestFile(file) {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk);
  return hash.digest("hex");
}
function verifyDatabase(file) {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    if (
      db.prepare("PRAGMA integrity_check").get().integrity_check !== "ok" ||
      db.prepare("PRAGMA foreign_key_check").all().length
    )
      throw new Error("Backup database integrity check failed");
    for (const table of ["members", "families", "sessions", "agreements"]) {
      if (
        !db
          .prepare(
            "SELECT name FROM sqlite_master WHERE type='table' AND name=?",
          )
          .get(table)
      )
        throw new Error("Backup is missing required application tables");
    }
  } finally {
    db.close();
  }
}
async function runEncryptedBackup({ dataDir, archiveDir, keyFile, keep = 56 }) {
  if (!Number.isInteger(keep) || keep < 1 || keep > 3650)
    throw new Error("Backup retention must be an integer from 1 to 3650");
  const key = await loadBackupKey(keyFile);
  const dir = resolve(archiveDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const scratch = await mkdtemp(join(tmpdir(), "ryadom-encrypted-backup-"));
  const snapshot = join(scratch, "snapshot.sqlite"),
    check = join(scratch, "verified.sqlite");
  const name = `ryadom-${Date.now()}-${randomBytes(8).toString("hex")}.sqlite.enc`,
    target = join(dir, name);
  let source,
    published = false,
    verified = false;
  try {
    source = new DatabaseSync(join(resolve(dataDir), "ryadom.sqlite"), {
      readOnly: true,
    });
    await backup(source, snapshot);
    source.close();
    source = null;
    verifyDatabase(snapshot);
    await encryptBackup(snapshot, target, key);
    published = true;
    await decryptBackup(target, check, key);
    verifyDatabase(check);
    if ((await digestFile(snapshot)) !== (await digestFile(check)))
      throw new Error("Backup round-trip mismatch");
    verified = true;
    const digest = await digestFile(target);
    // Rotate only owned, fully published archive names, only after successful verification.
    const files = (await readdir(dir))
      .filter((n) => archiveName.test(n) && n !== name)
      .sort()
      .reverse();
    for (const old of files.slice(keep - 1)) await unlink(join(dir, old));
    return {
      ok: true,
      archive: name,
      sha256: digest,
      verifiedAt: new Date().toISOString(),
      keep,
    };
  } catch (err) {
    if (published && !verified) await rm(target, { force: true });
    throw err;
  } finally {
    source?.close();
    key.fill(0);
    await rm(scratch, { recursive: true, force: true });
  }
}

export async function createEncryptedBackup(options) {
  const dir = resolve(options.archiveDir);
  await mkdir(dir, { recursive: true, mode: 0o700 });
  const lock = join(dir, ".backup-cycle.lock");
  try {
    await mkdir(lock, { mode: 0o700 });
  } catch (err) {
    if (err.code === "EEXIST")
      throw new Error(
        "Backup cycle is already locked; check for a running worker before removing a stale lock",
      );
    throw err;
  }
  try {
    return await runEncryptedBackup(options);
  } finally {
    await rm(lock, { recursive: true, force: true });
  }
}
