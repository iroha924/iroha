import type { ExecFileException } from "node:child_process";
import { execFile } from "node:child_process";
import { access, constants, readFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { parseRepositoryConfig } from "@iroha/config";
import {
  CryptoRandomSource,
  type IrohaError,
  ok,
  type RandomSource,
  type Result,
} from "@iroha/domain";
import { resolveGitLocation, resolveGitPath } from "@iroha/git";
import {
  closeDatabase,
  getSyncCursor,
  listApprovedRulesForRepository,
  openDatabase,
  probeCapabilities,
} from "@iroha/storage";
import { classifyGuardSpec } from "./hooks/guardrail.js";
import { resolveInitializedRepository } from "./resolve-repository.js";
import { readSchemaVersion } from "./schema-version.js";

export type DoctorCheckStatus = "ok" | "warning" | "error" | "blocked";

export interface DoctorCheckResult {
  name: string;
  status: DoctorCheckStatus;
  message: string;
}

export interface DoctorReport {
  checks: DoctorCheckResult[];
}

/**
 * A minimal, explicit environment allowlist for probing an external CLI's
 * version (`secure-subprocess-and-credentials.md`: prefer an allowlist over
 * copying `process.env` and denylisting known-dangerous keys). `PATH` lets
 * the OS locate the binary; `HOME`/`USERPROFILE` and the temp-dir variables
 * are what most CLIs need merely to start up and print `--version`, nothing
 * secret-bearing is included.
 */
function buildMinimalEnv(): NodeJS.ProcessEnv {
  const allowlist = ["PATH", "HOME", "USERPROFILE", "TEMP", "TMP", "TMPDIR"];
  const env: NodeJS.ProcessEnv = {};
  for (const key of allowlist) {
    const value = process.env[key];
    if (value !== undefined) {
      env[key] = value;
    }
  }
  return env;
}

/** Runs `binary --version`-style probes with an argument array (never a shell string) and a minimal env. */
function checkCliVersion(binary: string, args: readonly string[]): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      binary,
      args,
      { env: buildMinimalEnv(), timeout: 5_000, windowsHide: true, maxBuffer: 1024 * 1024 },
      (error: ExecFileException | null, stdout: string) => {
        if (error) {
          resolve(null);
          return;
        }
        resolve(stdout.trim());
      },
    );
  });
}

/** compatibility.md §2: `Node.js | 24 LTS | >=24.0.0 <25`. */
function isSupportedNodeVersion(version: string): boolean {
  const match = /^v?(\d+)\./.exec(version);
  if (match?.[1] === undefined) {
    return false;
  }
  const major = Number(match[1]);
  return major === 24;
}

async function checkNode(): Promise<DoctorCheckResult> {
  const version = process.version;
  if (!isSupportedNodeVersion(version)) {
    return {
      name: "node",
      status: "warning",
      message: `Node.js ${version} (expected >=24.0.0 <25 — newer or older is unverified, not necessarily broken)`,
    };
  }
  return { name: "node", status: "ok", message: `Node.js ${version}` };
}

async function checkGit(): Promise<DoctorCheckResult> {
  const version = await checkCliVersion("git", ["--version"]);
  if (version === null) {
    return { name: "git", status: "error", message: "git was not found on PATH" };
  }
  return { name: "git", status: "ok", message: version };
}

async function checkOptionalAgentCli(name: "claude" | "codex"): Promise<DoctorCheckResult> {
  const version = await checkCliVersion(name, ["--version"]);
  if (version === null) {
    return { name, status: "warning", message: `${name} was not found on PATH` };
  }
  return { name, status: "ok", message: version };
}

async function checkGitRepository(cwd: string): Promise<{
  check: DoctorCheckResult;
  irohaCanonicalDir: string | null;
  irohaStateDir: string | null;
}> {
  const locationResult = await resolveGitLocation(cwd);
  if (!locationResult.ok) {
    return {
      check: { name: "git-repository", status: "error", message: locationResult.error.message },
      irohaCanonicalDir: null,
      irohaStateDir: null,
    };
  }
  const irohaPathResult = await resolveGitPath(cwd, "iroha");
  if (!irohaPathResult.ok) {
    return {
      check: { name: "git-repository", status: "error", message: irohaPathResult.error.message },
      irohaCanonicalDir: null,
      irohaStateDir: null,
    };
  }

  /** compatibility.md §9 point 8: "verify Git root, common dir, worktree git dir, and write access." */
  try {
    await access(locationResult.value.root, constants.W_OK);
  } catch {
    return {
      check: {
        name: "git-repository",
        status: "error",
        message: "Git repository root is not writable",
      },
      irohaCanonicalDir: null,
      irohaStateDir: null,
    };
  }

  return {
    check: { name: "git-repository", status: "ok", message: "Git repository resolved" },
    irohaCanonicalDir: join(locationResult.value.root, ".iroha"),
    irohaStateDir: irohaPathResult.value,
  };
}

