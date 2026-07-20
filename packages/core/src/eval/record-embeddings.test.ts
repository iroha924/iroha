import { writeFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import { createVoyageProvider } from "@iroha/search";
import { describe, expect, it } from "vitest";
import { DOCS, docEmbeddingText, QUERIES } from "./fixture.js";

/**
 * One-time recorder for the evaluation gate's vectors. It is the ONLY code that
 * calls the live Voyage API, and it is skipped unless `IROHA_RECORD_EMBEDDINGS=1`
 * so ordinary `pnpm test` runs stay fully offline (CLAUDE.md: no external calls
 * in tests/CI). Run it once with a real key to regenerate the committed
 * `embeddings.recorded.json`, which the deterministic gate then replays:
 *
 *   IROHA_RECORD_EMBEDDINGS=1 pnpm --filter @iroha/core exec vitest run record-embeddings
 */
const RECORD = process.env.IROHA_RECORD_EMBEDDINGS === "1";

describe("record embeddings", () => {
  it.runIf(RECORD)(
    "records corpus and query embeddings to embeddings.recorded.json",
    async () => {
      const apiKey = process.env.VOYAGE_API_KEY;
      expect(apiKey, "VOYAGE_API_KEY must be set to record").toBeTruthy();
      if (apiKey === undefined) {
        return;
      }
      const provider = createVoyageProvider({
        apiKey,
        model: "voyage-4-large",
        dimension: 1024,
      });

      const corpusResult = await provider.embed(DOCS.map(docEmbeddingText), "document");
      expect(corpusResult.ok, corpusResult.ok ? "" : corpusResult.error.message).toBe(true);
      if (!corpusResult.ok) {
        return;
      }
      const queryResult = await provider.embed(
        QUERIES.map((query) => query.text),
        "query",
      );
      expect(queryResult.ok, queryResult.ok ? "" : queryResult.error.message).toBe(true);
      if (!queryResult.ok) {
        return;
      }

      // Round to 6 significant decimals to keep the committed fixture compact;
      // float32 vectors carry far less precision than that anyway.
      const round = (vector: number[]): number[] => vector.map((value) => Number(value.toFixed(6)));
      const corpus: Record<string, number[]> = {};
      DOCS.forEach((doc, index) => {
        const vector = corpusResult.value[index];
        if (vector !== undefined) {
          corpus[doc.id] = round(vector);
        }
      });
      const queries: Record<string, number[]> = {};
      QUERIES.forEach((query, index) => {
        const vector = queryResult.value[index];
        if (vector !== undefined) {
          queries[query.id] = round(vector);
        }
      });

      const outPath = fileURLToPath(new URL("./embeddings.recorded.json", import.meta.url));
      await writeFile(
        outPath,
        `${JSON.stringify({ model: "voyage-4-large", dimension: 1024, corpus, queries })}\n`,
      );
    },
    120_000,
  );
});
