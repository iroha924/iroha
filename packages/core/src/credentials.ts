import { randomBytes } from "node:crypto";
import { appendFile, chmod, lstat, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
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

/**
 * One provider's entry. Extra fields are rejected so a typo is not silently
 * ignored, and the key must meet the same constraints `writeApiKey` enforces —
 * a file restored from a backup or edited by hand is not held to the write path,
 * and a key with a newline in it would otherwise be reported as a retryable
 * network outage forever (see `KEY_PATTERN`).
 */
const entrySchema = z.strictObject({
  apiKey: z.string().min(1).max(MAX_KEY_LENGTH).regex(KEY_PATTERN),
});

export interface CredentialsLocation {
  dir: string;
  file: string;
}

/**
 * `$XDG_CONFIG_HOME/iroha/`, or `~/.config/iroha/`.
 *
 * The variable is honoured only when it is absolute, as the XDG base-directory
 * specification requires — a relative value would otherwise resolve against
 * whatever directory the agent host happened to start in, so the same machine
 * would end up with several credential files.
 *
 * And only when it contains no `..` segment. `join` folds `..` lexically, before
 * the filesystem follows any symlink in the path, so `/home/u/link/..` would put
 * the key under `/home/u/` rather than beside whatever `link` actually points at
 * — possibly a tracked directory (`.claude/rules/path-and-symlink-safety.md`).
 * Rejecting the value outright is an allowlist, which that rule prefers over
 * validating a path after the fact.
 *
 * The separator is platform-conditional because a backslash is an ordinary
 * filename character on POSIX: splitting on it there would invent a `..` in the
 * legal path `/tmp/team\../config` and silently redirect the key to `~/.config`.
 */
const SEPARATOR = process.platform === "win32" ? /[/\\]/ : /\//;

function usableConfigHome(value: string | undefined): string | undefined {
  if (value === undefined || value.length === 0 || !isAbsolute(value)) {
    return undefined;
  }
  return value.split(SEPARATOR).includes("..") ? undefined : value;
}

export function credentialsLocation(): CredentialsLocation {
  const base = usableConfigHome(process.env.XDG_CONFIG_HOME) ?? join(homedir(), ".config");
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

/** Every top-level key, including ones this version does not recognise. */
type Credentials = Record<string, unknown>;

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
function parseCredentials(content: string | null): Result<Credentials, IrohaError> {
  if (content === null) {
    return ok({});
  }
  let json: unknown;
  try {
    json = JSON.parse(content);
  } catch {
    return err(unreadable("The iroha credentials file is not valid JSON"));
  }
  if (typeof json !== "object" || json === null || Array.isArray(json)) {
    return err(unreadable("The iroha credentials file is not a JSON object"));
  }
  return ok(json as Credentials);
}

async function readCredentials(): Promise<Result<Credentials, IrohaError>> {
  const content = await readFileOrNull(credentialsLocation().file);
  return content.ok ? parseCredentials(content.value) : content;
}

/**
 * The stored key for one provider, or `null` when none is set.
 *
 * Each provider's entry is validated on its own. Failing the whole file on one
 * malformed entry would make a valid GitHub token unreadable because the Voyage
 * one was hand-edited badly — and would let the repair that fixes Voyage write a
 * file with the GitHub token gone.
 */
export async function readApiKey(
  provider: CredentialProvider,
): Promise<Result<string | null, IrohaError>> {
  const all = await readCredentials();
  if (!all.ok) {
    return all;
  }
  if (!(provider in all.value)) {
    return ok(null);
  }
  const parsed = entrySchema.safeParse(all.value[provider]);
  if (!parsed.success) {
    // Reporting a malformed entry as absent would read exactly like "no key",
    // which is the failure this change exists to remove.
    return err(unreadable(`The stored ${provider} credential is malformed`));
  }
  return ok(parsed.data.apiKey);
}

/** Whether a key is stored, without reading its value into the caller's hands. */
export async function hasApiKey(
  provider: CredentialProvider,
): Promise<Result<boolean, IrohaError>> {
  const key = await readApiKey(provider);
  return key.ok ? ok(key.value !== null) : key;
}

/**
 * Makes sure the directory ignores itself in Git *before* a secret is written
 * into it, and fails the write if it cannot.
 *
 * Swallowing this would defeat the point: on the path that matters — the XDG
 * directory sitting inside a dotfiles worktree — a missing ignore file is exactly
 * what lets the next `git add -A` commit the key, and the write would have
 * reported success.
 *
 * `wx` creates without following an existing path, so a `.gitignore` a dotfiles
 * manager symlinked to a shared source does not get its target overwritten with
 * `*`. Anything that is not a regular file (a symlink, a directory) is refused
 * rather than trusted, and a regular file that does not already carry the pattern
 * gets it appended — accepting any existing `.gitignore` would accept one holding
 * only `node_modules/`, which ignores nothing that matters here.
 */
async function ensureSelfIgnore(dir: string): Promise<Result<void, IrohaError>> {
  const path = join(dir, ".gitignore");
  try {
    await writeFile(path, SELF_IGNORE, { encoding: "utf8", flag: "wx" });
    return ok(undefined);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "EEXIST") {
      return err(unreadable("Failed to write the iroha credentials .gitignore", cause));
    }
  }
  try {
    if (!(await lstat(path)).isFile()) {
      return err(
        new IrohaError(
          "INVALID_INPUT",
          "The .gitignore beside the iroha credentials file is not a regular file; iroha will not store a key it cannot keep out of Git",
        ),
      );
    }
    const existing = await readFile(path, "utf8");
    if (!existing.split(/\r?\n/).includes(SELF_IGNORE.trim())) {
      await appendFile(path, existing.endsWith("\n") ? SELF_IGNORE : `\n${SELF_IGNORE}`, "utf8");
    }
  } catch (cause) {
    return err(unreadable("Failed to inspect the iroha credentials .gitignore", cause));
  }
  return ok(undefined);
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

  const { dir, file } = credentialsLocation();
  const content = await readFileOrNull(file);
  // An I/O failure is not a corrupt file. Treating EACCES as "start from empty"
  // would let a save that only meant to add one provider erase every other stored
  // credential, because the directory can still be writable when the file is not
  // readable.
  if (!content.ok) {
    return content;
  }
  // Unparseable content *is* replaceable: refusing would leave the dashboard
  // showing "Not set" with no way to repair it from the UI, and nothing
  // recoverable is being discarded. A file that parses keeps every key it holds —
  // including a provider whose own entry is malformed, which `readApiKey` reports
  // per provider rather than wholesale.
  const parsed = parseCredentials(content.value);
  const raw = parsed.ok ? parsed.value : {};
  const next = { ...raw, [provider]: { apiKey: trimmed } };
  // `random`, not `Date.now()`: two calls in the same millisecond otherwise
  // compute the same temp path, so one `rename` fails ENOENT and the file can be
  // left holding an interleaved write. `init-repository.ts` documents the same
  // fix for the same primitive, confirmed there by reproduction.
  const tempPath = `${file}.tmp-${process.pid}-${randomBytes(8).toString("hex")}`;
  try {
    await mkdir(dir, { recursive: true, mode: 0o700 });
    // `mkdir`'s mode applies only when it creates the directory, so a directory
    // that already existed (`~/.config` is usually 0755) keeps its own mode. Not
    // swallowed: on a shared writable directory, failing to narrow the mode is
    // what lets another account replace `credentials.json`, and reporting success
    // would claim a protection ADR-018 says is in place when it is not.
    await chmod(dir, 0o700);
  } catch (cause) {
    return err(unreadable("Failed to create the iroha credentials directory", cause));
  }

  const ignored = await ensureSelfIgnore(dir);
  if (!ignored.ok) {
    return ignored;
  }

  try {
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
