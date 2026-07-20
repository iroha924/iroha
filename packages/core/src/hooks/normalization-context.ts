import { createHmac } from "node:crypto";
import { type Clock, makeTypedId, type RandomSource } from "@iroha/domain";
import type { Digest, NormalizationContext } from "@iroha/platform";

/**
 * Builds the per-invocation context an adapter needs to finalize a normalized
 * event. The digest is a repository-keyed HMAC-SHA-256 (the salt is the
 * per-repository secret managed by `@iroha/git`), so equal prompts/commands in
 * different repositories never share a digest and the raw text is never
 * recoverable from a stored digest (hooks-contract.md §5).
 */
export function createNormalizationContext(
  salt: Uint8Array,
  clock: Clock,
  random: RandomSource,
): NormalizationContext {
  const key = Buffer.from(salt);
  return {
    digest(value: string): Digest {
      const hex = createHmac("sha256", key).update(value, "utf8").digest("hex");
      return `hmac-sha256:${hex}`;
    },
    newEventId(): string {
      return makeTypedId("evt", clock, random);
    },
    occurredAt(): string {
      return clock.now().toISOString();
    },
  };
}
