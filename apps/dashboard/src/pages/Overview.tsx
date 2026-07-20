import { useQuery } from "@tanstack/react-query";
import { api } from "@/api/client.js";
import { useI18n } from "@/i18n/index.js";

function Stat({ label, value }: { label: string; value: number }) {
  return (
    <div className="rounded border border-slate-200 bg-white p-4">
      <div className="text-2xl font-semibold tabular-nums">{value}</div>
      <div className="mt-1 text-sm text-slate-500">{label}</div>
    </div>
  );
}

/**
 * Overview page (dashboard-api.md §6): knowledge-flow counts and freshness only.
 * Intentionally shows no per-person metric (FR-108 / NFR-008 forbid ranking).
 */
export function Overview() {
  const { t } = useI18n();
  const q = useQuery({ queryKey: ["overview"], queryFn: api.overview, refetchInterval: 5000 });

  if (q.isPending) return <p className="text-slate-500">{t("common.loading")}</p>;
  if (q.isError || q.data === undefined) return <p className="text-red-600">{t("common.error")}</p>;
  const d = q.data;

  return (
    <section>
      <h1 className="mb-4 text-lg font-semibold">{t("nav.overview")}</h1>
      <div className="grid grid-cols-2 gap-4 sm:grid-cols-4">
        <Stat label={t("overview.pending")} value={d.pendingCandidates} />
        <Stat label={t("overview.approved")} value={d.approvedKnowledge} />
        <Stat label={t("overview.sessions")} value={d.sessions} />
        <Stat label={t("overview.dirty")} value={d.openDirtyMarkers} />
      </div>
      <dl className="mt-6 space-y-1 text-sm text-slate-600">
        <div className="flex gap-2">
          <dt className="font-medium">{t("overview.oldestPending")}:</dt>
          <dd>{d.oldestPendingCreatedAt ?? t("common.none")}</dd>
        </div>
        <div className="flex gap-2">
          <dt className="font-medium">{t("overview.lastSync")}:</dt>
          <dd>{d.lastCanonicalSyncAt ?? t("common.none")}</dd>
        </div>
      </dl>
    </section>
  );
}
