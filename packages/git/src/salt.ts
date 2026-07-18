import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { err, IrohaError, ok, type RandomSource, type Result } from "@iroha/domain";

const SALT_BYTES = 32;
const LOCAL_CONFIG_FILE = "local-config.json";

function encodeBase64Url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString("base64url");
}

function decodeBase64Url(value: string): Uint8Array | undefined {
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === SALT_BYTES ? new Uint8Array(decoded) : undefined;
}

/**
 * A missing file is the only condition treated as an empty config — any
 * other read failure (malformed JSON, permission denied, ...) propagates,
 * so `ensureRepositorySalt` reports an error instead of silently minting a
 * new salt (and discarding whatever else was in the file) on top of state
 * it could not actually verify was absent.
 */
async function readLocalConfig(configPath: string): Promise<Record<string, unknown>> {
  let raw: string;
  try {
    raw = await readFile(configPath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return {};
    }
    throw cause;
  }
  const parsed: unknown = JSON.parse(raw);
  return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
}

async function writeLocalConfig(
  irohaDir: string,
  configPath: string,
  content: Record<string, unknown>,
): Promise<void> {
  await mkdir(irohaDir, { recursive: true });
  const tempPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  // mode 0o600: this file holds the HMAC repository salt, so it must not be
  // left world-readable under the OS default umask (rename() carries the
  // temp file's mode over on POSIX, so setting it here is sufficient).
  await writeFile(tempPath, `${JSON.stringify(content, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  await rename(tempPath, configPath);
}

/**
 * Ensures a per-repository HMAC salt exists under `<git-path iroha>/local-
 * config.json` (local-only, never committed — see design.md §6 "Local
 * data") and returns it. Hook adapters key prompt/tool digests with this
 * salt (hooks-contract.md §5, "repository-keyed HMAC-SHA-256") so digests
 * stay comparable across sessions on this machine. Unrelated fields already
 * present in the file are preserved.
 */
export async function ensureRepositorySalt(
  irohaDir: string,
  random: RandomSource,
): Promise<Result<Uint8Array, IrohaError>> {
  const configPath = join(irohaDir, LOCAL_CONFIG_FILE);
  try {
    const existing = await readLocalConfig(configPath);
    if (Object.hasOwn(existing, "repositorySalt")) {
      const existingSalt =
        typeof existing.repositorySalt === "string"
          ? decodeBase64Url(existing.repositorySalt)
          : undefined;
      if (existingSalt) {
        return ok(existingSalt);
      }
      // A present-but-undecodable salt (wrong length, malformed base64url,
      // wrong type, ...) must not be silently replaced: minting a new one
      // here would fork future prompt/tool digests from rows already
      // written with the old key, with no error to signal that the local
      // HMAC keyspace just changed underneath already-persisted data.
      return err(
        new IrohaError("INTERNAL_ERROR", `Invalid repositorySalt in ${LOCAL_CONFIG_FILE}`),
      );
    }

    const salt = random.bytes(SALT_BYTES);
    await writeLocalConfig(irohaDir, configPath, {
      ...existing,
      repositorySalt: encodeBase64Url(salt),
    });
    return ok(salt);
  } catch (cause) {
    // No `irohaDir` in message or details: mcp-contract.md §8 forbids
    // returning filesystem absolute paths to the model, and this error can
    // reach an MCP response as-is.
    return err(
      new IrohaError("INTERNAL_ERROR", `Failed to read or write ${LOCAL_CONFIG_FILE}`, { cause }),
    );
  }
}
