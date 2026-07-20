import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { Link, Route, Routes } from "react-router-dom";
import { ApiClientError, api } from "@/api/client.js";
import { type Locale, useI18n } from "@/i18n/index.js";
import { KnowledgeDetail } from "@/pages/KnowledgeDetail.js";
import { KnowledgeList } from "@/pages/KnowledgeList.js";
import { Overview } from "@/pages/Overview.js";
import { ReviewDetail } from "@/pages/ReviewDetail.js";
import { ReviewQueue } from "@/pages/ReviewQueue.js";
import { Search } from "@/pages/Search.js";

function LanguageToggle() {
  const { locale, setLocale } = useI18n();
  return (
    <div className="flex gap-1">
      {(["en", "ja"] as Locale[]).map((l) => (
        <button
          type="button"
          key={l}
          onClick={() => setLocale(l)}
          aria-pressed={locale === l}
          className={`rounded px-2 py-1 text-xs ${
            locale === l ? "bg-slate-800 text-white" : "bg-slate-200 text-slate-700"
          }`}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

export function App() {
  const { t, setLocale } = useI18n();
  const bootstrap = useQuery({ queryKey: ["bootstrap"], queryFn: api.bootstrap });

  useEffect(() => {
    if (bootstrap.data !== undefined) {
      setLocale(bootstrap.data.repository.defaultLanguage);
    }
  }, [bootstrap.data, setLocale]);

  if (
    bootstrap.error instanceof ApiClientError &&
    bootstrap.error.code === "INVALID_SESSION_TOKEN"
  ) {
    return (
      <main className="mx-auto max-w-xl p-8 text-slate-700">
        <p>{t("auth.required")}</p>
      </main>
    );
  }

  const navItems: [string, string][] = [
    ["/", t("nav.overview")],
    ["/review", t("nav.review")],
    ["/knowledge", t("nav.knowledge")],
    ["/search", t("nav.search")],
  ];

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <header className="flex items-center justify-between border-b border-slate-200 bg-white px-6 py-3">
        <div className="flex items-center gap-6">
          <span className="font-semibold">{t("app.title")}</span>
          <nav className="flex gap-4 text-sm">
            {navItems.map(([to, label]) => (
              <Link key={to} to={to} className="text-slate-600 hover:text-slate-900">
                {label}
              </Link>
            ))}
          </nav>
        </div>
        <LanguageToggle />
      </header>
      <main className="mx-auto max-w-5xl p-6">
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/review" element={<ReviewQueue />} />
          <Route path="/review/:id" element={<ReviewDetail />} />
          <Route path="/knowledge" element={<KnowledgeList />} />
          <Route path="/knowledge/:id" element={<KnowledgeDetail />} />
          <Route path="/search" element={<Search />} />
        </Routes>
      </main>
    </div>
  );
}
