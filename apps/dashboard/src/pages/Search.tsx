import { useQuery } from "@tanstack/react-query";
import { type FormEvent, useState } from "react";
import { api } from "@/api/client.js";
import { btnPrimary, EmptyState, ErrorNote, Loading, PageTitle } from "@/components/ui.js";
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
      <PageTitle>{t("search.title")}</PageTitle>
      <form onSubmit={onSubmit} className="mb-6 flex gap-2">
        <input
          type="search"
          value={input}
          onChange={(e) => setInput(e.target.value)}
          placeholder={t("search.placeholder")}
          aria-label={t("search.title")}
          className="h-10 flex-1 rounded-xl border border-hairline bg-paper-raised px-3 text-ink placeholder:text-ink-faint focus:border-matcha focus:outline-none"
        />
        <button type="submit" className={btnPrimary}>
          {t("search.run")}
        </button>
      </form>
      {q.isFetching && <Loading />}
      {q.isError && <ErrorNote />}
      {q.data !== undefined && q.data.results.length === 0 && (
        <EmptyState message={t("search.empty")} />
      )}
      {q.data !== undefined && q.data.results.length > 0 && (
        <ul className="divide-y divide-hairline overflow-hidden rounded-2xl border border-hairline bg-paper-raised">
          {q.data.results.map((r) => (
            <li key={r.id} className="px-5 py-4">
              <div className="font-medium text-ink">{r.title}</div>
              <div className="mt-0.5 text-sm text-ink-muted">{r.summary}</div>
              <div className="mt-1.5 text-xs text-ink-faint">
                {r.type} · {t("knowledge.authority")} {r.authority}
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
