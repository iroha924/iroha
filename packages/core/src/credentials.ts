import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
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
 *
 * And not `~/.iroha/`, which is what this originally used: `.iroha` is the name
 * this product gives the *git-tracked canonical directory* it tells users to
 * commit, so for anyone who keeps dotfiles in a repository rooted at `$HOME`
 * that path is a tracked directory and the key lands in a commit.
 */
const CREDENTIALS_SUBDIR = "iroha";
const CREDENTIALS_FILE = "credentials.json";
/**
 * Written beside the file. `~/.config` itself is commonly tracked in a dotfiles
 * repository, so moving out of `.iroha` removes the product's own instruction to
 * commit this directory but not every way it can end up in a working tree. Git
 * honours a `.gitignore` in any directory, so this holds wherever the file ends
 * up — and `*` covers the temp file below as well as `credentials.json`.
 */
const SELF_IGNORE = "*\n";

/** The providers a credential may be stored for: the embedding provider and the forge. */
const providerSchema = z.enum(["voyage", "github"]);
export type CredentialProvider = z.infer<typeof providerSchema>;

/** One provider's entry. Extra fields are rejected so a typo is not silently ignored. */
const entrySchema = z.strictObject({ apiKey: z.string().min(1) });

/**
 * Longest key accepted. Voyage and GitHub tokens are well under 200 characters;
 * the bound exists so a mistaken `iroha credentials voyage < some-file` fails
 * instead of writing a megabyte that every later read has to parse.
 */
const MAX_KEY_LENGTH = 1000;
/**
 * A key ends up in `Authorization: Bearer <key>`. Anything outside visible ASCII
 * makes undici throw while *constructing* the header, which `createVoyageProvider`
 * cannot distinguish from a socket failure — so it reports a retryable network
 * outage forever and the real cause (a newline the paste carried, a full-width
 * character) appears nowhere. Rejecting at the boundary is the only place this
 * is still legible.
 */
const KEY_PATTERN = /^[!-~]+$/;

export interface CredentialsLocation {
  dir: string;
  file: string;
}

/**
 * `$XDG_CONFIG_HOME/iroha/`, or `~/.config/iroha/`. The variable is honoured only
 * when absolute, as the XDG base-directory specification requires — a relative
 * value would otherwise resolve against whatever directory the agent host happened
 * to start in, so the same machine would have several credential files.
 */
export function credentialsLocation(): CredentialsLocation {
  const configHome = process.env.XDG_CONFIG_HOME;
  const base =
    configHome !== undefined && configHome.length > 0 && isAbsolute(configHome)
      ? configHome
      : join(homedir(), ".config");
  const dir = join(base, CREDENTIALS_SUBDIR);
  return { dir, file: join(dir, CREDENTIALS_FILE) };
}

function unreadable(message: string, cause?: unknown): IrohaError {
  // The path is a local absolute path and the body holds a secret, so neither
  // reaches the error: only the fact that the file could not be read, plus the
  // errno, which is what separates "wrong owner" from "it is a directory".
  const code = (cause as NodeJS.ErrnoException | undefined)?.code;
  return new IrohaError("INTERNAL_ERROR", code === undefined ? message : `${message} (${code})`);
}

async function readFileOrNull(path: string): Promise<Result<string | null, IrohaError>> {
  try {
    return ok(await readFile(path, "utf8"));
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return ok(null);
    }
    return err(unreadable("Failed to read the iroha credentials file", cause));
  }
}

interface Credentials {
  /** Every top-level key, including ones this version does not recognise. */
  raw: Record<string, unknown>;
  entries: Partial<Record<CredentialProvider, { apiKey: string }>>;
}

/**
 * Reads the whole credentials file, or an empty one when it does not exist yet.
 *
 * Read on every call rather than cached: being able to rotate a key and have the
 * next request use it — without restarting the agent host — is the entire point
 * of storing it here (ADR-018).
 *
 * Unrecognised top-level keys are carried through rather than rejected. A strict
 * whole-file schema would mean a provider added in a later version, or a `version`
 * field, makes an older install report every key it holds as missing — the same
 * trap `parseRepositoryConfig` exists to keep `config.yaml` out of, and the same
 * reason `salt.ts` merges with `...existing`.
 */
async function readCredentials(): Promise<Result<Credentials, IrohaError>> {
  const { file } = credentialsLocation();
  const content = await readFileOrNull(file);
  if (!content.ok) {
    return content;
  }
  if (content.value === null) {
    return ok({ raw: {}, entries: {} });
  }
  let json: unknown;
  try {
    json = JSON.parse(content.value);
  } catch {
    return err(unreadable("The iroha credentials file is not valid JSON"));
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return err(unreadable("The iroha credentials file is not a JSON object"));
  }
  const raw = json as Record<string, unknown>;
  const entries: Partial<Record<CredentialProvider, { apiKey: string }>> = {};
  for (const provider of providerSchema.options) {
    if (!(provider in raw)) {
      continue;
    }
    const parsed = entrySchema.safeParse(raw[provider]);
    if (!parsed.success) {
      // This provider's own entry is malformed. Reporting it as absent would
      // read exactly like "no key", which is the failure this change exists to
      // remove.
      return err(unreadable(`The stored ${provider} credential is malformed`));
    }
    entries[provider] = parsed.data;
  }
  return ok({ raw, entries });
}

