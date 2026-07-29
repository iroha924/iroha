import type { IrohaError, Result } from "@iroha/domain";
import { parseYamlDocument } from "./parse-yaml-document.js";
import { type RepositoryConfig, repositoryConfigSchema } from "./schemas/repository-config.js";

/**
 * Keys that named where a secret used to be read from, before credentials moved
 * to `~/.iroha/credentials.json` (ADR-018).
 *
 * They are dropped rather than rejected. `repositoryConfigSchema` is a
 * `strictObject`, so a config written by an earlier version would otherwise fail
 * to parse and take every command down with it — on a file the user has no
 * reason to suspect and did not touch. Dropping them here is enough to complete
 * the migration: `serializeRepositoryConfig` writes each key explicitly, so the
 * next `init`/`sync` rewrites the file without them and the change lands in Git
 * as a one-line deletion.
 */
const REMOVED_SECRET_LOCATION_KEYS = [
  ["search", "embedding", "api_key_env"],
  ["forge", "api_token_env"],
] as const;

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
