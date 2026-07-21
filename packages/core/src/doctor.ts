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
 * *whether* the named variable is set, never its value.
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
  const { search, forge } = parsed.value;
  const embeddingKeySet = process.env[search.embedding.api_key_env] !== undefined;
  return [
    {
      name: "embedding-provider",
      status: search.embedding.enabled && !embeddingKeySet ? "warning" : "ok",
      message: search.embedding.enabled
        ? `${search.embedding.provider}/${search.embedding.model} (key ${embeddingKeySet ? "set" : "not set"})`
        : "disabled",
    },
    {
      name: "forge-provider",
      status: "ok",
      message: forge.enabled ? forge.provider : "disabled",
    },
  ];
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
 * `iroha doctor` (implementation-plan.md WP-05, compatibility.md §9).
 * Every check degrades to a report entry rather than aborting — a doctor
 * command that itself crashes on a missing optional tool defeats its own
 * purpose. Checks for a capability this build does not yet exercise (the MCP
 * `initialize` handshake — WP-07's server exists but doctor does not spawn it)
 * report `warning`, not `error`: the capability is not yet part of doctor, not
 * something the environment is missing.
 */
export async function runDoctor(cwd: string): Promise<Result<DoctorReport, IrohaError>> {
  const random = new CryptoRandomSource();
  const checks: DoctorCheckResult[] = [];

  checks.push(await checkNode());
  checks.push(await checkGit());
  checks.push(await checkOptionalAgentCli("claude"));
  checks.push(await checkOptionalAgentCli("codex"));

  checks.push({
    name: "mcp-server",
    status: "warning",
    message: "not yet implemented in this build (WP-07)",
  });
  checks.push(await checkPluginManifests(resolvePluginRoot()));

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

  return ok({ checks });
}
