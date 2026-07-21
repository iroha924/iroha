/**
 * Generators and structural validators for the two platform manifests, their
 * hook configs, and their MCP configs. All content derives from `metadata.ts`
 * (compatibility.md §10). Every generated file is validated by the matching Zod
 * schema in the package smoke test — this is iroha's offline "platform manifest
 * validator" (WP-11 acceptance); the `claude`/`codex` CLIs may additionally
 * validate when present, but they are not required to be installed in CI.
 *
 * Under Option A (decision-log ID-038) hooks and MCP invoke the npm-installed
 * `iroha` binary rather than `node ${CLAUDE_PLUGIN_ROOT}/dist/*.mjs`: the native
 * `@libsql/client` binding cannot be inlined into a standalone plugin `.mjs`, so
 * the archive carries only manifests, hook/MCP config, and skills.
 */

import { z } from "zod";
import {
  BINARY_NAME,
  HOOK_EVENTS,
  HOOK_SUBCOMMAND,
  MCP_SUBCOMMAND,
  PLUGIN_AUTHOR,
  PLUGIN_DESCRIPTION,
  PLUGIN_HOMEPAGE,
  PLUGIN_KEYWORDS,
  PLUGIN_LICENSE,
  PLUGIN_NAME,
  PLUGIN_REPOSITORY,
  PLUGIN_VERSION,
  PUBLISHED_PACKAGE_NAME,
} from "./metadata.js";

/** Relative archive paths the manifests point at (all start with `./`). */
export const SKILLS_DIR = "./skills/";
export const CLAUDE_HOOKS_PATH = "./hooks/claude.json";
export const CODEX_HOOKS_PATH = "./hooks/codex.json";
export const CLAUDE_MCP_PATH = "./.mcp.json";
export const CODEX_MCP_PATH = "./mcp.codex.json";

const SERVER_KEY = PLUGIN_NAME;

/** A `type: "command"` hook handler (the only kind Codex runs; Claude's exec form). */
interface CommandHook {
  readonly type: "command";
  readonly command: string;
  readonly args?: readonly string[];
  readonly timeout: number;
}

interface HookGroup {
  readonly hooks: readonly CommandHook[];
}

/** An event-keyed map of matcher groups, shared by both platforms' hook configs. */
export type HookEventMap = Record<string, readonly HookGroup[]>;

// --- Claude Code manifest (.claude-plugin/plugin.json) ---------------------

/** Claude exec-form command hook: `iroha __hook claude` with a per-event ceiling. */
function claudeHookHandler(timeoutSeconds: number): CommandHook {
  return {
    type: "command",
    command: BINARY_NAME,
    args: [HOOK_SUBCOMMAND, "claude"],
    timeout: timeoutSeconds,
  };
}

export function buildClaudeHooks(): HookEventMap {
  const hooks: Record<string, readonly HookGroup[]> = {};
  for (const { event, timeoutSeconds } of HOOK_EVENTS) {
    hooks[event] = [{ hooks: [claudeHookHandler(timeoutSeconds)] }];
  }
  return hooks;
}

export function buildClaudeMcpConfig(): unknown {
  return {
    mcpServers: {
      [SERVER_KEY]: { command: BINARY_NAME, args: [MCP_SUBCOMMAND] },
    },
  };
}

export function buildClaudeManifest(): unknown {
  return {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    description: PLUGIN_DESCRIPTION,
    author: { name: PLUGIN_AUTHOR.name },
    homepage: PLUGIN_HOMEPAGE,
    repository: PLUGIN_REPOSITORY,
    license: PLUGIN_LICENSE,
    keywords: [...PLUGIN_KEYWORDS],
    skills: SKILLS_DIR,
    hooks: CLAUDE_HOOKS_PATH,
    mcpServers: CLAUDE_MCP_PATH,
  };
}

// --- Codex manifest (.codex-plugin/plugin.json) ----------------------------

