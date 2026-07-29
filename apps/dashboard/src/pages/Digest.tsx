import type { DigestData, DigestKnowledgeRef, DigestList, DigestPeriod } from "@iroha/api";
import { useQuery } from "@tanstack/react-query";
import { ChevronLeftIcon, ChevronRightIcon } from "lucide-react";
import { type ReactNode, useState } from "react";
import { api } from "@/api/client.js";
import { ErrorState, InfoTip, Loading, Mark, PageHeader } from "@/components/brand.js";
import { MarkdownInline } from "@/components/markdown.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card.js";
import { useI18n } from "@/i18n/index.js";

const CHECKPOINT_OUTCOMES = ["completed", "partial", "blocked", "no_change"] as const;
const ADEQUACY_KINDS = ["enforceable", "not_hook_enforceable", "invalid"] as const;

/**
 * A section marker carrying the three-circle motif rather than a plain rule.
 *
 * A two-column grid, not a flex row with a nudged icon: `items-center` centres
 * the mark on the heading's own line box, so the alignment holds if the heading
 * size changes instead of depending on a hand-measured `mt-*`. The note sits at
 * `col-start-2`, which tracks the mark's width without restating it — and keeps
 * the mark on the *heading*, not on the taller title-and-note block.
 */
function SectionHeading({ title, note }: { title: string; note?: string }) {
  return (
    <div className="mb-4 grid grid-cols-[auto_1fr] items-center gap-x-3">
      <Mark className="h-5 w-5 shrink-0 opacity-90" />
      <h2 className="min-w-0 font-display text-xl font-semibold tracking-[-0.01em] text-ink">
        {title}
      </h2>
      {note !== undefined && (
        <p className="col-start-2 mt-1 text-pretty text-sm text-ink-muted">{note}</p>
      )}
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
  label: ReactNode;
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

/**
 * A capped list, with its **uncapped** count always visible. The count is issued as
 * a fact, so prose may cite it — and a fact with no visible source on the page is a
 * claim the reader cannot check.
 */
function KnowledgeRefList({
  list,
  empty,
}: {
  list: DigestList<DigestKnowledgeRef>;
  empty: string;
}) {
  const { t } = useI18n();
  if (list.total === 0) {
    return <p className="text-sm text-ink-faint">{empty}</p>;
  }
  return (
    <>
      <div className="mb-3 font-display text-2xl font-semibold tabular-nums text-ink">
        {list.total}
      </div>
      <ul className="space-y-2.5">
        {list.items.map((item) => (
          <li key={item.id}>
            <div className="text-sm text-ink">{item.title}</div>
            {item.summary !== null && (
              <div className="mt-0.5 text-xs text-ink-muted">
                <MarkdownInline source={item.summary} />
              </div>
            )}
          </li>
        ))}
      </ul>
      {list.truncated && (
        <p className="mt-3 text-xs text-ink-faint">
          {t("digest.listTruncated")
            .replace("{shown}", String(list.items.length))
            .replace("{total}", String(list.total))}
        </p>
      )}
    </>
  );
}

function periodLabel(period: DigestPeriod, t: (key: string) => string): string {
  const label =
    period.unit === "week" ? t("digest.periodWeek").replace("{date}", period.key) : period.key;
  return `${label} · ${t("digest.utcBasis")}`;
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
            <p className="mt-3 max-w-2xl text-pretty text-ink-muted">{prose.prose.standfirst}</p>
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
  // The *resolved* offset, not the one requested: the API clamps an out-of-range
  // value, so stepping back past the cap would otherwise leave the local state
  // ahead of the server's and disable "newer" on an issue that has one.
  const servedOffset = d.period.offset;

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
              onClick={() => setOffset(servedOffset + 1)}
              aria-label={t("digest.older")}
            >
              <ChevronLeftIcon />
              {t("digest.older")}
            </Button>
            <Button
              variant="outline"
              size="sm"
              disabled={servedOffset === 0}
              onClick={() => setOffset(Math.max(0, servedOffset - 1))}
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
                label={
                  <InfoTip label={t("digest.denials")} explanation={t("digest.guardrailHint")} />
                }
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

        {d.local.correlations.items.length > 0 && (
          <Card className="mt-6">
            <CardHeader>
              <CardTitle>{t("digest.clusters")}</CardTitle>
            </CardHeader>
            <CardContent>
              <div className="flex flex-wrap gap-2">
                {d.local.correlations.items.map((correlation) => (
                  <Badge key={correlation.key} variant="pending">
                    <span className="font-mono text-[11px]">{correlation.key}</span>
                    <span className="tabular-nums">{correlation.count}</span>
                  </Badge>
                ))}
              </div>
              {d.local.correlations.truncated && (
                <p className="mt-3 text-xs text-ink-faint">
                  {t("digest.clustersTruncated").replace(
                    "{total}",
                    String(d.local.correlations.total),
                  )}
                </p>
              )}
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
              <p className="mt-1 text-xs uppercase tracking-[0.12em] text-ink-faint">
                {t("digest.asOfNow")}
              </p>
              <p className="mt-3 text-pretty text-xs text-ink-muted">
                {t("digest.pendingLearningsHint")}
              </p>
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
                list={d.team.guardrailsChanged}
                empty={t("digest.noTeamActivity")}
              />
            </CardContent>
          </Card>
          <Card>
            <CardHeader>
              <CardTitle>{t("digest.reviewLearnings")}</CardTitle>
            </CardHeader>
            <CardContent>
              <KnowledgeRefList list={d.team.reviewLearnings} empty={t("digest.noTeamActivity")} />
            </CardContent>
          </Card>
        </div>

        <Card className="mt-6">
          <CardHeader>
            <CardTitle>{t("digest.rulesetAdequacy")}</CardTitle>
            <CardDescription>{t("digest.asOfNow")}</CardDescription>
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
            <p className="mt-5 text-pretty text-xs text-ink-muted">{t("digest.adequacyHint")}</p>
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

      {/* No measure cap: this is one sentence that reads as a single footnote line
          at the content width. `text-pretty` keeps a narrower viewport from
          leaving one trailing character alone on the last line — the default
          any-character break for Japanese does exactly that. */}
      <p className="mt-10 text-pretty text-xs text-ink-faint">{t("digest.advisoryNote")}</p>
    </section>
  );
}
