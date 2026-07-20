import { err, IrohaError, ok, type Result } from "@iroha/domain";
import { z } from "zod";

/**
 * Voyage AI text-embeddings integration (docs.voyageai.com/reference/embeddings-api).
 * The provider/model/dimension are fixed by OQ-005 (`voyage`/`voyage-4-large`/1024);
 * the values here are defaults the caller (`@iroha/core`, which owns config)
 * may override to match `.iroha/config.yaml`.
 */
const DEFAULT_MODEL = "voyage-4-large";
const DEFAULT_DIMENSION = 1024;
const DEFAULT_ENDPOINT = "https://api.voyageai.com/v1/embeddings";
/** Voyage's hard per-request input cap. The caller batches below this. */
const MAX_BATCH = 1000;

export type EmbeddingInputType = "query" | "document";

export interface EmbeddingProvider {
  /**
   * Embeds `texts` in input order, one vector per input. Any failure (network,
   * non-2xx, malformed body) degrades to a `Result` error with code
   * `EMBEDDING_UNAVAILABLE` — it never throws and never puts the API key into
   * the error message, `details`, or `cause` (secure-subprocess-and-credentials.md).
   */
  embed(
    texts: readonly string[],
    inputType: EmbeddingInputType,
  ): Promise<Result<number[][], IrohaError>>;
}

export interface VoyageProviderOptions {
  apiKey: string;
  model?: string;
  dimension?: number;
  endpoint?: string;
  /** Injected in tests; defaults to the global `fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Voyage's 200 body. Validated at this external boundary with `safeParse`
 * (CLAUDE.md: "Validate every external boundary with Zod"). Unknown top-level
 * keys (`usage`, `model`) are ignored; `data[].index` lets us restore input
 * order regardless of the order the API returns rows in.
 */
const voyageResponseSchema = z.object({
  data: z.array(
    z.object({
      embedding: z.array(z.number()),
      index: z.number().int().nonnegative(),
    }),
  ),
});

/** `EMBEDDING_UNAVAILABLE` with a message that carries no request detail beyond an HTTP status. */
function unavailable(message: string, retryable: boolean): IrohaError {
  return new IrohaError("EMBEDDING_UNAVAILABLE", message, { retryable });
}

export function createVoyageProvider(options: VoyageProviderOptions): EmbeddingProvider {
  const model = options.model ?? DEFAULT_MODEL;
  const dimension = options.dimension ?? DEFAULT_DIMENSION;
  const endpoint = options.endpoint ?? DEFAULT_ENDPOINT;
  const doFetch = options.fetchImpl ?? fetch;

  return {
    async embed(texts, inputType) {
      if (texts.length === 0) {
        return ok([]);
      }
      if (texts.length > MAX_BATCH) {
        return err(
          new IrohaError("INVALID_INPUT", `Embedding batch exceeds ${MAX_BATCH} inputs`, {
            details: { count: texts.length },
          }),
        );
      }

      let response: Response;
      try {
        response = await doFetch(endpoint, {
          method: "POST",
          headers: {
            // The key lives only in this header — never logged, never in errors.
            Authorization: `Bearer ${options.apiKey}`,
            "Content-Type": "application/json",
          },
          body: JSON.stringify({
            input: texts,
            model,
            input_type: inputType,
            output_dimension: dimension,
          }),
        });
      } catch {
        // Network-level failure (DNS, connection reset, timeout). The thrown
        // error can reference the endpoint but never the key; we still discard
        // it rather than attaching a raw cause, and report a retryable degrade.
        return err(unavailable("Voyage embeddings request failed (network)", true));
      }

      if (!response.ok) {
        // Body is not read: it can echo request context and is not needed to
        // decide retry. 429/5xx are transient; 4xx (bad request/auth) are not.
        const retryable = response.status === 429 || response.status >= 500;
        return err(
          unavailable(`Voyage embeddings request failed (HTTP ${response.status})`, retryable),
        );
      }

      let json: unknown;
      try {
        json = await response.json();
      } catch {
        return err(unavailable("Voyage embeddings response was not valid JSON", false));
      }

      const parsed = voyageResponseSchema.safeParse(json);
      if (!parsed.success) {
        return err(unavailable("Voyage embeddings response had an unexpected shape", false));
      }
      if (parsed.data.data.length !== texts.length) {
        return err(
          unavailable("Voyage embeddings response count did not match the request", false),
        );
      }

      const vectors: number[][] = new Array(texts.length);
      for (const row of parsed.data.data) {
        if (row.index >= texts.length || vectors[row.index] !== undefined) {
          return err(unavailable("Voyage embeddings response had an invalid index", false));
        }
        if (row.embedding.length !== dimension) {
          return err(unavailable("Voyage embeddings response had an unexpected dimension", false));
        }
        vectors[row.index] = row.embedding;
      }
      return ok(vectors);
    },
  };
}
