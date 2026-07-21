import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { ApiClientError, api } from "@/api/client.js";
import { Card, Mark } from "@/components/ui.js";
import { type Locale, useI18n } from "@/i18n/index.js";
import { Doctor } from "@/pages/Doctor.js";
import { KnowledgeDetail } from "@/pages/KnowledgeDetail.js";
import { KnowledgeList } from "@/pages/KnowledgeList.js";
import { Overview } from "@/pages/Overview.js";
import { ReviewDetail } from "@/pages/ReviewDetail.js";
import { ReviewQueue } from "@/pages/ReviewQueue.js";
import { RunDetail } from "@/pages/RunDetail.js";
import { Search } from "@/pages/Search.js";
import { SessionDetail } from "@/pages/SessionDetail.js";
import { Sessions } from "@/pages/Sessions.js";
import { Settings } from "@/pages/Settings.js";

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
          className={`rounded-full px-2.5 py-1 text-[11.5px] font-semibold transition-colors ${
            locale === l ? "bg-matcha text-paper-raised" : "text-ink-faint hover:text-ink-muted"
          }`}
        >
          {l.toUpperCase()}
        </button>
      ))}
    </div>
  );
}

function NavItem({ to, label }: { to: string; label: string }) {
  return (
    <NavLink
      to={to}
      end={to === "/"}
      className={({ isActive }) =>
        `border-b-2 pb-0.5 text-sm transition-colors ${
          isActive
            ? "border-matcha font-medium text-ink"
            : "border-transparent text-ink-muted hover:text-ink"
        }`
      }
    >
      {label}
    </NavLink>
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
      <main className="mx-auto flex min-h-screen max-w-md items-center px-6">
        <Card className="w-full text-center">
          <Mark className="mx-auto mb-4 h-12 w-12" />
          <p className="text-ink-muted">{t("auth.required")}</p>
        </Card>
      </main>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="border-b border-hairline bg-paper-raised">
        <div className="mx-auto flex h-14 max-w-[1120px] items-center justify-between px-6">
          <div className="flex items-center gap-8">
            <img src="/iroha-lockup-horizontal.svg" alt="iroha" className="h-6 w-auto" />
            <nav className="flex gap-5">
              <NavItem to="/" label={t("nav.overview")} />
              <NavItem to="/sessions" label={t("nav.sessions")} />
              <NavItem to="/review" label={t("nav.review")} />
              <NavItem to="/knowledge" label={t("nav.knowledge")} />
              <NavItem to="/search" label={t("nav.search")} />
            </nav>
          </div>
          <div className="flex items-center gap-4">
            <nav className="flex gap-4 text-sm">
              <NavItem to="/settings" label={t("nav.settings")} />
              <NavItem to="/doctor" label={t("nav.doctor")} />
            </nav>
            <LanguageToggle />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1120px] px-6 py-8">
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/sessions" element={<Sessions />} />
          <Route path="/sessions/:id" element={<SessionDetail />} />
          <Route path="/sessions/:id/runs/:runId" element={<RunDetail />} />
          <Route path="/review" element={<ReviewQueue />} />
          <Route path="/review/:id" element={<ReviewDetail />} />
          <Route path="/knowledge" element={<KnowledgeList />} />
          <Route path="/knowledge/:id" element={<KnowledgeDetail />} />
          <Route path="/search" element={<Search />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/doctor" element={<Doctor />} />
        </Routes>
      </main>
    </div>
  );
}
