import { useQuery } from "@tanstack/react-query";
import { Link } from "react-router-dom";
import { api } from "@/api/client.js";
import { EmptyState, ErrorNote, Loading, PageTitle, Pill } from "@/components/ui.js";
import { useI18n } from "@/i18n/index.js";

function runTone(status: string | null): "approve" | "pending" | "reject" | "neutral" {
  if (status === "active") return "approve";
  if (status === "interrupted") return "pending";
  if (status === "abandoned") return "reject";
  return "neutral";
}

/** Session list (dashboard-api.md §6). No per-person metric (FR-108). */
export function Sessions() {
  const { t } = useI18n();
  const q = useQuery({
    queryKey: ["sessions"],
    queryFn: () => api.sessions(),
    refetchInterval: 5000,
  });

  if (q.isPending) return <Loading />;
  if (q.isError || q.data === undefined) return <ErrorNote />;

  return (
    <section>
      <PageTitle>{t("sessions.title")}</PageTitle>
      {q.data.items.length === 0 ? (
        <EmptyState message={t("sessions.empty")} />
      ) : (
        <ul className="divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline bg-paper-raised">
          {q.data.items.map((s) => (
            <li key={s.id}>
              <Link
                to={`/sessions/${s.id}`}
                className="flex items-center gap-3 px-5 py-3.5 transition-colors hover:bg-paper-inset"
              >
                <Pill tone={runTone(s.latestRunStatus)}>{s.latestRunStatus ?? s.platform}</Pill>
                <span className="flex-1 text-ink">
                  <span className="font-medium">{s.platform}</span>
                  {s.latestBranch !== null && (
                    <span className="ml-2 font-mono text-xs text-ink-muted">{s.latestBranch}</span>
                  )}
                </span>
                <span className="text-xs tabular-nums text-ink-faint">
                  {t("sessions.runs")} {s.runCount} · {s.lastSeenAt.slice(0, 10)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
