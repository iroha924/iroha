import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/api/client.js";
import { EmptyState, ErrorState, FilterChip, Loading, PageHeader } from "@/components/brand.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Input } from "@/components/ui/input.js";
import { useI18n } from "@/i18n/index.js";
import { cn } from "@/lib/utils";

/**
 * The knowledge entity types that can appear in search results — `search_documents`
 * is populated only from approved canonical knowledge (packages/core/src/sync-canonical.ts),
 * so every result is one of these and links to its `/knowledge/:id` detail page.
 */
const KNOWLEDGE_TYPES = [
  "decision",
  "rule",
  "concept",
  "insight",
  "incident",
  "pattern",
  "review_learning",
] as const;

/** Natural-language search over approved knowledge (dashboard-api.md §6; FTS/hybrid via the API). */
export function Search() {
  const { t } = useI18n();
  const [input, setInput] = useState("");
  const [submitted, setSubmitted] = useState("");
  const [types, setTypes] = useState<string[]>([]);

  const q = useQuery({
    // Sorted so the same set of chips keys the same cache entry regardless of
    // click order (the filter itself is order-insensitive).
    queryKey: ["search", submitted, [...types].sort().join(",")],
    queryFn: () =>
      api.search(submitted, types.length > 0 ? { filters: { entityTypes: types } } : {}),
    enabled: submitted.length > 0,
    // Keep the current results on screen while a type-filter change refetches.
    placeholderData: keepPreviousData,
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(input.trim());
  };

  const toggleType = (type: string) =>
    setTypes((current) =>
      current.includes(type) ? current.filter((t) => t !== type) : [...current, type],
    );

  return (
    <section>
      <PageHeader title={t("search.title")} />

      <form onSubmit={onSubmit} className="mb-4 flex gap-2">
        <Input
          type="search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t("search.placeholder")}
          aria-label={t("search.title")}
          className="h-9 flex-1"
        />
        <Button type="submit">{t("search.run")}</Button>
      </form>

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">
          {t("search.filterByType")}
        </span>
        {KNOWLEDGE_TYPES.map((type) => (
          <FilterChip key={type} active={types.includes(type)} onClick={() => toggleType(type)}>
            {t(`ktype.${type}`)}
          </FilterChip>
        ))}
      </div>

      {/* Full spinner only on the first-ever search (no data yet). On a new term or a
          type toggle, `keepPreviousData` shows the prior results dimmed while the next
          fetch is in flight — feedback without the layout jump a spinner-over-results
          would cause. */}
      {q.isLoading && <Loading />}
      {q.isError && <ErrorState />}
      {q.data !== undefined && q.data.results.length === 0 && (
        <EmptyState message={t("search.empty")} />
      )}
      {q.data !== undefined && q.data.results.length > 0 && (
        <ul
          className={cn(
            "divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline bg-paper-raised",
            q.isPlaceholderData && "opacity-60 transition-opacity",
          )}
        >
          {q.data.results.map((r) => (
            <li key={r.id}>
              <Link
                to={`/knowledge/${r.id}`}
                className="block px-5 py-4 transition-colors hover:bg-paper-inset"
              >
                <div className="flex items-center gap-2.5">
                  <Badge variant="neutral">{t(`ktype.${r.type}`)}</Badge>
                  <span className="font-medium text-ink">{r.title}</span>
                </div>
                {r.summary !== null && (
                  <p className="mt-1.5 line-clamp-2 text-sm text-ink-muted">{r.summary}</p>
                )}
                <div className="mt-1.5 text-xs tabular-nums text-ink-faint">
                  {t("knowledge.authority")} {r.authority}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