async function checkIrohaInitialized(irohaCanonicalDir: string): Promise<DoctorCheckResult> {
  const schemaResult = await readSchemaVersion(irohaCanonicalDir);
  if (!schemaResult.ok) {
    return { name: "iroha-init", status: "error", message: schemaResult.error.message };
  }
  if (schemaResult.value === null) {
    return {
      name: "iroha-init",
      status: "warning",
      message: ".iroha/ does not exist yet (run `iroha init`)",
    };
  }
  if (schemaResult.value !== "1") {
    return {
      name: "iroha-init",
      status: "error",
      message: `Unsupported .iroha/ schema version "${schemaResult.value}"`,
    };
  }
  return { name: "iroha-init", status: "ok", message: "Schema version 1" };
}

async function checkStorageCapabilities(
  irohaStateDir: string,
  random: RandomSource,
): Promise<DoctorCheckResult> {
  const opened = await openDatabase(join(irohaStateDir, "index.db"));
  if (!opened.ok) {
    return { name: "storage-capabilities", status: "error", message: opened.error.message };
  }
  try {
    const capabilities = await probeCapabilities(opened.value, random);
    const missing = Object.entries(capabilities)
      .filter(([, supported]) => !supported)
      .map(([name]) => name);
    if (missing.length > 0) {
      return {
        name: "storage-capabilities",
        status: "warning",
        message: `libSQL build is missing: ${missing.join(", ")}`,
      };
    }
    return {
      name: "storage-capabilities",
      status: "ok",
      message: "FTS5 unicode61/trigram and vector search are supported",
    };
  } finally {
    await closeDatabase(opened.value);
  }
}

/**
 * Reports the active Guardrails and whether each is actually enforced at the
 * Hook layer (vertical-slice.md §4). A Guardrail that fails open at PreToolUse —
 * because its spec is unevaluable, or because it protects no paths (a
 * command/`deny_commands`-scoped guard the Hook cannot enforce, ID-036) — is
 * surfaced as a `warning`, so a silent no-op never reads as healthy. Any internal
 * failure is a report entry, never a throw.
 */
async function checkGuardrails(cwd: string): Promise<DoctorCheckResult> {
  const resolved = await resolveInitializedRepository(cwd);
  if (!resolved.ok) {
    return { name: "guardrails", status: "warning", message: "repository not resolved" };
  }
  const opened = await openDatabase(resolved.value.dbPath);
  if (!opened.ok) {
    return { name: "guardrails", status: "error", message: opened.error.message };
  }
  try {
    const listed = await listApprovedRulesForRepository(opened.value, resolved.value.repositoryId);
    if (!listed.ok) {
      return { name: "guardrails", status: "error", message: listed.error.message };
    }
    const guardrails = listed.value.filter((rule) => rule.enforcement === "guardrail");
    const invalid: string[] = [];
    const notEnforceable: string[] = [];
    for (const rule of guardrails) {
      const kind = classifyGuardSpec(rule.guardSpecJson);
      if (kind === "invalid") {
        invalid.push(rule.id);
      } else if (kind === "not_hook_enforceable") {
        notEnforceable.push(rule.id);
      }
    }
    const problems: string[] = [];
    if (invalid.length > 0) {
      problems.push(`unevaluable guard spec, will not enforce: ${invalid.join(", ")}`);
    }
    if (notEnforceable.length > 0) {
      problems.push(
        `no protected paths, not enforced at the hook layer (CI is the hard enforcement layer): ${notEnforceable.join(", ")}`,
      );
    }
    if (problems.length > 0) {
      return { name: "guardrails", status: "warning", message: problems.join("; ") };
    }
    return {
      name: "guardrails",
      status: "ok",
      message:
        guardrails.length === 0
          ? "no active guardrails"
          : `${guardrails.length} active guardrail(s), all enforceable`,
    };
  } finally {
    await closeDatabase(opened.value);
  }
}

