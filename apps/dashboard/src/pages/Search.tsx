import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "@/api/client.js";
import { useI18n } from "@/i18n/index.js";

/** Natural-language search over approved knowledge (dashboard-api.md §6; FTS/hybrid via the API). */
export function Search() {
  const { t } = useI18n();
  const [input, setInput] = useState("");
  const [submitted, setSubmitted] = useState("");

  const q = useQuery({
    queryKey: ["search", submitted],
    queryFn: () => api.search(submitted),
    enabled: submitted.length > 0,
  });

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    setSubmitted(input.trim());
  };

  return (
    <section>
      <h1 className="mb-4 text-lg font-semibold">{t("search.title")}</h1>
      <form onSubmit={onSubmit} className="mb-4 flex gap-2">
        <input
          type="search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t("search.placeholder")}
          aria-label={t("search.title")}
          className="flex-1 rounded border border-slate-300 px-3 py-2"
        />
        <button type="submit" className="rounded bg-slate-800 px-4 py-2 text-white">
          {t("search.run")}
        </button>
      </form>
      {q.isFetching && <p className="text-slate-500">{t("common.loading")}</p>}
      {q.isError && <p className="text-red-600">{t("common.error")}</p>}
      {q.data !== undefined && q.data.results.length === 0 && (
        <p className="text-slate-500">{t("search.empty")}</p>
      )}
      {q.data !== undefined && q.data.results.length > 0 && (
        <ul className="divide-y divide-slate-200 rounded border border-slate-200 bg-white">
          {q.data.results.map((r) => (
            <li key={r.id} className="px-4 py-3">
              <div className="font-medium">{r.title}</div>
              <div className="text-sm text-slate-600">{r.summary}</div>
              <div className="mt-1 text-xs text-slate-400">
                {r.type} · {t("knowledge.authority")} {r.authority}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
