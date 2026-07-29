import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { err, IrohaError, ok, type Result } from "@iroha/domain";
import { z } from "zod";

/**
 * Where provider credentials live: machine-scoped, outside any repository
 * (ADR-018).
 *
 * Not an environment variable, because a process freezes its environment at
 * spawn and iroha's main credential consumer is the MCP server that Claude Code
 * or Codex spawns — so a rotated key never reaches it until the host restarts,
 * and nothing says so. Not `.git/iroha/` either, because a key that rides along
 * with a copied or archived `.git` is a key that leaks by accident.
 */
const CREDENTIALS_DIR = ".iroha";
const CREDENTIALS_FILE = "credentials.json";

/** The providers a credential may be stored for: the embedding provider and the forge. */
const providerSchema = z.enum(["voyage", "github"]);
export type CredentialProvider = z.infer<typeof providerSchema>;

/**
 * The file's shape. Keyed by provider so a second provider needs no new file and
 * no migration, and `strictObject` so a typo in a hand-edited file is rejected
 * rather than silently ignored — a silently ignored key reads exactly like a
 * missing one, which is the failure mode this whole change exists to remove.
 *
 * `partialRecord`, not `record`: Zod 4 makes `record()` over an enum key
 * exhaustive, which would reject a file holding only one of the two providers —
 * i.e. every file, until both are set.
 */
const credentialsFileSchema = z.partialRecord(
  providerSchema,
  z.strictObject({ apiKey: z.string().min(1) }),
);

export interface CredentialsLocation {
  dir: string;
  file: string;
}

/** Resolved from `$HOME`, so a test can point it elsewhere by setting that. */
export function credentialsLocation(): CredentialsLocation {
  const dir = join(homedir(), CREDENTIALS_DIR);
  return { dir, file: join(dir, CREDENTIALS_FILE) };
}

function unreadable(message: string, cause?: unknown): IrohaError {
  // The path is a local absolute path and the body holds a secret, so neither
  // reaches the error: only the fact that the file could not be read.
  return new IrohaError("INTERNAL_ERROR", message, cause === undefined ? {} : { cause });
}

async function readFileOrNull(path: string): Promise<Result<string | null, IrohaError>> {
  try {
    return ok(await readFile(path, "utf8"));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return ok(null);
    }
    return err(unreadable("Failed to read the iroha credentials file"));
  }
}

/**
 * Reads the whole credentials file, or `{}` when it does not exist yet.
 *
 * Read on every call rather than cached: being able to rotate a key and have the
 * next request use it — without restarting the agent host — is the entire point
 * of storing it here (ADR-018).
 */
async function readCredentials(): Promise<
  Result<Partial<Record<CredentialProvider, { apiKey: string }>>, IrohaError>
> {
  const { file } = credentialsLocation();
  const content = await readFileOrNull(file);
  if (!content.ok) {
    return content;
  }
  if (content.value === null) {
    return ok({});
  }
  let json: unknown;
  try {
    json = JSON.parse(content.value);
  } catch {
    return err(unreadable("The iroha credentials file is not valid JSON"));
  }
  const parsed = credentialsFileSchema.safeParse(json);
  if (!parsed.success) {
    return err(unreadable("The iroha credentials file does not match the expected shape"));
  }
  return ok(parsed.data);
}

/** The stored key for one provider, or `null` when none is set. */
export async function readApiKey(
  provider: CredentialProvider,
): Promise<Result<string | null, IrohaError>> {
  const all = await readCredentials();
  if (!all.ok) {
    return all;
  }
  return ok(all.value[provider]?.apiKey ?? null);
}

/** Whether a key is stored, without reading its value into the caller's hands. */
export async function hasApiKey(
  provider: CredentialProvider,
): Promise<Result<boolean, IrohaError>> {
  const key = await readApiKey(provider);
  return key.ok ? ok(key.value !== null) : key;
}

/**
 * Stores one provider's key, preserving any other provider already in the file.
 *
 * `mode 0o600` on the temp file and `0o700` on the directory: `rename()` carries
 * the temp file's mode over on POSIX, so setting it at creation is what keeps the
 * secret from landing world-readable under the default umask — the same reason
 * `local-config.json` does it for the repository salt.
 */
export async function writeApiKey(
  provider: CredentialProvider,
  apiKey: string,
): Promise<Result<void, IrohaError>> {
  const trimmed = apiKey.trim();
  if (trimmed.length === 0) {
    return err(new IrohaError("INVALID_INPUT", "The API key is empty"));
  }
  const existing = await readCredentials();
  if (!existing.ok) {
    return existing;
  }
  const { dir, file } = credentialsLocation();
  const next = { ...existing.value, [provider]: { apiKey: trimmed } };
  const tempPath = `${file}.tmp-${process.pid}-${Date.now()}`;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tempPath, file);
  } catch {
    return err(unreadable("Failed to write the iroha credentials file"));
  }
  return ok(undefined);
}