/**
 * compatibility.md §9 point 9: "report Embedding and Forge providers
 * without printing secret values." `.iroha/config.yaml` never holds a
 * secret itself (only an environment-variable *name* — canonical-
 * schema.md §9), so the only additional care this needs is to report
 * *whether* the named variable is set, never its value. The forge provider is
 * reported separately by `checkForge`, which also reads the sync cursor.
 */
async function checkProviders(irohaCanonicalDir: string): Promise<DoctorCheckResult[]> {
  let content: string;
  try {
    content = await readFile(join(irohaCanonicalDir, "config.yaml"), "utf8");
  } catch (cause) {
    // Only a missing file is "nothing to check" — any other failure
    // (permission denied, I/O error, ...) must be surfaced, not silently
    // treated as if the config simply did not exist yet.
    if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    return [
      {
        name: "config",
        status: "error",
        message: "Failed to read .iroha/config.yaml",
      },
    ];
  }
  const parsed = parseRepositoryConfig(content);
  if (!parsed.ok) {
    return [{ name: "config", status: "error", message: parsed.error.message }];
  }
  const { search } = parsed.value;
  const embeddingKeySet = process.env[search.embedding.api_key_env] !== undefined;
  return [
    {
      name: "embedding-provider",
      status: search.embedding.enabled && !embeddingKeySet ? "warning" : "ok",
      message: search.embedding.enabled
        ? `${search.embedding.provider}/${search.embedding.model} (key ${embeddingKeySet ? "set" : "not set"})`
        : "disabled",
    },
  ];
}

/**
 * Reports the forge provider. When forge is enabled this checks the token env
 * var is set (`warning` if not — a silent no-op sync would otherwise read as
 * healthy) and reads the `github` sync cursor to surface the last sync's error
 * code. The token *value* is never read or printed — only whether the named
 * variable is set (compatibility.md §9). Any internal failure is a report
 * entry, never a throw.
 */
async function checkForge(cwd: string): Promise<DoctorCheckResult> {
  const resolved = await resolveInitializedRepository(cwd);
  if (!resolved.ok) {
    return { name: "forge-provider", status: "warning", message: "repository not resolved" };
  }
  const forge = resolved.value.config.forge;
  if (!forge.enabled) {
    return { name: "forge-provider", status: "ok", message: "disabled" };
  }
  const tokenSet = process.env[forge.api_token_env] !== undefined;
  if (!tokenSet) {
    return {
      name: "forge-provider",
      status: "warning",
      message: `${forge.provider} enabled but ${forge.api_token_env} is not set`,
    };
  }
  const opened = await openDatabase(resolved.value.dbPath);
  if (!opened.ok) {
    return { name: "forge-provider", status: "error", message: opened.error.message };
  }
  try {
    const cursor = await getSyncCursor(opened.value, resolved.value.repositoryId, "github");
    if (!cursor.ok) {
      // The DB file may exist but not be built yet — a fresh clone before the
      // first `iroha sync --rebuild` (the DB lives in gitignored `.git/iroha/`,
      // so `sync_cursors` is absent). Forge health is diagnostic and fail-open
      // everywhere else, so a cursor read failure degrades to "token set" rather
      // than a hard error that sends the operator chasing a DB fault instead of
      // just syncing. A genuine DB fault is surfaced by the storage/guardrail
      // checks that ran before this one.
      return {
        name: "forge-provider",
        status: "ok",
        message: `${forge.provider} (token set; sync status unavailable — run \`iroha sync\`)`,
      };
    }
    const row = cursor.value;
    // Cursor semantics (upsertSyncCursor): the success-path write omits
    // lastAttemptAt/lastErrorCode, and those two columns are written
    // unconditionally (no COALESCE), so a success resets both to NULL while
    // COALESCE preserves lastSuccessAt; a failure leaves lastAttemptAt set with
    // lastErrorCode. So a non-null lastAttemptAt means the most recent run did
    // not reach the success write. The timestamp comparison is a belt-and-braces
    // guard for the rare failure paths that return before recording an error.
    const lastAttemptFailed =
      row !== null &&
      row.lastAttemptAt !== null &&
      (row.lastSuccessAt === null || row.lastAttemptAt > row.lastSuccessAt);
    if (lastAttemptFailed) {
      return {
        name: "forge-provider",
        status: "warning",
        message: `${forge.provider} last sync failed${row.lastErrorCode !== null ? ` (${row.lastErrorCode})` : ""}`,
      };
    }
    return {
      name: "forge-provider",
      status: "ok",
      message:
        row?.lastSuccessAt != null
          ? `${forge.provider} (token set, last sync ok)`
          : `${forge.provider} (token set, not yet synced)`,
    };
  } finally {
    await closeDatabase(opened.value);
  }
}

