import { keepPreviousData, useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type SessionPlatformFilter } from "@/api/client.js";
import { flattenPages } from "@/api/pagination.js";
import {
  EmptyState,
  ErrorState,
  FilterChip,
  Loading,
  LoadMore,
  PageHeader,
} from "@/components/brand.js";
import { DateField } from "@/components/date-field.js";
import { Badge } from "@/components/ui/badge.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table.js";
import { useI18n } from "@/i18n/index.js";
import { runStatusTone } from "@/lib/status.js";

const PLATFORMS: readonly SessionPlatformFilter[] = ["claude_code", "codex"];

/** Session list with platform/date filters and cursor pagination (dashboard-api.md §6). No per-person metric (FR-108). */
export function Sessions() {
  const { t } = useI18n();
  // "" means all platforms; the date inputs are bare YYYY-MM-DD (treated as UTC days).
  const [platform, setPlatform] = useState<SessionPlatformFilter | "">("");
  const [from, setFrom] = useState("");
  const [to, setTo] = useState("");

  const q = useInfiniteQuery({
    queryKey: ["sessions", platform, from, to],
    queryFn: ({ pageParam }) =>
      api.sessions({
        ...(pageParam !== undefined ? { cursor: pageParam } : {}),
        ...(platform !== "" ? { platform } : {}),
        // `to` is compared with `last_seen_at <= ?`, so widen the bare date to the
        // end of that UTC day; otherwise the selected day is excluded entirely.
        ...(from !== "" ? { from: `${from}T00:00:00.000Z` } : {}),
        ...(to !== "" ? { to: `${to}T23:59:59.999Z` } : {}),
      }),
    initialPageParam: undefined as string | undefined,
    getNextPageParam: (last) => last.nextCursor ?? undefined,
    refetchInterval: 5000,
    // Keep the current rows on screen while a filter change refetches, so
    // switching platform/date never flashes the loader (delay-show handles the
    // very first load; this handles subsequent filter changes).
    placeholderData: keepPreviousData,
  });

  const items = q.data !== undefined ? flattenPages(q.data.pages) : [];
  const filtered = platform !== "" || from !== "" || to !== "";

  return (
    <section>
      <PageHeader title={t("sessions.title")} />

      <div className="mb-6 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="mr-1 text-xs font-semibold uppercase tracking-wide text-ink-faint">
            {t("sessions.platform")}
          </span>
          <FilterChip active={platform === ""} onClick={() => setPlatform("")}>
            {t("common.all")}
          </FilterChip>
          {PLATFORMS.map((p) => (
            <FilterChip key={p} active={platform === p} onClick={() => setPlatform(p)}>
              {t(`platform.${p}`)}
            </FilterChip>
          ))}
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <DateField
            value={from}
            onChange={setFrom}
            max={to}
            placeholder={t("sessions.from")}
            ariaLabel={t("sessions.from")}
          />
          <span className="text-ink-faint">–</span>
          <DateField
            value={to}
            onChange={setTo}
            min={from}
            placeholder={t("sessions.to")}
            ariaLabel={t("sessions.to")}
          />
          <span className="ml-1 text-xs uppercase tracking-wide text-ink-faint">
            {t("sessions.datesUtc")}
          </span>
        </div>
      </div>

      {q.isPending && <Loading />}
      {q.isError && <ErrorState />}
      {q.data !== undefined &&
        (items.length === 0 ? (
          <EmptyState message={filtered ? t("common.noMatches") : t("sessions.empty")} />
        ) : (
          <>
            <div className="overflow-hidden rounded-2xl border border-hairline bg-paper-raised">
              <Table>
                <TableHeader>
                  <TableRow>
                    <TableHead>{t("common.status")}</TableHead>
                    <TableHead>{t("sessions.platform")}</TableHead>
                    <TableHead>{t("session.branch")}</TableHead>
                    <TableHead className="text-right">{t("sessions.runs")}</TableHead>
                    <TableHead className="text-right">{t("sessions.lastSeen")}</TableHead>
                  </TableRow>
                </TableHeader>
                <TableBody>
                  {items.map((s) => (
                    <TableRow key={s.id}>
                      <TableCell>
                        <Badge variant={runStatusTone(s.latestRunStatus)}>
                          {s.latestRunStatus ?? s.platform}
                        </Badge>
                      </TableCell>
                      <TableCell>
                        <Link
                          to={`/sessions/${s.id}`}
                          className="font-medium text-ink transition-colors hover:text-matcha"
                        >
                          {s.platform}
                        </Link>
                      </TableCell>
                      <TableCell className="font-mono text-xs text-ink-muted">
                        {s.latestBranch ?? "—"}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-ink-muted">
                        {s.runCount}
                      </TableCell>
                      <TableCell className="text-right tabular-nums text-ink-faint">
                        {s.lastSeenAt.slice(0, 10)}
                      </TableCell>
                    </TableRow>
                  ))}
                </TableBody>
              </Table>
            </div>
            {q.hasNextPage && (
              <LoadMore onClick={() => q.fetchNextPage()} loading={q.isFetchingNextPage} />
            )}
          </>
        ))}
    </section>
  );
}
