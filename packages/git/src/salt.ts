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

async function readLocalConfig(configPath: string): Promise<Record<string, unknown>> {
  try {
    const raw = await readFile(configPath, "utf8");
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

async function writeLocalConfig(
  irohaDir: string,
  configPath: string,
  content: Record<string, unknown>,
): Promise<void> {
  await mkdir(irohaDir, { recursive: true });
  const tempPath = `${configPath}.tmp-${process.pid}-${Date.now()}`;
  await writeFile(tempPath, `${JSON.stringify(content, null, 2)}\n`, "utf8");
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
    const existingSalt =
      typeof existing.repositorySalt === "string"
        ? decodeBase64Url(existing.repositorySalt)
        : undefined;
    if (existingSalt) {
      return ok(existingSalt);
    }

    const salt = random.bytes(SALT_BYTES);
    await writeLocalConfig(irohaDir, configPath, {
      ...existing,
      repositorySalt: encodeBase64Url(salt),
    });
    return ok(salt);
  } catch (cause) {
    return err(
      new IrohaError("INTERNAL_ERROR", `Failed to read or write ${LOCAL_CONFIG_FILE}`, {
        cause,
        details: { irohaDir },
      }),
    );
  }
}