/**
 * The plugin root to look for the platform manifests under. Codex sets both
 * `PLUGIN_ROOT` and `CLAUDE_PLUGIN_ROOT`; when neither is set (a plain `iroha
 * doctor` from a terminal) fall back to the package root, one level above this
 * bundled module — under Option A (decision-log ID-038) the manifests ship in
 * the same npm package as the binary (`<pkg>/dist/*.mjs` → `<pkg>/…`).
 */
function resolvePluginRoot(): string {
  const fromEnv = process.env.CLAUDE_PLUGIN_ROOT ?? process.env.PLUGIN_ROOT;
  if (fromEnv !== undefined && fromEnv.length > 0) {
    return fromEnv;
  }
  return fileURLToPath(new URL("..", import.meta.url));
}

/** A structural (not schema) reason a manifest is invalid, or `null` if well-formed. */
function manifestProblem(value: unknown): string | null {
  if (typeof value !== "object" || value === null) {
    return "is not a JSON object";
  }
  const manifest = value as Record<string, unknown>;
  if (typeof manifest.name !== "string" || manifest.name.length === 0) {
    return "is missing a name";
  }
  if (typeof manifest.version !== "string" || manifest.version.length === 0) {
    return "is missing a version";
  }
  return null;
}

/**
 * compatibility.md §9 step 3/4: validate the installed platform manifests. Since
 * `@iroha/core` may not depend on `@iroha/plugin` (§4), this is a lightweight
 * structural check (JSON parse + required `name`/`version`) against the
 * platform-convention paths, not the plugin's own Zod schema — those validators
 * run at build time (`@iroha/plugin`'s package smoke test). Reports `ok` when the
 * manifests are absent (a terminal `iroha doctor` outside a plugin install) and
 * `error` only when a present manifest is malformed.
 */
export async function checkPluginManifests(root: string): Promise<DoctorCheckResult> {
  const manifests = [
    { platform: "Claude", path: join(root, ".claude-plugin", "plugin.json") },
    { platform: "Codex", path: join(root, ".codex-plugin", "plugin.json") },
  ];
  const valid: string[] = [];
  for (const { platform, path } of manifests) {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch {
      continue; // not present here — not running from an installed plugin
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        name: "plugin-manifests",
        status: "error",
        message: `${platform} plugin.json is not valid JSON`,
      };
    }
    const problem = manifestProblem(parsed);
    if (problem !== null) {
      return {
        name: "plugin-manifests",
        status: "error",
        message: `${platform} plugin.json ${problem}`,
      };
    }
    const manifest = parsed as { name: string; version: string };
    valid.push(`${platform} ${manifest.name}@${manifest.version}`);
  }
  if (valid.length === 0) {
    return {
      name: "plugin-manifests",
      status: "ok",
      message: "not running from an installed iroha plugin (manifests validated at build time)",
    };
  }
  return { name: "plugin-manifests", status: "ok", message: `valid: ${valid.join(", ")}` };
}

/**
 * True when the parsed MCP config declares a runnable server — a `command` plus
 * a non-empty `args`. It deliberately does NOT assert the exact `__mcp`
 * subcommand: that literal lives in `@iroha/plugin`'s `metadata.ts` (which
 * `@iroha/core` may not import, §4), and the config is generated by the same
 * build that ships this check, so matching a duplicated literal would only
 * create a drift trap — a future rename of the subcommand would make doctor
 * report `error` (and `iroha doctor` exit 1) against a perfectly healthy
 * install. "A server is declared" is the drift-proof health signal doctor can
 * honestly give within the package boundary.
 */
