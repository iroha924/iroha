import { useQuery } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { Bar, BarChart, Cell, XAxis, YAxis } from "recharts";
import { api } from "@/api/client.js";
import { ErrorState, InfoTip, Loading, PageHeader } from "@/components/brand.js";
import { Badge } from "@/components/ui/badge.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.js";
import {
  type ChartConfig,
  ChartContainer,
  ChartTooltip,
  ChartTooltipContent,
} from "@/components/ui/chart.js";
import { useI18n } from "@/i18n/index.js";
import { KNOWLEDGE_TYPES } from "@/lib/status.js";

/** The three adequacy buckets, so every one is reported even at zero. */
const ADEQUACY_KINDS = ["enforceable", "not_hook_enforceable", "invalid"] as const;

function MiniStat({ label, value }: { label: ReactNode; value: number }) {
  return (
    <Card>
      <CardContent>
        <div className="font-display text-3xl font-semibold tabular-nums text-ink">{value}</div>
        <div className="mt-1 text-sm text-ink-muted">{label}</div>
      </CardContent>
    </Card>
  );
}

function CountRow({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-hairline border-b py-2 last:border-0">
      <span className="min-w-0 truncate text-sm text-ink">{label}</span>
      <span className="shrink-0 tabular-nums text-ink-muted">{count}</span>
    </div>
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

      <div className="mt-6 grid gap-6 sm:grid-cols-3">
        <MiniStat label={t("overview.approved")} value={d.approvedKnowledge} />
        <MiniStat
          label={<InfoTip label={t("overview.dirty")} explanation={t("overview.dirtyHint")} />}
          value={d.openDirtyMarkers}
        />
        <MiniStat
          label={
            <InfoTip
              label={t("overview.pendingLearnings")}
              explanation={t("overview.pendingLearningsHint")}
            />
          }
          value={d.pendingReviewLearnings}
        />
      </div>

      {/* The setup failing the agent is as much the story as the agent breaking a
          rule, and unlike a denial it is a defect the reader can go and fix. */}
      <Card className="mt-6">
        <CardHeader>
          <CardTitle>
            <InfoTip label={t("overview.adequacy")} explanation={t("overview.guardrailHint")} />
          </CardTitle>
          <CardDescription>{t("overview.adequacyNow")}</CardDescription>
        </CardHeader>
        <CardContent>
          <div className="grid gap-6 sm:grid-cols-3">
            {ADEQUACY_KINDS.map((kind) => (
              <div key={kind}>
                <div className="font-display text-3xl font-semibold tabular-nums text-ink">
                  {d.rulesetAdequacy[kind]}
                </div>
                <div className="mt-1 text-sm text-ink-muted">{t(`overview.adequacy.${kind}`)}</div>
              </div>
            ))}
          </div>
          <p className="mt-5 text-pretty text-xs text-ink-muted">{t("overview.adequacyHint")}</p>
        </CardContent>
      </Card>

      <div className="mt-6 grid gap-6 lg:grid-cols-2">
        <Card>
          <CardHeader>
            <CardTitle>
              {t("overview.denialsByRule").replace("{days}", String(d.denials.windowDays))}
            </CardTitle>
            {/* Denials live only in this clone's index, so saying whose numbers
                these are is not decoration: read as team-wide they are a lie. */}
            <CardDescription>{t("overview.denialsScope")}</CardDescription>
          </CardHeader>
          <CardContent>
            {d.denials.byRule.length === 0 ? (
              <p className="text-sm text-ink-faint">{t("overview.noDenials")}</p>
            ) : (
              <div>
                {d.denials.byRule.map((row) => (
                  <CountRow
                    key={row.ruleId ?? "unattributed"}
                    label={row.ruleTitle ?? row.ruleId ?? t("overview.unattributed")}
                    count={row.count}
                  />
                ))}
              </div>
            )}
          </CardContent>
        </Card>
        <Card>
          <CardHeader>
            <CardTitle>{t("overview.clusters")}</CardTitle>
            <CardDescription>{t("overview.denialsScope")}</CardDescription>
          </CardHeader>
          <CardContent>
            {d.denials.clusters.items.length === 0 ? (
              <p className="text-sm text-ink-faint">{t("overview.noClusters")}</p>
            ) : (
              <>
                <div className="flex flex-wrap gap-2">
                  {d.denials.clusters.items.map((cluster) => (
                    <Badge key={cluster.key} variant="pending">
                      <span className="font-mono text-[11px]">{cluster.key}</span>
                      <span className="tabular-nums">{cluster.count}</span>
                    </Badge>
                  ))}
                </div>
                {d.denials.clusters.truncated && (
                  <p className="mt-3 text-xs text-ink-faint">
                    {t("overview.clustersTruncated").replace(
                      "{total}",
                      String(d.denials.clusters.total),
                    )}
                  </p>
                )}
              </>
            )}
          </CardContent>
        </Card>
      </div>

      <Card className="mt-6">
        <CardHeader>
          <CardTitle>{t("overview.handback")}</CardTitle>
          {/* Not decoration: a reader who takes this for reviewed knowledge draws
              the opposite conclusion from the one the card exists to enable. */}
          <CardDescription>{t("overview.handbackScope")}</CardDescription>
        </CardHeader>
        <CardContent>
          {d.latestCheckpoint === null ? (
            <p className="text-sm text-ink-faint">{t("overview.handbackNone")}</p>
          ) : (
            <div className="space-y-4">
              <p className="text-xs text-ink-faint tabular-nums">
                {d.latestCheckpoint.id} · {d.latestCheckpoint.outcome} ·{" "}
                {d.latestCheckpoint.createdAt}
              </p>
              <p className="whitespace-pre-wrap text-pretty text-sm">
                {d.latestCheckpoint.summary}
              </p>
              <div>
                <p className="text-xs font-medium text-ink-muted">
                  {t("overview.handbackUnresolved")}
                </p>
                {d.latestCheckpoint.unresolved.length === 0 ? (
                  <p className="mt-1 text-sm text-ink-faint">
                    {t("overview.handbackNoUnresolved")}
                  </p>
                ) : (
                  <ul className="mt-1 list-disc space-y-1 pl-5 text-sm">
                    {d.latestCheckpoint.unresolved.map((item, i) => (
                      // Free text with no stable id of its own; order is the identity.
                      <li key={`${d.latestCheckpoint?.id}-${i}`} className="text-pretty">
                        {item}
                      </li>
                    ))}
                  </ul>
                )}
              </div>
            </div>
          )}
        </CardContent>
      </Card>

      <p className="mt-10 text-pretty text-xs text-ink-faint">{t("overview.advisoryNote")}</p>
    </section>
  );
}
