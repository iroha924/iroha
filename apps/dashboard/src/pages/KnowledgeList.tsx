import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type KnowledgeStatusFilter } from "@/api/client.js";
import { flattenPages } from "@/api/pagination.js";
import {
  EmptyState,
  ErrorNote,
  FilterChip,
  Loading,
  LoadMore,
  PageTitle,
  Pill,
} from "@/components/ui.js";
import { useI18n } from "@/i18n/index.js";

const KNOWLEDGE_STATUSES: readonly KnowledgeStatusFilter[] = ["approved", "superseded", "archived"];

/** The seven canonical knowledge `entity_type`s (a display-facing copy; the SPA cannot import core enums). */
const KNOWLEDGE_TYPES = [
  "decision",
  "rule",
  "concept",
  "insight",
  "incident",
  "pattern",
  "review_learning",
] as const;

/** Approved-knowledge list with status/type filters and cursor pagination (dashboard-api.md §6). */
export function KnowledgeList() {
  const { t } = useI18n();
  const [statuses, setStatuses] = useState<KnowledgeStatusFilter[]>([]);
  const [types, setTypes] = useState<string[]>([]);

  const q = useInfiniteQuery({
    // The sorted filter joins key the cache so toggling a chip refetches from
    // page 1 regardless of click order (the filters are order-insensitive).
    queryKey: ["knowledge", [...statuses].sort().join(","), [...types].sort().join(",")],
    queryFn: ({ pageParam }) =>
      api.knowledge({
        ...(pageParam !== undefined ? { cursor: pageParam } : {}),
        ...(statuses.length > 0 ? { statuses } : {}),
        ...(types.length > 0 ? { types } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
  });

  const toggleStatus = (s: KnowledgeStatusFilter) =>
    setStatuses((c) => (c.includes(s) ? c.filter((x) => x !== s) : [...c, s]));
  const toggleType = (ty: string) =>
    setTypes((c) => (c.includes(ty) ? c.filter((x) => x !== ty) : [...c, ty]));

  const items = q.data !== undefined ? flattenPages(q.data.pages) : [];
  const filtered = statuses.length > 0 || types.length > 0;

  return (
    <section>
      <PageTitle>{t("knowledge.title")}</PageTitle>
      <div className="mb-6 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-ink-faint">
            {t("common.status")}
          </span>
          {KNOWLEDGE_STATUSES.map((s) => (
            <FilterChip key={s} active={statuses.includes(s)} onClick={() => toggleStatus(s)}>
              {t(`status.${s}`)}
            </FilterChip>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-ink-faint">
            {t("search.filterByType")}
          </span>
          {KNOWLEDGE_TYPES.map((ty) => (
            <FilterChip key={ty} active={types.includes(ty)} onClick={() => toggleType(ty)}>
              {ty}
            </FilterChip>
          ))}
        </div>
      </div>
      {q.isPending && <Loading />}
      {q.isError && <ErrorNote />}
      {q.data !== undefined &&
        (items.length === 0 ? (
          <EmptyState message={filtered ? t("common.noMatches") : t("knowledge.empty")} />
        ) : (
          <>
            <ul className="divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline bg-paper-raised">
              {items.map((item) => (
                <li key={item.id}>
                  <Link
                    to={`/knowledge/${item.id}`}
                    className="flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-paper-inset"
                  >
                    <Pill tone="neutral">{item.type}</Pill>
                    <span className="flex-1 font-medium text-ink">{item.title}</span>
                    <span className="text-xs tabular-nums text-ink-faint">
                      {t("knowledge.authority")} {item.authority}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
            {q.hasNextPage && (
              <LoadMore onClick={() => q.fetchNextPage()} loading={q.isFetchingNextPage} />
            )}
          </>
        ))}
    </section>
  );
}
