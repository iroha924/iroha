/**
 * Ranking-quality metrics for the search evaluation gate (database-schema.md §14).
 * All operate on a ranked list of entity ids and a set of relevant ids (binary
 * relevance). `@k` truncates the ranked list to its first `k` entries.
 */

/** Fraction of relevant items that appear in the top-`k`. */
export function recallAtK(
  ranked: readonly string[],
  relevant: ReadonlySet<string>,
  k: number,
): number {
  if (relevant.size === 0) {
    return 1;
  }
  let hits = 0;
  for (const id of ranked.slice(0, k)) {
    if (relevant.has(id)) {
      hits += 1;
    }
  }
  return hits / relevant.size;
}

/** Reciprocal rank of the first relevant item within the top-`k` (0 if none). */
export function mrrAtK(
  ranked: readonly string[],
  relevant: ReadonlySet<string>,
  k: number,
): number {
  const top = ranked.slice(0, k);
  for (let index = 0; index < top.length; index += 1) {
    const id = top[index];
    if (id !== undefined && relevant.has(id)) {
      return 1 / (index + 1);
    }
  }
  return 0;
}

/** Normalized discounted cumulative gain over the top-`k` with binary gains. */
export function ndcgAtK(
  ranked: readonly string[],
  relevant: ReadonlySet<string>,
  k: number,
): number {
  const top = ranked.slice(0, k);
  let dcg = 0;
  for (let index = 0; index < top.length; index += 1) {
    const id = top[index];
    if (id !== undefined && relevant.has(id)) {
      dcg += 1 / Math.log2(index + 2);
    }
  }
  const idealCount = Math.min(relevant.size, k);
  let idcg = 0;
  for (let index = 0; index < idealCount; index += 1) {
    idcg += 1 / Math.log2(index + 2);
  }
  return idcg === 0 ? 1 : dcg / idcg;
}

export interface AggregateMetrics {
  recallAt10: number;
  ndcgAt10: number;
  mrrAt10: number;
}

/** Mean of each metric over a set of per-query ranked/relevant pairs. */
export function aggregate(
  results: ReadonlyArray<{ ranked: readonly string[]; relevant: ReadonlySet<string> }>,
): AggregateMetrics {
  if (results.length === 0) {
    return { recallAt10: 0, ndcgAt10: 0, mrrAt10: 0 };
  }
  let recall = 0;
  let ndcg = 0;
  let mrr = 0;
  for (const { ranked, relevant } of results) {
    recall += recallAtK(ranked, relevant, 10);
    ndcg += ndcgAtK(ranked, relevant, 10);
    mrr += mrrAtK(ranked, relevant, 10);
  }
  const n = results.length;
  return { recallAt10: recall / n, ndcgAt10: ndcg / n, mrrAt10: mrr / n };
}
