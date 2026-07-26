import type { DigestData, DigestKnowledgeRef, DigestPeriod } from "@iroha/api";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";
import { api } from "@/api/client.js";
import { ErrorState, Loading, Mark, PageHeader } from "@/components/brand.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.js";
import { useI18n } from "@/i18n/index.js";

const CHECKPOINT_OUTCOMES = ["completed", "partial", "blocked", "no_change"] as const;
const ADEQUACY_KINDS = ["enforceable", "not_hook_enforceable", "invalid"] as const;

/** A section marker carrying the three-circle motif rather than a plain rule. */
function SectionHeading({ title, note }: { title: string; note?: string }) {
  return (
    <div className="mb-4 flex items-start gap-3">
      <Mark className="mt-0.5 h-5 w-5 shrink-0 opacity-90" />
      <div className="min-w-0">
        <h2 className="font-display text-xl font-semibold tracking-[-0.01em] text-ink">{title}</h2>
        {note !== undefined && <p className="mt-1 text-sm text-ink-muted">{note}</p>}
      </div>
    </div>
  );
}

/**
 * One number with its previous-period counterpart stated plainly rather than as a
 * percentage. A period can go from 0 to 1, where a percentage change is either
 * infinite or meaningless — the two absolute numbers always read correctly.
 */
function Stat({
  label,
  value,
  priorValue,
  hero = false,
}: {
  label: string;
  value: number;
  priorValue?: number;
  hero?: boolean;
}) {
  const { t } = useI18n();
  return (
    <div>
      <div
        className={
          hero
            ? "font-display text-6xl font-semibold tabular-nums leading-none text-ink"
            : "font-display text-3xl font-semibold tabular-nums text-ink"
        }
      >
        {value}
      </div>
      <div className="mt-1.5 text-sm text-ink-muted">{label}</div>
      {priorValue !== undefined && (
        <div className="mt-0.5 text-xs tabular-nums text-ink-faint">
          {t("digest.vsPrior").replace("{value}", String(priorValue))}
        </div>
      )}
    </div>
  );
}

function CountRow({ label, count }: { label: string; count: number }) {
  return (
    <div className="flex items-baseline justify-between gap-4 border-b border-hairline py-2.5 last:border-b-0">
      <span className="min-w-0 truncate text-sm text-ink">{label}</span>
      <span className="shrink-0 font-display text-sm font-semibold tabular-nums text-ink">
        {count}
      </span>
    </div>
  );
}

function KnowledgeRefList({
  items,
  truncated,
  empty,
}: {
  items: DigestKnowledgeRef[];
  truncated: boolean;
  empty: string;
}) {
  const { t } = useI18n();
  if (items.length === 0) {
    return <p className="text-sm text-ink-faint">{empty}</p>;
  }
  return (
    <>
      <ul className="space-y-2.5">
        {items.map((item) => (
          <li key={item.id}>
            <div className="text-sm text-ink">{item.title}</div>
            {item.summary !== null && (
              <div className="mt-0.5 text-xs text-ink-muted">{item.summary}</div>
            )}
          </li>
        ))}
      </ul>
      {truncated && <p className="mt-3 text-xs text-ink-faint">{t("digest.truncated")}</p>}
    </>
  );
}

function periodLabel(period: DigestPeriod, t: (key: string) => string): string {
  return period.unit === "week" ? t("digest.periodWeek").replace("{date}", period.key) : period.key;
}

/** The masthead: the composed headline and deck, or templated copy when there is none. */
function Masthead({ digest }: { digest: DigestData }) {
  const { t } = useI18n();
  const prose = digest.prose;
  return (
    <Card className="mb-8">
      <CardContent className="py-8">
        {prose === null ? (
          <>
            <p className="font-display text-2xl font-semibold leading-snug tracking-[-0.01em] text-ink">
              {t("digest.templated")}
            </p>
            <p className="mt-2 text-sm text-ink-muted">{t("digest.compose")}</p>
          </>
        ) : (
          <>
            <p className="font-display text-3xl font-semibold leading-snug tracking-[-0.01em] text-ink">
              {prose.prose.headline}
            </p>
            <p className="mt-3 max-w-2xl text-ink-muted">{prose.prose.standfirst}</p>
            <p className="mt-5 text-xs uppercase tracking-[0.14em] text-ink-faint">
              {t("digest.unreviewed")}
            </p>
          </>
        )}
      </CardContent>
    </Card>
  );
}

/**
 * The Digest — the dashboard's editorial front page (contracts/dashboard-api.md §6).
 *
 * Numbers come from `GET /api/v1/digest` and are recomputed per request, so this
 * page is never blank: with no composed prose it renders templated copy over the
 * live figures. Where prose exists, its `{{factId}}` references have already been
 * substituted server-side with iroha's own values, so nothing here renders a
 * number an agent chose.
 *
 * Deliberately has no per-person metric and no blended "compliance score": the
 * three signals (denials, ruleset adequacy, review recurrence) are separately
 * sourced and stay separate, and advisory rules are reported as unmeasurable
 * rather than folded into a number.
 */