/** The stored key for one provider, or `null` when none is set. */
export async function readApiKey(
  provider: CredentialProvider,
): Promise<Result<string | null, IrohaError>> {
  const all = await readCredentials();
  if (!all.ok) {
    return all;
  }
  return ok(all.value.entries[provider]?.apiKey ?? null);
}

/** Whether a key is stored, without reading its value into the caller's hands. */
export async function hasApiKey(
  provider: CredentialProvider,
): Promise<Result<boolean, IrohaError>> {
  const key = await readApiKey(provider);
  return key.ok ? ok(key.value !== null) : key;
}

/**
 * Serializes writes within this process.
 *
 * `writeApiKey` is a read-modify-write, and both writers in practice live in one
 * process: the dashboard's Settings page has a Save button per provider. Without
 * this, two overlapping saves each merge into their own snapshot and the later
 * `rename` silently drops the other provider's key while both callers get `ok`.
 *
 * Two *processes* racing (the CLI while the dashboard writes) can still lose an
 * update; the unique temp suffix below keeps that case from corrupting the file,
 * so the loser's key is simply absent and re-registering fixes it. A lock file
 * would close that window too, at the cost of owning stale-lock recovery for a
 * race that needs the same person to save two keys from two places at once.
 */
let writeQueue: Promise<unknown> = Promise.resolve();

/**
 * Stores one provider's key, preserving every other key already in the file.
 *
 * `mode 0o600` on the temp file and `0o700` on the directory: `rename()` carries
 * the temp file's mode over on POSIX, so setting it at creation is what keeps the
 * secret from landing world-readable under the default umask — the same reason
 * `local-config.json` does it for the repository salt. On Windows neither mode is
 * meaningful (`fs.chmod` only moves the read-only bit there), so the file's
 * protection is the user profile's ACL.
 */
export async function writeApiKey(
  provider: CredentialProvider,
  apiKey: string,
): Promise<Result<void, IrohaError>> {
  const run = writeQueue.then(() => writeApiKeyUnlocked(provider, apiKey));
  // Keep the chain alive whatever this write does, or one rejection would strand
  // every later write. `run` itself resolves to a Result and never rejects.
  writeQueue = run.catch(() => undefined);
  return run;
}

async function writeApiKeyUnlocked(
  provider: CredentialProvider,
  apiKey: string,
): Promise<Result<void, IrohaError>> {
  const trimmed = apiKey.trim();
  if (trimmed.length === 0) {
    return err(new IrohaError("INVALID_INPUT", "The API key is empty"));
  }
  if (trimmed.length > MAX_KEY_LENGTH) {
    return err(
      new IrohaError(
        "INVALID_INPUT",
        `The API key is longer than ${MAX_KEY_LENGTH} characters — this looks like a file, not a key`,
      ),
    );
  }
  if (!KEY_PATTERN.test(trimmed)) {
    return err(
      new IrohaError(
        "INVALID_INPUT",
        "The API key contains a character an HTTP header cannot carry (a line break, a space, or a non-ASCII character)",
      ),
    );
  }

  const existing = await readCredentials();
  // A file this version cannot read is still replaceable: refusing would leave
  // the dashboard showing "Not set" with no way to repair it from the UI. What
  // must not be lost is a *readable* key for another provider, and that is what
  // merging `raw` below preserves.
  const raw = existing.ok ? existing.value.raw : {};

  const { dir, file } = credentialsLocation();
  const next = { ...raw, [provider]: { apiKey: trimmed } };
  // `random`, not `Date.now()`: two calls in the same millisecond otherwise
  // compute the same temp path, so one `rename` fails ENOENT and the file can be
  // left holding an interleaved write. `init-repository.ts` documents the same
  // fix for the same primitive, confirmed there by reproduction.
  const tempPath = `${file}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // `mkdir`'s mode applies only when it creates the directory, so a directory
    // that already existed (`~/.config` is usually 0755) keeps its own mode.
    await chmod(dir, 0o700).catch(() => undefined);
    await writeFile(join(dir, ".gitignore"), SELF_IGNORE, "utf8").catch(() => undefined);
    await writeFile(tempPath, `${JSON.stringify(next, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
    await rename(tempPath, file);
  } catch (cause) {
    // Without this the plaintext key survives in the temp file indefinitely
    // whenever `writeFile` succeeded and `rename` did not.
    await rm(tempPath, { force: true }).catch(() => undefined);
    return err(unreadable("Failed to write the iroha credentials file", cause));
  }
  return ok(undefined);
}
