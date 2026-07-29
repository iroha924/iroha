import type { DiagnosticsEvent } from "@iroha/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client.js";
import { ErrorState, Loading, PageHeader } from "@/components/brand.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Card, CardContent } from "@/components/ui/card.js";
import {
  Dialog,
  DialogContent,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from "@/components/ui/dialog.js";
import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table.js";
import { toast } from "@/components/ui/toast.js";
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

/**
 * Recent `event_log` rows, behind a dialog. Every producer of that table records
 * a row only when something failed, warned, or was skipped — a clean sync, a
 * successful tool call, and a 2xx request all append nothing — so this is a
 * problem list, and an empty one is the healthy state worth no page space.
 */
function ProblemsDialog({ events, failed }: { events: DiagnosticsEvent[]; failed: boolean }) {
  const { t } = useI18n();

  return (
    <Dialog>
      <DialogTrigger render={<Button type="button" variant="outline" />}>
        {failed
          ? t("doctor.events.unavailable")
          : t("doctor.events.open").replace("{count}", String(events.length))}
      </DialogTrigger>
      {/* A full page of diagnostics is 30 rows, taller than any viewport. The
          shared primitive centres without bounding, and modal scroll-locking stops
          the page behind from scrolling — so without this the last rows are
          unreachable. */}
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-3xl">
        <DialogHeader>
          <DialogTitle>{t("doctor.events.title")}</DialogTitle>
        </DialogHeader>
        {failed && <ErrorState />}
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
            {events.map((e) => (
              <TableRow key={e.id}>
                <TableCell>
                  <Badge variant={outcomeTone(e.outcome)}>{t(`evoutcome.${e.outcome}`)}</Badge>
                </TableCell>
                <TableCell className="font-mono text-xs text-ink">
                  {e.eventType}
                  {e.errorCode !== null && (
                    <span className="ml-2 text-ink-faint">{e.errorCode}</span>
                  )}
                </TableCell>
                <TableCell className="font-mono text-xs text-ink-muted">
                  {e.adapter ?? "—"}
                </TableCell>
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
      </DialogContent>
    </Dialog>
  );
}

/** Capability diagnostics + allowlisted repair (contracts/dashboard-api.md §6). */
export function Doctor() {
  const { t } = useI18n();
  const queryClient = useQueryClient();
  const q = useQuery({ queryKey: ["doctor"], queryFn: api.doctor });
  // A failed read is surfaced rather than folded into the empty case. `?? []` on
  // its own makes a broken diagnostics fetch render exactly like a healthy
  // repository — the one page where reporting health you did not measure is worst.
  const events = useQuery({ queryKey: ["events"], queryFn: api.events });
  const problems = events.data?.events ?? [];

  const repair = useMutation({
    mutationFn: () => api.doctorRepair("resync"),
    onSuccess: () => {
      toast.add({ type: "success", title: t("doctor.resyncDone") });
      void queryClient.invalidateQueries({ queryKey: ["doctor"] });
      void queryClient.invalidateQueries({ queryKey: ["overview"] });
      // A resync that skipped a document appends a `sync.canonical` row; without
      // this it stays invisible until the user clicks "Re-run".
      void queryClient.invalidateQueries({ queryKey: ["events"] });
    },
    onError: () => toast.add({ type: "error", title: t("common.error") }),
  });

  if (q.isPending) return <Loading />;
  if (q.isError || q.data === undefined) return <ErrorState />;

  return (
    <section>
      <PageHeader
        title={t("doctor.title")}
        actions={
          <>
            {(problems.length > 0 || events.isError) && (
              <ProblemsDialog events={problems} failed={events.isError} />
            )}
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
                  {t(`dcheck.${c.status}`)}
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
    </section>
  );
}