export function Digest() {
  const { t } = useI18n();
  const [offset, setOffset] = useState(0);
  const q = useQuery({
    queryKey: ["digest", offset],
    queryFn: () => api.digest({ offset }),
    refetchInterval: 5000,
  });

  if (q.isPending) return <Loading />;
  if (q.isError || q.data === undefined) return <ErrorState />;
  const d = q.data;

  const denialsByRule = d.local.denials.byRule;

  return (
    <section>
      <PageHeader
        eyebrow={periodLabel(d.period, t)}
        title={t("digest.title")}
        actions={
          <div className="flex items-center gap-2">
            <Button
              variant="outline"
              size="sm"
              onClick={() => setOffset(offset + 1)}
              aria-label={t("digest.older")}
            >
              <ChevronLeftIcon />
              {t("digest.older")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={!d.hasNewer}
              onClick={() => setOffset(Math.max(0, offset - 1))}
              aria-label={t("digest.newer")}
            >
              {t("digest.newer")}
              <ChevronRightIcon />
            </Button>
          </div>
        }
      />

      <Masthead digest={d} />

      <div className="mb-12">
        <SectionHeading title={t("digest.stumbles")} note={t("digest.stumblesScope")} />
        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="justify-center">
            <CardContent>
              <Stat
                hero
                label={t("digest.denials")}
                value={d.local.denials.value}
                priorValue={d.local.denials.priorValue}
              />
            </CardContent>
          </Card>
          <Card className="lg:col-span-2">
            <CardHeader>
              <CardTitle>{t("digest.denialsByRule")}</CardTitle>
            </CardHeader>
            <CardContent>
              {denialsByRule.length === 0 ? (
                <p className="text-sm text-ink-faint">{t("digest.noDenials")}</p>
              ) : (
                <div>
                  {denialsByRule.map((row) => (
                    <CountRow
                      key={row.ruleId ?? "unattributed"}
                      label={row.ruleTitle ?? row.ruleId ?? t("digest.unattributed")}
                      count={row.count}
                    />
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        </div>

        {d.local.correlations.length > 0 && (
          <Card className="mt-6">
            <CardHeader>
              <CardTitle>{t("digest.clusters")}</CardTitle>
            </CardHeader>
            <CardContent className="flex flex-wrap gap-2">
              {d.local.correlations.map((correlation) => (
                <Badge key={correlation.paths.join("|")} variant="pending">
                  <span className="font-mono text-[11px]">{correlation.paths[0]}</span>
                  <span className="tabular-nums">{correlation.count}</span>
                </Badge>
              ))}
            </CardContent>
          </Card>
        )}

        <div className="mt-6 grid gap-6 sm:grid-cols-2 lg:grid-cols-3">
          <Card>
            <CardContent>
              <Stat
                label={t("digest.sessions")}
                value={d.local.sessions.value}
                priorValue={d.local.sessions.priorValue}
              />
            </CardContent>
          </Card>
          <Card>
            <CardContent>
              <Stat
                label={t("digest.checkpoints")}
                value={d.local.checkpoints.value}
                priorValue={d.local.checkpoints.priorValue}
              />
              <div className="mt-4">
                {CHECKPOINT_OUTCOMES.map((outcome) => (
                  <CountRow
                    key={outcome}
                    label={t(`digest.outcome.${outcome}`)}
                    count={d.local.checkpoints.byOutcome[outcome]}
                  />
                ))}
              </div>
            </CardContent>
          </Card>
          <Card>
            <CardContent>
              <Stat label={t("digest.pendingLearnings")} value={d.local.pendingReviewLearnings} />
              <p className="mt-3 text-xs text-ink-muted">{t("digest.pendingLearningsHint")}</p>
            </CardContent>
          </Card>
        </div>
      </div>

      <div>
        <SectionHeading title={t("digest.codebase")} note={t("digest.codebaseScope")} />
        <div className="grid gap-6 lg:grid-cols-3">
          <Card className="justify-center">
            <CardContent>
              <Stat
                hero
                label={t("digest.approved")}
                value={d.team.knowledge.value}
                priorValue={d.team.knowledge.priorValue}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t("digest.guardrailsChanged")}</CardTitle>
            </CardHeader>
            <CardContent>
              <KnowledgeRefList
                items={d.team.guardrailsChanged.items}
                truncated={d.team.guardrailsChanged.truncated}
                empty={t("digest.noTeamActivity")}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t("digest.reviewLearnings")}</CardTitle>
            </CardHeader>
            <CardContent>
              <KnowledgeRefList
                items={d.team.reviewLearnings.items}
                truncated={d.team.reviewLearnings.truncated}
                empty={t("digest.noTeamActivity")}
              />
            </CardContent>
          </Card>
        </div>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle>{t("digest.rulesetAdequacy")}</CardTitle>
          </CardHeader>
          <CardContent>
            <div className="grid gap-6 sm:grid-cols-3">
              {ADEQUACY_KINDS.map((kind) => (
                <Stat
                  key={kind}
                  label={t(`digest.adequacy.${kind}`)}
                  value={d.team.rulesetAdequacy[kind]}
                />
              ))}
            </div>
            <p className="mt-5 text-xs text-ink-muted">{t("digest.adequacyHint")}</p>
          </CardContent>
        </Card>
      </div>

      {d.prose?.prose.sections.map((section) => (
        <Card className="mt-6" key={section.slot}>
          <CardHeader>
            <CardTitle>{section.heading}</CardTitle>
          </CardHeader>
          <CardContent>
            <p className="whitespace-pre-line text-ink-muted">{section.body}</p>
          </CardContent>
        </Card>
      ))}

      <p className="mt-10 max-w-2xl text-xs text-ink-faint">{t("digest.advisoryNote")}</p>
    </section>
  );
}
