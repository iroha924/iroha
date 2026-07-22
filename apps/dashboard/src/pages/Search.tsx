import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { Link } from "react-router-dom";
import { api } from "@/api/client.js";
import { btnPrimary, EmptyState, ErrorNote, Loading, PageTitle } from "@/components/ui.js";
import { useI18n } from "@/i18n/index.js";

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
      <PageTitle>{t("search.title")}</PageTitle>
      <form onSubmit={onSubmit} className="mb-4 flex gap-2">
        <input
          type="search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t("search.placeholder")}
          aria-label={t("search.title")}
          className="h-10 flex-1 rounded-xl border border-hairline bg-paper-raised px-3 text-ink placeholder:text-ink-faint focus:border-matcha focus:outline-none"
        />
        <button type="submit" className={btnPrimary}>
          {t("search.run")}
        </button>
      </form>
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-ink-faint">
          {t("search.filterByType")}
        </span>
        {KNOWLEDGE_TYPES.map((type) => {
          const active = types.includes(type);
          return (
            <button
              key={type}
              type="button"
              aria-pressed={active}
              onClick={() => toggleType(type)}
              className={`rounded-full border px-3 py-1 text-xs transition-colors ${
                active
                  ? "border-matcha bg-matcha text-paper-raised"
                  : "border-hairline bg-paper-raised text-ink-muted hover:bg-paper-inset"
              }`}
            >
              {type}
            </button>
          );
        })}
      </div>
      {q.isFetching && <Loading />}
      {q.isError && <ErrorNote />}
      {q.data !== undefined && q.data.results.length === 0 && (
        <EmptyState message={t("search.empty")} />
      )}
      {q.data !== undefined && q.data.results.length > 0 && (
        <ul className="divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline bg-paper-raised">
          {q.data.results.map((r) => (
            <li key={r.id}>
              <Link
                to={`/knowledge/${r.id}`}
                className="block px-5 py-4 transition-colors hover:bg-paper-inset"
              >
                <div className="font-medium text-ink">{r.title}</div>
                <div className="mt-0.5 text-sm text-ink-muted">{r.summary}</div>
                <div className="mt-1.5 text-xs text-ink-faint">
                  {r.type} · {t("knowledge.authority")} {r.authority}
                </div>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
