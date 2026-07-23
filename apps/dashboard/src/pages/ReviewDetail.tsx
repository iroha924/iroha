import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { useNavigate, useParams } from "react-router-dom";
import { toast } from "sonner";
import { ApiClientError, api } from "@/api/client.js";
import { BackLink, ErrorState, Loading } from "@/components/brand.js";
import { Badge } from "@/components/ui/badge.js";
import { Button } from "@/components/ui/button.js";
import { Card, CardContent } from "@/components/ui/card.js";
import { Input } from "@/components/ui/input.js";
import { Label } from "@/components/ui/label.js";
import { Textarea } from "@/components/ui/textarea.js";
import { useI18n } from "@/i18n/index.js";

/**
 * Candidate review detail (dashboard-api.md §6): edit the draft, view the
 * canonical diff preview and validation, then approve or reject. Approval is
 * disabled until validation passes, and a detected secret hard-blocks it.
 */
export function ReviewDetail() {
  const { t } = useI18n();
  const { id = "" } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();

  const q = useQuery({ queryKey: ["candidate", id], queryFn: () => api.candidate(id) });

  const [title, setTitle] = useState("");
  const [body, setBody] = useState("");
  const [reviewer, setReviewer] = useState("");

  // Sync the editable form from the loaded draft when navigating to a candidate
  // (keyed on the candidate id, not every refetch, so in-progress edits survive polling).
  useEffect(() => {
    if (q.data !== undefined) {
      setTitle(q.data.draft.title);
      setBody(q.data.draft.body);
    }
  }, [id, q.data?.id]);

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["candidate", id] });
    void queryClient.invalidateQueries({ queryKey: ["candidates"] });
    void queryClient.invalidateQueries({ queryKey: ["overview"] });
  };

  const onError = (error: unknown) => {
    toast.error(t("common.error"));
    if (error instanceof ApiClientError && error.code === "CONFLICT") {
      void queryClient.invalidateQueries({ queryKey: ["candidate", id] });
    }
  };

  const save = useMutation({
    mutationFn: () => {
      const d = q.data;
      if (d === undefined) throw new Error("no candidate");
      return api.editCandidate(id, d.revisionToken, { ...d.draft, title, body });
    },
    onSuccess: () => {
      toast.success(t("common.saved"));
      invalidate();
    },
    onError,
  });

  const approve = useMutation({
    mutationFn: () => {
      const d = q.data;
      if (d === undefined) throw new Error("no candidate");
      return api.approve(id, d.revisionToken, { provider: "git", displayName: reviewer });
    },
    onSuccess: () => {
      invalidate();
      navigate("/review");
    },
    onError,
  });

  const reject = useMutation({
    mutationFn: () => {
      const d = q.data;
      if (d === undefined) throw new Error("no candidate");
      return api.reject(id, d.revisionToken);
    },
    onSuccess: () => {
      invalidate();
      navigate("/review");
    },
    onError,
  });

  if (q.isPending) return <Loading />;
  if (q.isError || q.data === undefined) return <ErrorState />;
  const d = q.data;
  const secretBlocked = !d.validation.secretsClean;
  const canApprove =
    d.validation.approvable && reviewer.trim().length > 0 && d.status === "pending";

  return (
    <section className="space-y-5">
      <BackLink to="/review">{t("common.back")}</BackLink>

      <Card>
        <CardContent className="space-y-4">
          <Badge variant="pending" className="w-fit">
            {d.type}
          </Badge>
          <div className="space-y-1.5">
            <Label htmlFor="cand-title">{t("review.fieldTitle")}</Label>
            <Input id="cand-title" value={title} onChange={(e) => setTitle(e.target.value)} />
          </div>
          <div className="space-y-1.5">
            <Label htmlFor="cand-body">{t("review.fieldBody")}</Label>
            <Textarea
              id="cand-body"
              value={body}
              onChange={(e) => setBody(e.target.value)}
              rows={10}
              className="bg-paper-inset font-mono text-[13px]"
            />
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="mt-1"
              onClick={() => save.mutate()}
              disabled={save.isPending}
            >
              {t("common.save")}
            </Button>
          </div>
        </CardContent>
      </Card>

      <div>
        <h2 className="mb-2 text-[11.5px] font-semibold uppercase tracking-wider text-ink-faint">
          {t("review.validation")}
        </h2>
        {secretBlocked ? (
          <p
            role="alert"
            className="rounded-xl bg-persimmon-tint px-3 py-2 text-sm text-persimmon-hover"
          >
            {t("review.secretBlocked")}
          </p>
        ) : d.validation.approvable ? (
          <p className="rounded-xl bg-approve-tint px-3 py-2 text-sm text-approve">
            {t("review.approvable")}
          </p>
        ) : (
          <p className="rounded-xl bg-warn-tint px-3 py-2 text-sm text-warn">
            {t("review.notApprovable")}
          </p>
        )}
        {d.validation.issues.length > 0 && (
          <ul className="mt-2 list-inside list-disc text-sm text-ink-muted">
            {d.validation.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        )}
      </div>

      {d.canonicalPreview !== null && (
        <div>
          <h2 className="mb-2 text-[11.5px] font-semibold uppercase tracking-wider text-ink-faint">
            {t("review.preview")}
          </h2>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap rounded-2xl border border-hairline bg-paper-inset p-4 font-mono text-xs leading-relaxed text-ink">
            {d.canonicalPreview}
          </pre>
        </div>
      )}

      <div className="flex flex-wrap items-end gap-3">
        <div className="space-y-1.5">
          <Label htmlFor="reviewer">{t("review.reviewer")}</Label>
          <Input
            id="reviewer"
            value={reviewer}
            onChange={(e) => setReviewer(e.target.value)}
            className="w-56"
          />
        </div>
        <Button type="button" onClick={() => approve.mutate()} disabled={!canApprove}>
          {t("review.approve")}
        </Button>
        <Button
          type="button"
          variant="destructive"
          onClick={() => reject.mutate()}
          disabled={d.status !== "pending"}
        >
          {t("review.reject")}
        </Button>
      </div>
    </section>
  );
}
