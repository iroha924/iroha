import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client.js";
import { ErrorState, Loading, PageHeader } from "@/components/brand.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Card, CardContent } from "@/components/ui/card.js";
import { useI18n } from "@/i18n/index.js";
import type { StatusTone } from "@/lib/status.js";

function tone(status: string): StatusTone {
  if (status === "ok") return "approve";
  if (status === "warning") return "pending";
  if (status === "error" || status === "blocked") return "reject";
  return "neutral";
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
        eyebrow={t("nav.doctor")}
        title={t("doctor.title")}
        actions={
          <>
            <Button
              type="button"
              variant="outline"
              onClick={() => queryClient.invalidateQueries({ queryKey: ["doctor"] })}
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
    </section>
  );
}