/**
 * Codex command hooks are a single shell string (not exec-form `command`+`args`),
 * and Codex runs only `type: "command"` handlers. `iroha __hook codex` needs no
 * shell features, so it is safe regardless of shell-vs-exec interpretation.
 */
function codexHookHandler(timeoutSeconds: number): CommandHook {
  return {
    type: "command",
    command: `${BINARY_NAME} ${HOOK_SUBCOMMAND} codex`,
    timeout: timeoutSeconds,
  };
}

export function buildCodexHooks(): { description: string; hooks: HookEventMap } {
  const events: Record<string, readonly HookGroup[]> = {};
  for (const { event, timeoutSeconds } of HOOK_EVENTS) {
    // Matcher omitted so the handler fires on every occurrence of the event; the
    // hook discriminates internally. (Codex matcher-optionality is not stated in
    // the docs — recorded as an assumption in decision-log ID-038.)
    events[event] = [{ hooks: [codexHookHandler(timeoutSeconds)] }];
  }
  return { description: "iroha lifecycle hooks", hooks: events };
}

export function buildCodexMcpConfig(): unknown {
  return {
    mcp_servers: {
      [SERVER_KEY]: { command: BINARY_NAME, args: [MCP_SUBCOMMAND] },
    },
  };
}

export function buildCodexManifest(): unknown {
  return {
    name: PLUGIN_NAME,
    version: PLUGIN_VERSION,
    description: PLUGIN_DESCRIPTION,
    author: { name: PLUGIN_AUTHOR.name },
    homepage: PLUGIN_HOMEPAGE,
    repository: PLUGIN_REPOSITORY,
    license: PLUGIN_LICENSE,
    keywords: [...PLUGIN_KEYWORDS],
    skills: SKILLS_DIR,
    hooks: CODEX_HOOKS_PATH,
    mcpServers: CODEX_MCP_PATH,
  };
}

// --- Structural validators -------------------------------------------------

const KEBAB_NAME = /^[a-z][a-z0-9]*(-[a-z0-9]+)*$/;
const SEMVER = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-.]+)?(?:\+[0-9A-Za-z-.]+)?$/;
const RELATIVE_PATH = /^\.\//;

const authorSchema = z.strictObject({
  name: z.string().min(1),
  email: z.string().optional(),
  url: z.string().optional(),
});

/** Claude Code plugin manifest (plugins-reference: only `name` is required). */
export const claudeManifestSchema = z.strictObject({
  name: z.string().regex(KEBAB_NAME),
  version: z.string().regex(SEMVER),
  description: z.string().min(1),
  author: authorSchema,
  homepage: z.url(),
  repository: z.url(),
  license: z.string().min(1),
  keywords: z.array(z.string().min(1)).min(1),
  skills: z.string().regex(RELATIVE_PATH),
  hooks: z.string().regex(RELATIVE_PATH),
  mcpServers: z.string().regex(RELATIVE_PATH),
});

/** Codex plugin manifest (build-plugins: name/version/description required). */
export const codexManifestSchema = z.strictObject({
  name: z.string().regex(KEBAB_NAME),
  version: z.string().regex(SEMVER),
  description: z.string().min(1),
  author: authorSchema,
  homepage: z.url(),
  repository: z.url(),
  license: z.string().min(1),
  keywords: z.array(z.string().min(1)).min(1),
  skills: z.string().regex(RELATIVE_PATH),
  hooks: z.string().regex(RELATIVE_PATH),
  mcpServers: z.string().regex(RELATIVE_PATH),
});

const claudeHookHandlerSchema = z.strictObject({
  type: z.literal("command"),
  command: z.literal(BINARY_NAME),
  args: z.array(z.string().min(1)).min(1),
  timeout: z.number().int().positive(),
});

const codexHookHandlerSchema = z.strictObject({
  type: z.literal("command"),
  command: z.string().min(1),
  timeout: z.number().int().positive(),
});

