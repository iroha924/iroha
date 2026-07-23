import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type CandidateStatusFilter } from "@/api/client.js";
import { flattenPages } from "@/api/pagination.js";
import {
  EmptyState,
  ErrorState,
  FilterChip,
  Loading,
  LoadMore,
  PageHeader,
} from "@/components/brand.js";
import { Badge } from "@/components/ui/badge.js";
import { useI18n } from "@/i18n/index.js";
import { candidateStatusTone } from "@/lib/status.js";

const CANDIDATE_STATUSES: readonly CandidateStatusFilter[] = [
  "pending",
  "approved",
  "rejected",
  "superseded",
];

/** Review queue (dashboard-api.md §6): candidates by status, with cursor pagination. */
export function ReviewQueue() {
  const { t } = useI18n();
  const [status, setStatus] = useState<CandidateStatusFilter>("pending");

  const q = useInfiniteQuery({
    queryKey: ["candidates", status],
    queryFn: ({ pageParam }) =>
      api.candidates({ ...(pageParam !== undefined ? { cursor: pageParam } : {}), status }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 5000,
    // Keep the current rows on screen while a status change refetches.
    placeholderData: keepPreviousData,
  });

  const items = q.data !== undefined ? flattenPages(q.data.pages) : [];
  // The default queue view is the pending tab; any other tab is a filtered view.
  const filtered = status !== "pending";

  return (
    <section>
      <PageHeader eyebrow={t("nav.review")} title={t("review.title")} />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">
          {t("common.status")}
        </span>
        {CANDIDATE_STATUSES.map((s) => (
          <FilterChip key={s} active={status === s} onClick={() => setStatus(s)}>
            {t(`status.${s}`)}
          </FilterChip>
        ))}
      </div>

      {q.isPending && <Loading />}
      {q.isError && <ErrorState />}
      {q.data !== undefined &&
        (items.length === 0 ? (
          <EmptyState message={filtered ? t("common.noMatches") : t("review.empty")} />
        ) : (
          <>
            <ul className="divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline bg-paper-raised">
              {items.map((item) => (
                <li key={item.id}>
                  <Link
                    to={`/review/${item.id}`}
                    className="flex items-center gap-3 px-5 py-4 transition-colors hover:bg-paper-inset"
                  >
                    <Badge variant={candidateStatusTone(item.status)}>{item.type}</Badge>
                    <span className="flex-1 truncate font-medium text-ink">{item.title}</span>
                    <span className="shrink-0 text-xs tabular-nums text-ink-faint">
                      {item.createdAt.slice(0, 10)}
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
