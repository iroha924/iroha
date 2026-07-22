import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { Bar, BarChart, Cell, XAxis, YAxis } from "recharts";
import { api } from "@/api/client.js";
import { EmptyState, ErrorState, Loading, PageHeader } from "@/components/brand.js";
import { Badge } from "@/components/ui/badge.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.js";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart.js";
import { useI18n } from "@/i18n/index.js";

// The seven canonical knowledge types, each with a brand chart colour. Order and
// colours are stable so the composition chart reads consistently.
const KNOWLEDGE_TYPES = [
  { key: "decision", color: "var(--chart-1)" },
  { key: "rule", color: "var(--chart-2)" },
  { key: "concept", color: "var(--chart-3)" },
  { key: "insight", color: "var(--chart-4)" },
  { key: "incident", color: "var(--chart-5)" },
  { key: "pattern", color: "var(--color-ink-muted)" },
  { key: "review_learning", color: "var(--color-matcha-active)" },
] as const;

function runTone(status: string | null): "approve" | "pending" | "reject" | "neutral" {
  if (status === "active") return "approve";
  if (status === "interrupted") return "pending";
  if (status === "abandoned") return "reject";
  return "neutral";
}

function MiniStat({ label, value }: { label: string; value: number }) {
  return (
    <Card>
      <CardContent>
        <div className="font-display text-3xl font-semibold tabular-nums text-ink">{value}</div>
        <div className="mt-1 text-sm text-ink-muted">{label}</div>
      </CardContent>
    </Card>
  );
}

/**
 * Overview page (dashboard-api.md §6): pending-candidate pressure as the hero,
 * approved-knowledge composition by type, recent Sessions, and sync/dirty
 * status. No per-person metric (FR-108 / NFR-008 forbid ranking).
 */
export function Overview() {
  const { t } = useI18n();
  const q = useQuery({ queryKey: ["overview"], queryFn: api.overview, refetchInterval: 5000 });

  if (q.isPending) return <Loading />;
  if (q.isError || q.data === undefined) return <ErrorState />;
  const d = q.data;

  const chartData = KNOWLEDGE_TYPES.map((type) => ({
    key: type.key,
    label: t(`ktype.${type.key}`),
    count: d.approvedKnowledgeByType[type.key] ?? 0,
    fill: type.color,
  })).filter((row) => row.count > 0);
  const chartConfig = { count: { label: t("overview.approved") } } satisfies ChartConfig;

  return (
    <section>
      <PageHeader
        eyebrow={t("overview.eyebrow")}
        title={t("nav.overview")}
        description={t("overview.subtitle")}
      />

      <div className="grid gap-6 lg:grid-cols-3">
        <Card className="justify-center lg:col-span-1">
          <CardHeader>
            <CardDescription>{t("overview.pending")}</CardDescription>
          </CardHeader>
          <CardContent>
            <div className="font-display text-6xl font-semibold tabular-nums text-ink">
              {d.pendingCandidates}
            </div>
          </CardContent>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>
            <CardTitle>{t("overview.composition")}</CardTitle>
          </CardHeader>
          <CardContent>
            {chartData.length === 0 ? (
              <p className="py-10 text-center text-sm text-ink-muted">
                {t("overview.noKnowledge")}
              </p>
            ) : (
              <>
                <p className="sr-only">
                  {chartData.map((row) => `${row.label}: ${row.count}`).join(", ")}
                </p>
                <ChartContainer config={chartConfig} className="h-[220px] w-full">
                  <BarChart
                    accessibilityLayer
                    layout="vertical"
                    data={chartData}
                    margin={{ left: 8, right: 16 }}
                  >
                    <XAxis type="number" dataKey="count" hide />
                    <YAxis
                      type="category"
                      dataKey="label"
                      tickLine={false}
                      axisLine={false}
                      width={110}
                      tick={{ fill: "var(--color-ink-muted)", fontSize: 12 }}
                    />
                    <ChartTooltip cursor={false} content={<ChartTooltipContent hideLabel />} />
                    <Bar dataKey="count" radius={6} barSize={18}>
                      {chartData.map((row) => (
                        <Cell key={row.key} fill={row.fill} />
                      ))}
                    </Bar>
                  </BarChart>
                </ChartContainer>
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <div className="mt-6 grid gap-6 sm:grid-cols-3">
        <MiniStat label={t("overview.approved")} value={d.approvedKnowledge} />
        <MiniStat label={t("overview.sessions")} value={d.sessions} />
        <MiniStat label={t("overview.dirty")} value={d.openDirtyMarkers} />
      </div>

      <div className="mt-8 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>{t("overview.recentSessions")}</CardTitle>
          </CardHeader>
          <CardContent className="px-0">
            {d.recentSessions.length === 0 ? (
              <EmptyState message={t("sessions.empty")} />
            ) : (
              <ul className="divide-y divide-hairline">
                {d.recentSessions.map((s) => (
                  <li key={s.id}>
                    <Link
                      to={`/sessions/${s.id}`}
                      className="flex items-center justify-between gap-3 px-6 py-3 transition-colors hover:bg-paper-inset"
                    >
                      <span className="flex items-center gap-2.5">
                        <Badge variant={runTone(s.latestRunStatus)}>
                          {s.latestRunStatus ?? s.platform}
                        </Badge>
                        <span className="text-sm font-medium text-ink">{s.platform}</span>
                      </span>
                      <span className="text-xs tabular-nums text-ink-faint">
                        {s.lastSeenAt.slice(0, 10)}
                      </span>
                    </Link>
                  </li>
                ))}
              </ul>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle>{t("overview.status")}</CardTitle>
          </CardHeader>
          <CardContent>
            <dl className="space-y-3 text-sm">
              <div className="flex justify-between border-b border-hairline pb-2.5">
                <dt className="text-ink-muted">{t("overview.oldestPending")}</dt>
                <dd className="tabular-nums text-ink">
                  {d.oldestPendingCreatedAt?.slice(0, 10) ?? t("common.none")}
                </dd>
              </div>
              <div className="flex justify-between border-b border-hairline pb-2.5">
                <dt className="text-ink-muted">{t("overview.lastSync")}</dt>
                <dd className="tabular-nums text-ink">
                  {d.lastCanonicalSyncAt?.slice(0, 10) ?? t("common.none")}
                </dd>
              </div>
              <div className="flex justify-between">
                <dt className="text-ink-muted">{t("overview.dirty")}</dt>
                <dd className="tabular-nums text-ink">{d.openDirtyMarkers}</dd>
              </div>
            </dl>
          </CardContent>
        </Card>
      </div>
    </section>
  );
}