const hookGroupSchema = <T extends z.ZodTypeAny>(handler: T) =>
  z.array(z.strictObject({ hooks: z.array(handler).min(1) })).min(1);

/** Claude hook config: an event-keyed map of matcher groups. */
export const claudeHooksSchema = z.record(z.string(), hookGroupSchema(claudeHookHandlerSchema));

/** Codex hook config: `{ description?, hooks: { <event>: group[] } }`. */
export const codexHooksSchema = z.strictObject({
  description: z.string().optional(),
  hooks: z.record(z.string(), hookGroupSchema(codexHookHandlerSchema)),
});

const mcpServerEntrySchema = z.strictObject({
  command: z.literal(BINARY_NAME),
  args: z.array(z.string().min(1)).min(1),
});

/** Claude MCP config: `{ mcpServers: { <name>: entry } }`. */
export const claudeMcpConfigSchema = z.strictObject({
  mcpServers: z.record(z.string(), mcpServerEntrySchema),
});

/** Codex MCP config: `{ mcp_servers: { <name>: entry } }` (snake_case wrapper). */
export const codexMcpConfigSchema = z.strictObject({
  mcp_servers: z.record(z.string(), mcpServerEntrySchema),
});

// --- Repository marketplaces -----------------------------------------------
//
// Hosted from the repository (compatibility.md §13). Both resolve the plugin
// from the published npm package (Option A, ID-038): npm carries the `iroha`
// binary, its native `@libsql/client`, and the plugin config, so an `npm` source
// installs everything the manifests reference. No `version` is pinned on the
// plugin entry — the npm package's own version applies — so these files need no
// version bump. Written to their committed locations by `build-archive-cli.ts`.

const npmSourceSchema = z.strictObject({
  source: z.literal("npm"),
  package: z.string().min(1),
});

/** Claude marketplace (`.claude-plugin/marketplace.json`). */
export function buildClaudeMarketplace(): unknown {
  return {
    name: PLUGIN_NAME,
    owner: { name: PLUGIN_AUTHOR.name },
    description: PLUGIN_DESCRIPTION,
    plugins: [
      {
        name: PLUGIN_NAME,
        source: { source: "npm", package: PUBLISHED_PACKAGE_NAME },
        description: PLUGIN_DESCRIPTION,
        homepage: PLUGIN_HOMEPAGE,
        repository: PLUGIN_REPOSITORY,
        license: PLUGIN_LICENSE,
        keywords: [...PLUGIN_KEYWORDS],
      },
    ],
  };
}

/** Codex marketplace (`.agents/plugins/marketplace.json`). */
export function buildCodexMarketplace(): unknown {
  return {
    name: PLUGIN_NAME,
    interface: { displayName: PLUGIN_NAME },
    plugins: [
      {
        name: PLUGIN_NAME,
        source: { source: "npm", package: PUBLISHED_PACKAGE_NAME },
        category: "Productivity",
      },
    ],
  };
}

export const claudeMarketplaceSchema = z.strictObject({
  name: z.string().regex(KEBAB_NAME),
  owner: z.strictObject({ name: z.string().min(1), email: z.string().optional() }),
  description: z.string().min(1).optional(),
  plugins: z
    .array(
      z.strictObject({
        name: z.string().regex(KEBAB_NAME),
        source: npmSourceSchema,
        description: z.string().min(1).optional(),
        homepage: z.url().optional(),
        repository: z.url().optional(),
        license: z.string().min(1).optional(),
        keywords: z.array(z.string().min(1)).optional(),
      }),
    )
    .min(1),
});

export const codexMarketplaceSchema = z.strictObject({
  name: z.string().regex(KEBAB_NAME),
  interface: z.strictObject({ displayName: z.string().min(1) }).optional(),
  plugins: z
    .array(
      z.strictObject({
        name: z.string().regex(KEBAB_NAME),
        source: npmSourceSchema,
        category: z.string().min(1).optional(),
      }),
    )
    .min(1),
});
