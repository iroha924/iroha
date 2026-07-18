import { IrohaError } from "../errors/error-code.js";
import { err, ok, type Result } from "../errors/result.js";
import type { Clock } from "../ports/clock.js";
import type { RandomSource } from "../ports/random.js";
import { generateUlid, isValidUlid } from "./ulid.js";

/**
 * Prefixes for objects that also appear in `schemas/canonical-v1.schema.json`'s
 * `entityId` pattern: rows in the `entities` table (graph/search participants)
 * plus the two identity-only prefixes it references (repository, actor).
 */
export const CANONICAL_ID_PREFIXES = [
  "ses",
  "dec",
  "rul",
  "con",
  "ins",
  "inc",
  "pat",
  "rev",
  "chk",
  "iss",
  "pr",
  "cmt",
  "com",
  "fil",
  "sym",
  "act",
  "repo",
] as const;

/**
 * Prefixes used only by local operational state (DB rows / MCP wire types,
 * see migrations/001_initial.sql) that never appear as a canonical `entityId`.
 */
export const LOCAL_ID_PREFIXES = [
  "run",
  "trn",
  "evt",
  "cand",
  "apr",
  "rel",
  "sdoc",
  "job",
  "dirty",
  "log",
] as const;

export const ID_PREFIXES = [...CANONICAL_ID_PREFIXES, ...LOCAL_ID_PREFIXES] as const;

export type CanonicalIdPrefix = (typeof CANONICAL_ID_PREFIXES)[number];
export type LocalIdPrefix = (typeof LOCAL_ID_PREFIXES)[number];
export type IdPrefix = (typeof ID_PREFIXES)[number];

export type TypedId<P extends IdPrefix> = string & { readonly __idPrefix: P };

export function isTypedId<P extends IdPrefix>(prefix: P, value: string): value is TypedId<P> {
  const expected = `${prefix}_`;
  if (!value.startsWith(expected)) {
    return false;
  }
  return isValidUlid(value.slice(expected.length));
}

export function parseTypedId<P extends IdPrefix>(
  prefix: P,
  value: string,
): Result<TypedId<P>, IrohaError> {
  if (isTypedId(prefix, value)) {
    return ok(value);
  }
  return err(
    new IrohaError("INVALID_INPUT", `Expected a "${prefix}_" prefixed ULID, got "${value}"`, {
      details: { prefix, value },
    }),
  );
}

export function makeTypedId<P extends IdPrefix>(
  prefix: P,
  clock: Clock,
  random: RandomSource,
): TypedId<P> {
  return `${prefix}_${generateUlid(clock, random)}` as TypedId<P>;
}

/** Accepts any prefix that can appear as a `schemas/canonical-v1.schema.json` `entityId`. */
export function isCanonicalEntityId(value: string): value is TypedId<CanonicalIdPrefix> {
  return CANONICAL_ID_PREFIXES.some((prefix) => isTypedId(prefix, value));
}

export function parseCanonicalEntityId(
  value: string,
): Result<TypedId<CanonicalIdPrefix>, IrohaError> {
  if (isCanonicalEntityId(value)) {
    return ok(value);
  }
  return err(
    new IrohaError("INVALID_INPUT", `"${value}" is not a valid canonical entity ID`, {
      details: { value },
    }),
  );
}
