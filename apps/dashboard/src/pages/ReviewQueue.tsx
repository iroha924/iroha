import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type CandidateStatusFilter } from "@/api/client.js";
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

const CANDIDATE_STATUSES: readonly CandidateStatusFilter[] = [
  "pending",
  "approved",
  "rejected",
  "superseded",
];

function statusTone(status: string): "approve" | "pending" | "reject" | "neutral" {
  if (status === "approved") return "approve";
  if (status === "pending") return "pending";
  if (status === "rejected") return "reject";
  return "neutral";
}

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
  });

  const items = q.data !== undefined ? flattenPages(q.data.pages) : [];

  return (
    <section>
      <PageTitle>{t("review.title")}</PageTitle>
      <div className="mb-6 flex flex-wrap items-center gap-2">
        <span className="text-xs uppercase tracking-wide text-ink-faint">{t("common.status")}</span>
        {CANDIDATE_STATUSES.map((s) => (
          <FilterChip key={s} active={status === s} onClick={() => setStatus(s)}>
            {t(`status.${s}`)}
          </FilterChip>
        ))}
      </div>
      {q.isPending && <Loading />}
      {q.isError && <ErrorNote />}
      {q.data !== undefined &&
        (items.length === 0 ? (
          <EmptyState message={t("review.empty")} />
        ) : (
          <>
            <ul className="divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline bg-paper-raised">
              {items.map((item) => (
                <li key={item.id}>
                  <Link
                    to={`/review/${item.id}`}
                    className="flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-paper-inset"
                  >
                    <Pill tone={statusTone(item.status)}>{item.type}</Pill>
                    <span className="flex-1 font-medium text-ink">{item.title}</span>
                    <span className="text-xs tabular-nums text-ink-faint">
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
