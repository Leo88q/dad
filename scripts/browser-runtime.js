import chromium from "@sparticuz/chromium";
import { brotliDecompressSync } from "node:zlib";
import { readFileSync, writeFileSync, mkdirSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, resolve, join } from "node:path";
import { tmpdir } from "node:os";

// The npm package includes Chromium and its runtime libraries. No browser/CDN
// download is needed. Tests use normal web security, not Lambda's unsafe flags.
export async function browserRuntime() {
  const packageRoot = resolve(
    dirname(fileURLToPath(import.meta.resolve("@sparticuz/chromium"))),
    "../..",
  );
  const dir = join(tmpdir(), "ryadom-chromium-143");
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (!existsSync(join(dir, "lib", "libnspr4.so"))) {
    const archive = join(dir, "runtime.tar");
    writeFileSync(
      archive,
      brotliDecompressSync(
        readFileSync(join(packageRoot, "bin", "al2023.tar.br")),
      ),
    );
    execFileSync("tar", ["xf", archive, "-C", dir]);
  }
  return {
    executablePath: await chromium.executablePath(),
    args: ["--no-sandbox", "--disable-dev-shm-usage", "--no-zygote"],
    env: {
      ...process.env,
      LD_LIBRARY_PATH: [join(dir, "lib"), process.env.LD_LIBRARY_PATH]
        .filter(Boolean)
        .join(":"),
    },
  };
}
