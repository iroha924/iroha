import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client.js";
import { EmptyState, ErrorState, Loading, PageHeader } from "@/components/brand.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Card, CardContent } from "@/components/ui/card.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table.js";
import { useI18n } from "@/i18n/index.js";
import type { StatusTone } from "@/lib/status.js";

function tone(status: string): StatusTone {
  if (status === "ok") return "approve";
  if (status === "warning") return "pending";
  if (status === "error" || status === "blocked") return "reject";
  return "neutral";
}

/** Diagnostics-event outcome → tone. A denial is not a malfunction, so it reads as pending. */
function outcomeTone(outcome: string): StatusTone {
  if (outcome === "success") return "approve";
  if (outcome === "failure") return "reject";
  if (outcome === "warning" || outcome === "denied") return "pending";
  return "neutral";
}

/** Recent `event_log` rows: which hook, tool, endpoint, or sync ran, and how it ended. */
function RecentEvents() {
  const { t } = useI18n();
  const q = useQuery({ queryKey: ["events"], queryFn: api.events });

  if (q.isPending) return <Loading />;
  if (q.isError || q.data === undefined) return <ErrorState />;
  if (q.data.events.length === 0) return <EmptyState message={t("doctor.events.empty")} />;

  return (
    <div className="overflow-hidden rounded-2xl border border-hairline bg-paper-raised">
      <Table>
        <TableHeader>
          <TableRow>
            <TableHead>{t("doctor.events.outcome")}</TableHead>
            <TableHead>{t("doctor.events.event")}</TableHead>
            <TableHead>{t("doctor.events.source")}</TableHead>
            <TableHead className="text-right">{t("doctor.events.duration")}</TableHead>
            <TableHead className="text-right">{t("doctor.events.occurredAt")}</TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {q.data.events.map((e) => (
            <TableRow key={e.id}>
              <TableCell>
                <Badge variant={outcomeTone(e.outcome)}>{e.outcome}</Badge>
              </TableCell>
              <TableCell className="font-mono text-xs text-ink">
                {e.eventType}
                {e.errorCode !== null && <span className="ml-2 text-ink-faint">{e.errorCode}</span>}
              </TableCell>
              <TableCell className="font-mono text-xs text-ink-muted">{e.adapter ?? "—"}</TableCell>
              <TableCell className="text-right tabular-nums text-ink-muted">
                {e.durationMs === null ? "—" : `${e.durationMs} ms`}
              </TableCell>
              <TableCell className="text-right tabular-nums text-ink-faint">
                {e.occurredAt.slice(0, 19).replace("T", " ")}
              </TableCell>
            </TableRow>
          ))}
        </TableBody>
      </Table>
    </div>
  );
}

/** Capability diagnostics + allowlisted repair (dashboard-api.md §6). */
export function Doctor() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ["doctor"], queryFn: api.doctor });

  const repair = useMutation({
    mutationFn: () => api.doctorRepair("resync"),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ["doctor"] });
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
    },
  });

  if (q.isPending) return <Loading />;
  if (q.isError || q.data === undefined) return <ErrorState />;

  return (
    <section>
      <PageHeader
        title={t("doctor.title")}
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              onClick={() => {
                void queryClient.invalidateQueries({ queryKey: ["doctor"] });
                void queryClient.invalidateQueries({ queryKey: ["events"] });
              }}
            >
              {t("doctor.rerun")}
            </Button>
            <Button type="button" onClick={() => repair.mutate()} disabled={repair.isPending}>
              {t("doctor.resync")}
            </Button>
          </>
        }
      />

      <Card>
        <CardContent>
          <ul className="divide-y divide-hairline">
            {q.data.checks.map((c) => (
              <li key={c.name} className="flex items-start gap-3 py-3.5 first:pt-0 last:pb-0">
                <Badge variant={tone(c.status)} className="mt-0.5">
                  {c.status}
                </Badge>
                <div className="min-w-0">
                  <div className="font-medium text-ink">{c.name}</div>
                  <div className="text-sm text-ink-muted">{c.message}</div>
                </div>
              </li>
            ))}
          </ul>
        </CardContent>
      </Card>

      <h2 className="mt-10 mb-4 font-display font-semibold text-ink text-lg tracking-tight">
        {t("doctor.events.title")}
      </h2>
      <RecentEvents />
    </section>
  );
}
