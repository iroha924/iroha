import { EmptyState, PageHeader } from "@/components/brand.js";
import { useI18n } from "@/i18n/index.js";

/**
 * What `/graph` renders while the interactive Work Graph (`Graph.tsx`) is parked.
 * The route points here rather than mounting `Graph` behind a banner, so neither the
 * seed queries nor React Flow load for a view nobody can reach; resuming the work is
 * re-pointing the route in `App.tsx`.
 */
export function GraphComingSoon() {
  const { t } = useI18n();
  return (
    <section>
      <PageHeader eyebrow={t("graph.comingSoon")} title={t("graph.title")} />
      <EmptyState message={t("graph.parked")}>
        <p className="max-w-prose text-sm text-ink-muted">{t("graph.parkedDetail")}</p>
      </EmptyState>
    </section>
  );
}
