import { useQuery } from "@tanstack/react-query";
import { Bar, BarChart, Cell, XAxis, YAxis } from "recharts";
import { api } from "@/api/client.js";
import { EmptyState, ErrorState, Loading, PageHeader } from "@/components/brand.js";
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
 * Overview page (contracts/dashboard-api.md §6): pending-candidate pressure as the hero,
 * approved-knowledge composition by type, recent Sessions, and sync/dirty
 * status. No per-person metric — individual ranking is forbidden.
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

      <div className="mt-6 grid gap-6 sm:grid-cols-2">
        <MiniStat label={t("overview.approved")} value={d.approvedKnowledge} />
        <MiniStat label={t("overview.dirty")} value={d.openDirtyMarkers} />
      </div>
    </section>
  );
}
