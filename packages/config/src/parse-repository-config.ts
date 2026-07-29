import type { IrohaError, Result } from "@iroha/domain";
import { parseDocument, parse as parseYaml } from "yaml";
import { parseYamlDocument } from "./parse-yaml-document.js";
import { type RepositoryConfig, repositoryConfigSchema } from "./schemas/repository-config.js";

/**
 * Keys that named where a secret used to be read from, before credentials moved
 * out of the repository (ADR-018).
 *
 * They are dropped rather than rejected. `repositoryConfigSchema` is a
 * `strictObject`, so a config written by an earlier version would otherwise fail
 * to parse and take every command down with it — on a file the user has no
 * reason to suspect and did not touch. Dropping them on read is only half the
 * migration; `initRepository` uses `findRemovedSecretLocations` below to rewrite
 * the file so the deletion actually reaches Git.
 */
const REMOVED_SECRET_LOCATION_KEYS = [
  ["search", "embedding", "api_key_env"],
  ["forge", "api_token_env"],
] as const;

/** What an env-var name looks like — the constraint 0.5.x enforced on these keys. */
const ENV_VAR_NAME = /^[A-Z][A-Z0-9_]*$/;

function readAtPath(document: unknown, path: readonly string[]): unknown {
  let node: unknown = document;
  for (const key of path) {
    if (typeof node !== "object" || node === null || Array.isArray(node)) {
      return undefined;
    }
    node = (node as Record<string, unknown>)[key];
  }
  return node;
}

export interface RemovedSecretLocation {
  /** Dotted path of the key still present in the file, e.g. `forge.api_token_env`. */
  path: string;
  /**
   * False when the value is not an environment-variable name — i.e. plausibly the
   * secret itself, pasted where 0.5.x asked for a variable name. That mistake used
   * to fail the schema loudly; now that the key is dropped on read, this is the
   * only thing left that can notice it.
   */
  looksLikeEnvVarName: boolean;
}

/** The removed keys a `config.yaml` still carries. Empty for a current file. */
export function findRemovedSecretLocations(content: string): RemovedSecretLocation[] {
  let document: unknown;
  try {
    document = parseYaml(content);
  } catch {
    return [];
  }
  return REMOVED_SECRET_LOCATION_KEYS.flatMap((path) => {
    const value = readAtPath(document, path);
    return value === undefined
      ? []
      : [
          {
            path: path.join("."),
            looksLikeEnvVarName: typeof value === "string" && ENV_VAR_NAME.test(value),
          },
        ];
  });
}

/**
 * The same YAML with the removed keys deleted, or `null` when it carries none.
 *
 * Edits the parsed document rather than re-serializing the validated object:
 * `serializeRepositoryConfig` rebuilds the file from scratch, which would drop
 * every comment a team wrote in its own `config.yaml` — a migration nobody asked
 * for, on a file nobody touched. Deleting the two nodes leaves the rest byte-for
 * -byte alone, so the change really does land in Git as a one-line deletion.
 */
export function withoutLegacySecretLocationKeys(content: string): string | null {
  let document: ReturnType<typeof parseDocument>;
  try {
    document = parseDocument(content);
  } catch {
    return null;
  }
  const removed = REMOVED_SECRET_LOCATION_KEYS.map((path) => document.deleteIn([...path])).some(
    Boolean,
  );
  if (!removed) {
    return null;
  }
  // `yaml` always emits LF. Left alone, a CRLF file would come back with every
  // line changed, turning the promised one-line deletion into a whole-file diff
  // that fights the repository's line-ending policy on every run.
  const next = String(document);
  return content.includes("\r\n") ? next.replace(/\n/g, "\r\n") : next;
}

function withoutRemovedKeys(document: unknown): unknown {
  if (typeof document !== "object" || document === null || Array.isArray(document)) {
    return document;
  }
  const root = { ...(document as Record<string, unknown>) };
  for (const path of REMOVED_SECRET_LOCATION_KEYS) {
    let node: Record<string, unknown> = root;
    // Rebuild each level on the way down so the caller's object is untouched;
    // bail the moment the shape stops matching and let Zod report it properly.
    for (let i = 0; i < path.length - 1; i++) {
      const key = path[i] as string;
      const child = node[key];
      if (typeof child !== "object" || child === null || Array.isArray(child)) {
        node = {};
        break;
      }
      const copy = { ...(child as Record<string, unknown>) };
      node[key] = copy;
      node = copy;
    }
    delete node[path[path.length - 1] as string];
  }
  return root;
}

/** Parses and validates `.iroha/config.yaml` (contracts/canonical.md §9). */
export function parseRepositoryConfig(content: string): Result<RepositoryConfig, IrohaError> {
  return parseYamlDocument(
    content,
    repositoryConfigSchema,
    "Failed to parse .iroha/config.yaml",
    withoutRemovedKeys,
  );
}
