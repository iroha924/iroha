import { keepPreviousData, useQuery } from "@tanstack/react-query";
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

/** A page number from the URL: whole, at least 1, and never NaN. */
function parsePage(raw: string | null): number {
  const n = Number(raw ?? "1");
  return Number.isInteger(n) && n >= 1 ? n : 1;
}

/**
 * Review queue (contracts/dashboard-api.md §6): candidates by status, ten per page.
 *
 * Status and page live in the URL, per the §2 state rules, so a page is
 * linkable and changing the filter cannot leave a stale page number behind.
 * Pages are addressed by `offset` rather than by walking the keyset cursor
 * forward: any page is one request, so there is no chain to replay on a deep
 * link and no repeated fetch of the pages before it.
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
  const requestedPage = parsePage(params.get("page"));

  const q = useQuery({
    queryKey: ["candidates", status, requestedPage],
    queryFn: () =>
      api.candidates({ status, limit: PAGE_SIZE, offset: (requestedPage - 1) * PAGE_SIZE }),
    refetchInterval: 5000,
    // Keep the current rows on screen while a status or page change refetches.
    placeholderData: keepPreviousData,
  });

  const total = q.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // The queue shrinks under the reader — approving a candidate removes it, and
  // the list polls — so the page in the URL can outrun the queue. The offset is
  // built from the URL, so correcting the display alone would leave the request
  // asking past the end; rewrite the URL and let the query follow it.
  //
  // Only against data that belongs to the current key. `keepPreviousData` keeps
  // the outgoing view on screen across a status or page change, so without this
  // guard the clamp compares the incoming page number to the outgoing view's
  // page count — and a deep link into a long queue, arrived at while a short
  // one is displayed, gets rewritten to page 1 with `replace` erasing the way
  // back.
  useEffect(() => {
    if (q.data !== undefined && !q.isPlaceholderData && requestedPage > pageCount) {
      setParams({ status, page: String(pageCount) }, { replace: true });
    }
  }, [q.data, q.isPlaceholderData, requestedPage, pageCount, status, setParams]);

  const page = Math.min(requestedPage, pageCount);
  const items = q.data?.items ?? [];
  // The default queue view is the pending tab; any other tab is a filtered view.
  const filtered = status !== "pending";

  const goTo = (next: number) => {
    setParams({ status, page: String(Math.min(Math.max(1, next), pageCount)) });
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
        // Keyed on the rows, not on `total`: the two can only disagree if the
        // page number outran the queue, and an empty page is still "nothing to
        // show here" rather than a bordered box with nothing in it.
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
                    <Badge variant={candidateStatusTone(item.status)}>
                      {t(`ktype.${item.type}`)}
                    </Badge>
                    <span className="flex-1 truncate font-medium text-ink">{item.title}</span>
                    <span className="shrink-0 text-xs tabular-nums text-ink-faint">
                      {item.createdAt.slice(0, 10)}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>

            {pageCount > 1 && (
              <div className="mt-5 flex flex-wrap items-center justify-between gap-3">
                <span className="text-xs tabular-nums text-ink-faint">
                  {(page - 1) * PAGE_SIZE + 1}–{Math.min(page * PAGE_SIZE, total)} / {total}
                </span>
                <Pagination className="mx-0 w-auto justify-end" aria-label={t("common.pagination")}>
                  <PaginationContent>
                    <PaginationItem>
                      <PaginationPrevious
                        href={hrefFor(page - 1)}
                        text={t("common.previous")}
                        aria-label={t("common.previousPage")}
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
                        aria-label={t("common.nextPage")}
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
