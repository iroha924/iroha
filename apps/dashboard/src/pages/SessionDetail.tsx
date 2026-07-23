import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api } from "@/api/client.js";
import { BackLink, ErrorState, Loading } from "@/components/brand.js";
import { Badge } from "@/components/ui/badge.js";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.js";
import { useI18n } from "@/i18n/index.js";
import { runStatusTone } from "@/lib/status.js";

/** Session detail: Runs and Checkpoints (dashboard-api.md §6); never raw conversation. */
export function SessionDetail() {
  const { t } = useI18n();
  const { id = "" } = useParams();
  const q = useQuery({ queryKey: ["session", id], queryFn: () => api.sessionDetail(id) });

  if (q.isPending) return <Loading />;
  if (q.isError || q.data === undefined) return <ErrorState />;
  const d = q.data;

  return (
    <section>
      <BackLink to="/sessions">{t("common.back")}</BackLink>
      <h1 className="font-display text-2xl font-semibold tracking-[-0.005em] text-ink">
        {d.platform}
      </h1>
      <div className="mt-2 text-xs text-ink-muted">
        {t("common.status")}: {d.summaryStatus} · {d.startedAt.slice(0, 16).replace("T", " ")}
      </div>

      <div className="mt-6 space-y-6">
        <Card>
          <CardHeader>
            <CardTitle>{t("sessions.runs")}</CardTitle>
          </CardHeader>
          <CardContent>
            <ul className="divide-y divide-hairline">
              {d.runs.map((r) => (
                <li
                  key={r.id}
                  className="flex items-center gap-3 py-2.5 text-sm first:pt-0 last:pb-0"
                >
                  <Badge variant={runStatusTone(r.status)}>{r.status}</Badge>
                  <Link
                    to={`/sessions/${d.id}/runs/${r.id}`}
                    className="font-medium text-ink transition-colors hover:text-matcha"
                  >
                    {r.gitBranch ?? r.startSource}
                  </Link>
                  <span className="ml-auto text-xs tabular-nums text-ink-faint">
                    {r.startedAt.slice(0, 16).replace("T", " ")}
                  </span>
                </li>
              ))}
            </ul>
          </CardContent>
        </Card>

        {d.checkpoints.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>{t("session.checkpoints")}</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="divide-y divide-hairline">
                {d.checkpoints.map((cp) => (
                  <li
                    key={cp.id}
                    className="flex items-center gap-3 py-2.5 text-sm first:pt-0 last:pb-0"
                  >
                    <Badge variant="neutral">{cp.outcome}</Badge>
                    <span className="flex-1 text-ink">{cp.objective}</span>
                    <span className="text-xs tabular-nums text-ink-faint">
                      {cp.createdAt.slice(0, 10)}
                    </span>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}
      </div>
    </section>
  );
}
