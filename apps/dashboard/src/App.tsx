import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { NavLink, Route, Routes } from "react-router-dom";
import { ApiClientError, api } from "@/api/client.js";
import { Mark } from "@/components/brand.js";
import { Card, CardContent } from "@/components/ui/card.js";
import { Toaster } from "@/components/ui/sonner.js";
import { type Locale, useI18n } from "@/i18n/index.js";
import { cn } from "@/lib/utils";
import { Doctor } from "@/pages/Doctor.js";
import { Graph } from "@/pages/Graph.js";
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
    <div className="flex items-center rounded-full border border-hairline bg-paper p-0.5">
      {(["en", "ja"] as Locale[]).map((l) => (
        <button
          type="button"
          key={l}
          onClick={() => setLocale(l)}
          aria-pressed={locale === l}
          className={cn(
            "rounded-full px-2.5 py-1 text-[11px] font-semibold tracking-wide transition-colors",
            locale === l ? "bg-matcha text-paper-raised" : "text-ink-faint hover:text-ink-muted",
          )}
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
        cn(
          "relative py-4 text-sm transition-colors",
          isActive
            ? "font-medium text-ink after:absolute after:inset-x-0 after:-bottom-px after:h-0.5 after:rounded-full after:bg-matcha"
            : "text-ink-muted hover:text-ink",
        )
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
        <Card className="w-full">
          <CardContent className="flex flex-col items-center gap-4 py-10 text-center">
            <Mark className="h-12 w-12" />
            <p className="text-ink-muted">{t("auth.required")}</p>
          </CardContent>
        </Card>
      </main>
    );
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-40 border-b border-hairline bg-paper-raised/85 backdrop-blur">
        <div className="mx-auto flex h-14 max-w-[1120px] items-center justify-between gap-6 px-6">
          <div className="flex items-center gap-8">
            <img src="/iroha-lockup-horizontal.svg" alt="iroha" className="h-6 w-auto" />
            <nav className="flex items-center gap-6">
              <NavItem to="/" label={t("nav.overview")} />
              <NavItem to="/sessions" label={t("nav.sessions")} />
              <NavItem to="/review" label={t("nav.review")} />
              <NavItem to="/knowledge" label={t("nav.knowledge")} />
              <NavItem to="/graph" label={t("nav.graph")} />
              <NavItem to="/search" label={t("nav.search")} />
            </nav>
          </div>
          <div className="flex items-center gap-5">
            <nav className="flex items-center gap-5">
              <NavItem to="/settings" label={t("nav.settings")} />
              <NavItem to="/doctor" label={t("nav.doctor")} />
            </nav>
            <LanguageToggle />
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-[1120px] px-6 py-10">
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/sessions" element={<Sessions />} />
          <Route path="/sessions/:id" element={<SessionDetail />} />
          <Route path="/sessions/:id/runs/:runId" element={<RunDetail />} />
          <Route path="/review" element={<ReviewQueue />} />
          <Route path="/review/:id" element={<ReviewDetail />} />
          <Route path="/knowledge" element={<KnowledgeList />} />
          <Route path="/knowledge/:id" element={<KnowledgeDetail />} />
          <Route path="/graph" element={<Graph />} />
          <Route path="/search" element={<Search />} />
          <Route path="/settings" element={<Settings />} />
          <Route path="/doctor" element={<Doctor />} />
        </Routes>
      </main>
      <Toaster position="bottom-right" />
    </div>
  );
}
