import { keepPreviousData, useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Link, useSearchParams } from "react-router-dom";
import { api, type KnowledgeStatusFilter } from "@/api/client.js";
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
import { useModalLinkState } from "@/lib/modal-route.js";
import { pageWindow, parsePage } from "@/lib/pagination.js";
import { KNOWLEDGE_TYPES, knowledgeStatusTone, knowledgeTypeTone } from "@/lib/status.js";

const KNOWLEDGE_STATUSES: readonly KnowledgeStatusFilter[] = [
  "approved",
  "imported",
  "superseded",
  "archived",
];

/**
 * What an unfiltered page shows: current knowledge, whichever way it got here.
 * The API's own default is `approved` alone, so this is sent explicitly —
 * leaving it off would hide every imported repository doc until a reader
 * thought to click a chip they had no reason to suspect existed. `superseded`
 * and `archived` stay opt-in; they are history, not current knowledge.
 */
const DEFAULT_STATUSES: readonly KnowledgeStatusFilter[] = ["approved", "imported"];

const PAGE_SIZE = 10;

/** A repeatable filter param, kept sorted so the query key is click-order-insensitive. */
function readFilter(params: URLSearchParams, key: string, allowed: readonly string[]): string[] {
  return params
    .getAll(key)
    .filter((v) => allowed.includes(v))
    .sort();
}

/**
 * Knowledge list with status/type filters and numbered pages
 * (contracts/dashboard-api.md §6). Both approved canonical knowledge and the
 * repository docs `init`/`sync` import (canonical.md §14) live here — the status
 * badge and filter are what tell them apart.
 *
 * Filters and page live in the URL, per the §2 state rules, so a filtered page is
 * linkable and changing a filter cannot leave a stale page number behind.
 *
 * Offset carries the same instability as the review queue's: a new approval
 * sorts to the front and repeats a row on the next page, and archiving one can
 * skip a row. Accepted for numbered pages, not argued away.
 */
export function KnowledgeList() {
  const { t } = useI18n();
  const linkState = useModalLinkState();
  const [params, setParams] = useSearchParams();

  const statuses = readFilter(params, "status", KNOWLEDGE_STATUSES) as KnowledgeStatusFilter[];
  const types = readFilter(
    params,
    "type",
    KNOWLEDGE_TYPES.map((ty) => ty.key),
  );
  const requestedPage = parsePage(params.get("page"));

  const setQuery = (
    next: { statuses?: string[]; types?: string[]; page?: number } = {},
  ): URLSearchParams => {
    const nextParams = new URLSearchParams();
    for (const s of next.statuses ?? statuses) nextParams.append("status", s);
    for (const ty of next.types ?? types) nextParams.append("type", ty);
    nextParams.set("page", String(next.page ?? 1));
    return nextParams;
  };

  const q = useQuery({
    queryKey: ["knowledge", statuses.join(","), types.join(","), requestedPage],
    queryFn: () =>
      api.knowledge({
        limit: PAGE_SIZE,
        offset: (requestedPage - 1) * PAGE_SIZE,
        statuses: statuses.length > 0 ? statuses : [...DEFAULT_STATUSES],
        ...(types.length > 0 ? { types } : {}),
      }),
    // Keep the current rows on screen while a filter or page change refetches.
    placeholderData: keepPreviousData,
  });

  const total = q.data?.total ?? 0;
  const pageCount = Math.max(1, Math.ceil(total / PAGE_SIZE));
  // A deep link can name a page past the end — of the whole list, or of a filter
  // that matches fewer rows. Only clamp against data for the current key:
  // `keepPreviousData` keeps the outgoing view on screen across a change, and
  // comparing the incoming page to the outgoing page count rewrites a valid deep
  // link back to page 1.
  useEffect(() => {
    if (q.data !== undefined && !q.isPlaceholderData && requestedPage > pageCount) {
      setParams(setQuery({ page: pageCount }), { replace: true });
    }
  }, [q.data, q.isPlaceholderData, requestedPage, pageCount, setParams, setQuery]);

  const page = Math.min(requestedPage, pageCount);
  const items = q.data?.items ?? [];
  const filtered = statuses.length > 0 || types.length > 0;

  const toggle = (key: "statuses" | "types", value: string) => {
    const current = key === "statuses" ? statuses : types;
    const next = current.includes(value)
      ? current.filter((x) => x !== value)
      : [...current, value].sort();
    setParams(setQuery({ [key]: next, page: 1 }));
  };

  const goTo = (next: number) =>
    setParams(setQuery({ page: Math.min(Math.max(1, next), pageCount) }));
  const hrefFor = (next: number) =>
    `?${setQuery({ page: Math.min(Math.max(1, next), pageCount) }).toString()}`;

  return (
    <section>
      <PageHeader eyebrow={t("nav.knowledge")} title={t("knowledge.title")} />

      <div className="mb-6 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">
            {t("common.status")}
          </span>
          {KNOWLEDGE_STATUSES.map((s) => (
            <FilterChip key={s} active={statuses.includes(s)} onClick={() => toggle("statuses", s)}>
              {t(`status.${s}`)}
            </FilterChip>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">
            {t("search.filterByType")}
          </span>
          {KNOWLEDGE_TYPES.map((ty) => (
            <FilterChip
              key={ty.key}
              active={types.includes(ty.key)}
              onClick={() => toggle("types", ty.key)}
            >
              {t(`ktype.${ty.key}`)}
            </FilterChip>
          ))}
        </div>
      </div>

      {q.isPending && <Loading />}
      {q.isError && <ErrorState />}
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
                    state={linkState}
                    className="flex items-center gap-3 px-5 py-4 transition-colors hover:bg-paper-inset"
                  >
                    <Badge variant={knowledgeTypeTone(item.type)}>{t(`ktype.${item.type}`)}</Badge>
                    <Badge variant={knowledgeStatusTone(item.status)}>
                      {t(`status.${item.status}`)}
                    </Badge>
                    <span className="flex-1 truncate font-medium text-ink">{item.title}</span>
                    <span className="shrink-0 text-xs tabular-nums text-ink-faint">
                      {t("knowledge.authority")} {item.authority}
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
