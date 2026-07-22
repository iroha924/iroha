import { useInfiniteQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Link } from "react-router-dom";
import { api, type SessionPlatformFilter } from "@/api/client.js";
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

const PLATFORMS: readonly SessionPlatformFilter[] = ["claude_code", "codex"];

function runTone(status: string | null): "approve" | "pending" | "reject" | "neutral" {
  if (status === "active") return "approve";
  if (status === "interrupted") return "pending";
  if (status === "abandoned") return "reject";
  return "neutral";
}

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
  });

  const items = q.data !== undefined ? flattenPages(q.data.pages) : [];
  const filtered = platform !== "" || from !== "" || to !== "";
  const dateInput =
    "h-9 rounded-xl border border-hairline bg-paper-raised px-3 text-sm text-ink focus:border-matcha focus:outline-none";

  return (
    <section>
      <PageTitle>{t("sessions.title")}</PageTitle>
      <div className="mb-6 flex flex-col gap-3">
        <div className="flex flex-wrap items-center gap-2">
          <span className="text-xs uppercase tracking-wide text-ink-faint">
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
        <div className="flex flex-wrap items-center gap-2 text-xs text-ink-faint">
          <label className="flex items-center gap-1.5">
            <span className="uppercase tracking-wide">{t("sessions.from")}</span>
            <input
              type="date"
              value={from}
              max={to || undefined}
              onChange={(e) => setFrom(e.target.value)}
              className={dateInput}
            />
          </label>
          <label className="flex items-center gap-1.5">
            <span className="uppercase tracking-wide">{t("sessions.to")}</span>
            <input
              type="date"
              value={to}
              min={from || undefined}
              onChange={(e) => setTo(e.target.value)}
              className={dateInput}
            />
          </label>
          <span className="uppercase tracking-wide">· {t("sessions.datesUtc")}</span>
        </div>
      </div>
      {q.isPending && <Loading />}
      {q.isError && <ErrorNote />}
      {q.data !== undefined &&
        (items.length === 0 ? (
          <EmptyState message={filtered ? t("common.noMatches") : t("sessions.empty")} />
        ) : (
          <>
            <ul className="divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline bg-paper-raised">
              {items.map((s) => (
                <li key={s.id}>
                  <Link
                    to={`/sessions/${s.id}`}
                    className="flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-paper-inset"
                  >
                    <Pill tone={runTone(s.latestRunStatus)}>{s.latestRunStatus ?? s.platform}</Pill>
                    <span className="flex-1 text-ink">
                      <span className="font-medium">{s.platform}</span>
                      {s.latestBranch !== null && (
                        <span className="ml-2 font-mono text-xs text-ink-muted">
                          {s.latestBranch}
                        </span>
                      )}
                    </span>
                    <span className="text-xs tabular-nums text-ink-faint">
                      {t("sessions.runs")} {s.runCount} · {s.lastSeenAt.slice(0, 10)}
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
