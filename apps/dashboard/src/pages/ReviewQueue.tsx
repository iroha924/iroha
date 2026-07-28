import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type CandidateStatusFilter } from "@/api/client.js";
import { EmptyState, ErrorState, FilterChip, Loading, PageHeader } from "@/components/brand.js";
import { Badge } from "@/components/ui/badge.js";
import {
  Pagination,
  PaginationContent,
  PaginationEllipsis,
  PaginationItem,
  PaginationLink,
  PaginationNext,
  PaginationPrevious,
} from "@/components/ui/pagination.js";
import { useI18n } from "@/i18n/index.js";
import { candidateStatusTone } from "@/lib/status.js";

const CANDIDATE_STATUSES: readonly CandidateStatusFilter[] = [
  "pending",
  "approved",
  "rejected",
  "superseded",
];

const PAGE_SIZE = 10;

/** Numbered buttons to render, with `null` standing in for an ellipsis. */
function pageWindow(current: number, count: number): Array<number | null> {
  if (count <= 7) {
    return Array.from({ length: count }, (_, i) => i + 1);
  }
  const window = new Set([1, count, current, current - 1, current + 1]);
  const pages = Array.from(window)
    .filter((n) => n >= 1 && n <= count)
    .sort((a, b) => a - b);
  const withGaps: Array<number | null> = [];
  for (const [i, page] of pages.entries()) {
    const previous = pages[i - 1];
    if (previous !== undefined && page - previous > 1) {
      withGaps.push(null);
    }
    withGaps.push(page);
  }
  return withGaps;
}

/**
 * Review queue (contracts/dashboard-api.md §6): candidates by status, ten per page.
 *
 * Status and page live in the URL, per the §2 state rules, so a page is
 * linkable and changing the filter cannot leave a stale page number behind.
 * The API cursor is opaque rather than an offset, so page N is the Nth fetched
 * keyset page and reaching it walks forward from the first — hence the effect
 * below rather than a direct jump.
 */
export function ReviewQueue() {
  const { t } = useI18n();
  const [params, setParams] = useSearchParams();

  const statusParam = params.get("status");
  const status: CandidateStatusFilter = CANDIDATE_STATUSES.includes(
    statusParam as CandidateStatusFilter,
  )
    ? (statusParam as CandidateStatusFilter)
    : "pending";
  const requestedPage = Math.max(1, Number(params.get("page") ?? "1") || 1);

  const q = useInfiniteQuery({
    queryKey: ["candidates", status],
    queryFn: ({ pageParam }) =>
      api.candidates({
        ...(pageParam !== undefined ? { cursor: pageParam } : {}),
        status,
        limit: PAGE_SIZE,
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 5000,
    // Keep the current rows on screen while a status change refetches.
    placeholderData: keepPreviousData,
  });

  const total = q.data?.pages[0]?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // The queue shrinks under the reader — approving a candidate removes it, and
  // the list polls — so the page in the URL can outrun the queue. Fall back to
  // the last page that exists instead of rendering nothing.
  const page = Math.min(requestedPage, pageCount);

  const loadedPages = q.data?.pages.length ?? 0;
  const needsMore = loadedPages > 0 && loadedPages < page && q.hasNextPage;

  // Walk forward until the requested page is loaded: a deep link to page 3
  // costs three round-trips because the cursor cannot be computed for a page
  // the client has not seen.
  useEffect(() => {
    if (needsMore && !q.isFetchingNextPage) {
      void q.fetchNextPage();
    }
  }, [needsMore, q.isFetchingNextPage, q.fetchNextPage]);

  const items = q.data?.pages[page - 1]?.items ?? [];
  // The default queue view is the pending tab; any other tab is a filtered view.
  const filtered = status !== "pending";

  const goTo = (next: number) => {
    const clamped = Math.min(Math.max(1, next), pageCount);
    setParams({ status, page: String(clamped) });
  };
  const hrefFor = (next: number) =>
    `?status=${status}&page=${Math.min(Math.max(1, next), pageCount)}`;

  return (
    <section>
      <PageHeader eyebrow={t("nav.review")} title={t("review.title")} />

      <div className="mb-6 flex flex-wrap items-center gap-2">
        <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">
          {t("common.status")}
        </span>
        {CANDIDATE_STATUSES.map((s) => (
          <FilterChip
            key={s}
            active={status === s}
            onClick={() => setParams({ status: s, page: "1" })}
          >
            {t(`status.${s}`)}
          </FilterChip>
        ))}
      </div>

      {q.isPending && <Loading />}
      {q.isError && <ErrorState />}
      {q.data !== undefined &&
        (total === 0 ? (
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
              {items.length === 0 && needsMore && (
                <li className="px-5 py-4">
                  <Loading />
                </li>
              )}
            </ul>

            {pageCount > 1 && (
              <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs tabular-nums text-ink-faint">
                  {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} / {total}
                </span>
                <Pagination className="mx-0 w-auto justify-end">
                  <PaginationContent>
                    <PaginationItem>
                      <PaginationPrevious
                        href={hrefFor(page - 1)}
                        text={t("common.previous")}
                        aria-disabled={page === 1}
                        className={page === 1 ? "pointer-events-none opacity-40" : undefined}
                        onClick={(e) => {
                          e.preventDefault();
                          goTo(page - 1);
                        }}
                      />
                    </PaginationItem>
                    {pageWindow(page, pageCount).map((n, i) =>
                      n === null ? (
                        <PaginationItem key={`gap-${i}`}>
                          <PaginationEllipsis />
                        </PaginationItem>
                      ) : (
                        <PaginationItem key={n}>
                          <PaginationLink
                            href={hrefFor(n)}
                            isActive={n === page}
                            onClick={(e) => {
                              e.preventDefault();
                              goTo(n);
                            }}
                          >
                            {n}
                          </PaginationLink>
                        </PaginationItem>
                      ),
                    )}
                    <PaginationItem>
                      <PaginationNext
                        href={hrefFor(page + 1)}
                        text={t("common.next")}
                        aria-disabled={page === pageCount}
                        className={
                          page === pageCount ? "pointer-events-none opacity-40" : undefined
                        }
                        onClick={(e) => {
                          e.preventDefault();
                          goTo(page + 1);
                        }}
                      />
                    </PaginationItem>
                  </PaginationContent>
                </Pagination>
              </div>
            )}
          </>
        ))}
    </section>
  );
}
