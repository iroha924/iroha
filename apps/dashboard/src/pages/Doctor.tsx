import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { api } from "@/api/client.js";
import { btnPrimary, btnSecondary, Card, ErrorNote, Loading, Pill } from "@/components/ui.js";
import { useI18n } from "@/i18n/index.js";

function tone(status: string): "approve" | "pending" | "reject" | "neutral" {
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
  if (q.isError || q.data === undefined) return <ErrorNote />;

  return (
    <section>
      <div className="mb-6 flex items-center justify-between">
        <h1 className="font-display text-[30px] font-semibold tracking-[-0.01em] text-ink">
          {t("doctor.title")}
        </h1>
        <div className="flex gap-2">
          <button
            type="button"
            onClick={() => queryClient.invalidateQueries({ queryKey: ["doctor"] })}
            className={btnSecondary}
          >
            {t("doctor.rerun")}
          </button>
          <button type="button" onClick={() => repair.mutate()} className={btnPrimary}>
            {t("doctor.resync")}
          </button>
        </div>
      </div>
      <Card>
        <ul className="space-y-3">
          {q.data.checks.map((c) => (
            <li key={c.name} className="flex items-start gap-3">
              <Pill tone={tone(c.status)}>{c.status}</Pill>
              <div>
                <div className="font-medium text-ink">{c.name}</div>
                <div className="text-sm text-ink-muted">{c.message}</div>
              </div>
            </li>
          ))}
        </ul>
      </Card>
    </section>
  );
}
