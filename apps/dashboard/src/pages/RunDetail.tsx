import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api } from "@/api/client.js";
import { Card, ErrorNote, Loading, Pill } from "@/components/ui.js";
import { useI18n } from "@/i18n/index.js";

/** Run detail: Turns and tool summaries (dashboard-api.md §6); digests only, never raw payloads. */
export function RunDetail() {
  const { t } = useI18n();
  const { id = "", runId = "" } = useParams();
  const q = useQuery({ queryKey: ["run", runId], queryFn: () => api.runDetail(id, runId) });

  if (q.isPending) return <Loading />;
  if (q.isError || q.data === undefined) return <ErrorNote />;
  const d = q.data;

  return (
    <section className="space-y-5">
      <Link to={`/sessions/${id}`} className="text-sm text-ink-muted hover:text-ink">
        ← {t("common.back")}
      </Link>
      <div className="flex items-center gap-3">
        <Pill tone={d.run.status === "active" ? "approve" : "neutral"}>{d.run.status}</Pill>
        <span className="font-mono text-sm text-ink">{d.run.gitBranch ?? d.run.startSource}</span>
      </div>

      {d.turns.map((turn) => (
        <Card key={turn.id} className="space-y-2">
          <div className="flex items-center gap-2 text-sm">
            <Pill tone="neutral">{turn.status}</Pill>
            <span className="text-ink-muted">{turn.checkpointState}</span>
          </div>
          {turn.intentSummary !== null && <p className="text-sm text-ink">{turn.intentSummary}</p>}
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
        </Card>
      ))}
    </section>
  );
}