function declaresRunnableServer(value: unknown, serversKey: string): boolean {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return false;
  }
  const servers = (value as Record<string, unknown>)[serversKey];
  if (typeof servers !== "object" || servers === null || Array.isArray(servers)) {
    return false;
  }
  return Object.values(servers as Record<string, unknown>).some((entry) => {
    if (typeof entry !== "object" || entry === null || Array.isArray(entry)) {
      return false;
    }
    const { command, args } = entry as Record<string, unknown>;
    return (
      typeof command === "string" && command.length > 0 && Array.isArray(args) && args.length > 0
    );
  });
}

/**
 * mcp-contract.md / compatibility.md §9: confirm the MCP server is wired into the
 * installed plugin. `@iroha/core` may not depend on `@iroha/mcp` (§4), so this
 * validates the *declaration* — a runnable server entry in the installed
 * `.mcp.json`/`mcp.codex.json` — rather than spawning the server; the server
 * itself is bundled into the shipped `iroha` binary and its tool registry is
 * covered by `@iroha/plugin`'s package smoke test. Reports `ok` when not running
 * from an installed plugin (a dev/terminal run, where the server is in-process
 * source), matching `checkPluginManifests`; `error` only when a present config
 * is unreadable/malformed or declares no runnable server.
 */
export async function checkMcpServer(root: string): Promise<DoctorCheckResult> {
  const configs = [
    { platform: "Claude", path: join(root, ".mcp.json"), serversKey: "mcpServers" },
    { platform: "Codex", path: join(root, "mcp.codex.json"), serversKey: "mcp_servers" },
  ];
  const valid: string[] = [];
  for (const { platform, path, serversKey } of configs) {
    let raw: string;
    try {
      raw = await readFile(path, "utf8");
    } catch (cause) {
      // Only a missing file means "not running from an installed plugin". Any
      // other read failure (a permission-denied or directory-shaped config) is a
      // real problem the diagnostic must not silently pass over as absent.
      if ((cause as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      return {
        name: "mcp-server",
        status: "error",
        message: `${platform} MCP config could not be read`,
      };
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return {
        name: "mcp-server",
        status: "error",
        message: `${platform} MCP config is not valid JSON`,
      };
    }
    if (!declaresRunnableServer(parsed, serversKey)) {
      return {
        name: "mcp-server",
        status: "error",
        message: `${platform} MCP config declares no runnable server`,
      };
    }
    valid.push(platform);
  }
  if (valid.length === 0) {
    return {
      name: "mcp-server",
      status: "ok",
      message: "the MCP server ships in the iroha binary (not running from an installed plugin)",
    };
  }
  return {
    name: "mcp-server",
    status: "ok",
    message: `MCP server declared: ${valid.join(", ")}`,
  };
}

/**
 * `iroha doctor` (implementation-plan.md WP-05, compatibility.md §9).
 * Every check degrades to a report entry rather than aborting — a doctor
 * command that itself crashes on a missing optional tool defeats its own
 * purpose.
 */
export async function runDoctor(cwd: string): Promise<Result<DoctorReport, IrohaError>> {
  const random = new CryptoRandomSource();
  const checks: DoctorCheckResult[] = [];

  checks.push(await checkNode());
  checks.push(await checkGit());
  checks.push(await checkOptionalAgentCli("claude"));
  checks.push(await checkOptionalAgentCli("codex"));

  const pluginRoot = resolvePluginRoot();
  checks.push(await checkMcpServer(pluginRoot));
  checks.push(await checkPluginManifests(pluginRoot));

  const { check: gitCheck, irohaCanonicalDir, irohaStateDir } = await checkGitRepository(cwd);
  checks.push(gitCheck);
  if (irohaCanonicalDir === null || irohaStateDir === null) {
    return ok({ checks });
  }

  const initCheck = await checkIrohaInitialized(irohaCanonicalDir);
  checks.push(initCheck);
  if (initCheck.status === "warning" || initCheck.status === "error") {
    return ok({ checks });
  }

  checks.push(await checkStorageCapabilities(irohaStateDir, random));
  checks.push(await checkGuardrails(cwd));
  checks.push(...(await checkProviders(irohaCanonicalDir)));
  checks.push(await checkForge(cwd));

  return ok({ checks });
}
