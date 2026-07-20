import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useEffect, useState } from "react";
import { Link, useNavigate, useParams } from "react-router-dom";
import { ApiClientError, api } from "@/api/client.js";
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
  const [notice, setNotice] = useState<string | null>(null);

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

  const onConflict = (error: unknown) => {
    if (error instanceof ApiClientError && error.code === "CONFLICT") {
      setNotice(t("common.error"));
      void queryClient.invalidateQueries({ queryKey: ["candidate", id] });
    } else {
      setNotice(t("common.error"));
    }
  };

  const save = useMutation({
    mutationFn: () => {
      const d = q.data;
      if (d === undefined) throw new Error("no candidate");
      return api.editCandidate(id, d.revisionToken, { ...d.draft, title, body });
    },
    onSuccess: () => {
      setNotice(null);
      invalidate();
    },
    onError: onConflict,
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
    onError: onConflict,
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
    onError: onConflict,
  });

  if (q.isPending) return <p className="text-slate-500">{t("common.loading")}</p>;
  if (q.isError || q.data === undefined) return <p className="text-red-600">{t("common.error")}</p>;
  const d = q.data;
  const secretBlocked = !d.validation.secretsClean;
  const canApprove =
    d.validation.approvable && reviewer.trim().length > 0 && d.status === "pending";

  return (
    <section className="space-y-4">
      <Link to="/review" className="text-sm text-slate-500 hover:underline">
        ← {t("common.back")}
      </Link>

      {notice !== null && (
        <p className="rounded bg-amber-50 p-2 text-sm text-amber-800">{notice}</p>
      )}

      <div>
        <label className="block text-sm font-medium" htmlFor="cand-title">
          {t("common.type")}: {d.type}
        </label>
        <input
          id="cand-title"
          value={title}
          onChange={(e) => setTitle(e.target.value)}
          className="mt-1 w-full rounded border border-slate-300 px-3 py-2"
        />
      </div>

      <div>
        <label className="block text-sm font-medium" htmlFor="cand-body">
          Markdown
        </label>
        <textarea
          id="cand-body"
          value={body}
          onChange={(e) => setBody(e.target.value)}
          rows={10}
          className="mt-1 w-full rounded border border-slate-300 px-3 py-2 font-mono text-sm"
        />
        <button
          type="button"
          onClick={() => save.mutate()}
          className="mt-2 rounded bg-slate-200 px-3 py-1 text-sm text-slate-800"
        >
          Save
        </button>
      </div>

      <div>
        <h2 className="text-sm font-semibold">{t("review.validation")}</h2>
        {secretBlocked ? (
          <p role="alert" className="mt-1 rounded bg-red-50 p-2 text-sm text-red-700">
            {t("review.secretBlocked")}
          </p>
        ) : d.validation.approvable ? (
          <p className="mt-1 text-sm text-green-700">{t("review.approvable")}</p>
        ) : (
          <p className="mt-1 text-sm text-amber-700">{t("review.notApprovable")}</p>
        )}
        {d.validation.issues.length > 0 && (
          <ul className="mt-1 list-inside list-disc text-sm text-slate-600">
            {d.validation.issues.map((issue) => (
              <li key={issue}>{issue}</li>
            ))}
          </ul>
        )}
      </div>

      {d.canonicalPreview !== null && (
        <div>
          <h2 className="text-sm font-semibold">{t("review.preview")}</h2>
          <pre className="mt-1 max-h-64 overflow-auto whitespace-pre-wrap rounded border border-slate-200 bg-white p-3 text-xs">
            {d.canonicalPreview}
          </pre>
        </div>
      )}

      <div className="flex items-end gap-3">
        <div>
          <label className="block text-sm font-medium" htmlFor="reviewer">
            {t("review.reviewer")}
          </label>
          <input
            id="reviewer"
            value={reviewer}
            onChange={(e) => setReviewer(e.target.value)}
            className="mt-1 rounded border border-slate-300 px-3 py-2"
          />
        </div>
        <button
          type="button"
          onClick={() => approve.mutate()}
          disabled={!canApprove}
          className="rounded bg-green-700 px-4 py-2 text-white disabled:cursor-not-allowed disabled:bg-slate-300"
        >
          {t("review.approve")}
        </button>
        <button
          type="button"
          onClick={() => reject.mutate()}
          disabled={d.status !== "pending"}
          className="rounded bg-slate-200 px-4 py-2 text-slate-800 disabled:opacity-50"
        >
          {t("review.reject")}
        </button>
      </div>
    </section>
  );
}
