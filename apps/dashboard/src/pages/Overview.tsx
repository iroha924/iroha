import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client.js";
import { Card, ErrorNote, Loading, PageTitle } from "@/components/ui.js";
import { useI18n } from "@/i18n/index.js";

function Stat({ label, value, hero = false }: { label: string; value: number; hero?: boolean }) {
  return (
    <div>
      <div
        className={`font-display font-semibold tabular-nums text-ink ${hero ? "text-5xl" : "text-3xl"}`}
      >
        {value}
      </div>
      <div className="mt-1 text-sm text-ink-muted">{label}</div>
    </div>
  );
}

/**
 * Overview page (dashboard-api.md §6): knowledge-flow counts, one hero metric,
 * varied hierarchy. No per-person metric (FR-108 / NFR-008 forbid ranking).
 */
export function Overview() {
  const { t } = useI18n();
  const q = useQuery({ queryKey: ["overview"], queryFn: api.overview, refetchInterval: 5000 });

  if (q.isPending) return <Loading />;
  if (q.isError || q.data === undefined) return <ErrorNote />;
  const d = q.data;

  return (
    <section>
      <PageTitle>{t("nav.overview")}</PageTitle>
      <div className="grid gap-6 md:grid-cols-3">
        <Card className="flex items-center md:col-span-1">
          <Stat hero label={t("overview.pending")} value={d.pendingCandidates} />
        </Card>
        <div className="grid grid-cols-1 gap-6 sm:grid-cols-3 md:col-span-2">
          <Card>
            <Stat label={t("overview.approved")} value={d.approvedKnowledge} />
          </Card>
          <Card>
            <Stat label={t("overview.sessions")} value={d.sessions} />
          </Card>
          <Card>
            <Stat label={t("overview.dirty")} value={d.openDirtyMarkers} />
          </Card>
        </div>
      </div>
      <dl className="mt-8 grid gap-3 text-sm sm:grid-cols-2">
        <div className="flex justify-between border-b border-hairline pb-2">
          <dt className="text-ink-muted">{t("overview.oldestPending")}</dt>
          <dd className="text-ink">{d.oldestPendingCreatedAt ?? t("common.none")}</dd>
        </div>
        <div className="flex justify-between border-b border-hairline pb-2">
          <dt className="text-ink-muted">{t("overview.lastSync")}</dt>
          <dd className="text-ink">{d.lastCanonicalSyncAt ?? t("common.none")}</dd>
        </div>
      </dl>
    </section>
  );
}
