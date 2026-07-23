import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { api } from "@/api/client.js";
import { BackLink, ErrorState, Loading } from "@/components/brand.js";
import { Badge } from "@/components/ui/badge.js";
import { Card, CardContent } from "@/components/ui/card.js";
import { useI18n } from "@/i18n/index.js";
import { runStatusTone } from "@/lib/status.js";

/** Run detail: Turns and tool summaries (dashboard-api.md §6); digests only, never raw payloads. */
export function RunDetail() {
  const { t } = useI18n();
  const { id = "", runId = "" } = useParams();
  const q = useQuery({ queryKey: ["run", runId], queryFn: () => api.runDetail(id, runId) });

  if (q.isPending) return <Loading />;
  if (q.isError || q.data === undefined) return <ErrorState />;
  const d = q.data;

  return (
    <section>
      <BackLink to={`/sessions/${id}`}>{t("common.back")}</BackLink>
      <div className="flex items-center gap-3">
        <Badge variant={runStatusTone(d.run.status)}>{d.run.status}</Badge>
        <span className="font-mono text-sm text-ink">{d.run.gitBranch ?? d.run.startSource}</span>
      </div>

      <div className="mt-6 space-y-4">
        {d.turns.map((turn) => (
          <Card key={turn.id}>
            <CardContent className="space-y-2.5">
              <div className="flex items-center gap-2 text-sm">
                <Badge variant="neutral">{turn.status}</Badge>
                <span className="text-ink-muted">{turn.checkpointState}</span>
              </div>
              {turn.intentSummary !== null && (
                <p className="text-sm text-ink">{turn.intentSummary}</p>
              )}
              {turn.toolEvents.length > 0 && (
                <ul className="space-y-1 text-xs text-ink-muted">
                  {turn.toolEvents.map((e) => (
                    <li key={e.id} className="flex gap-2">
                      <span className="font-mono text-ink">{e.toolName}</span>
                      <span>{e.phase}</span>
                      {e.targetSummary !== null && (
                        <span className="text-ink-faint">{e.targetSummary}</span>
                      )}
                      <span className="ml-auto">{e.status}</span>
                    </li>
                  ))}
                </ul>
              )}
            </CardContent>
          </Card>
        ))}
      </div>
    </section>
  );
}
