import { useQuery } from "@tanstack/react-query";
import { useEffect } from "react";
import { NavLink, Route, Routes, useLocation, useNavigate } from "react-router-dom";
import { ApiClientError, api } from "@/api/client.js";
import { Mark } from "@/components/brand.js";
import { Card, CardContent } from "@/components/ui/card.js";
import { Dialog, DialogContent } from "@/components/ui/dialog.js";
import { Toaster } from "@/components/ui/toast.js";
import { TooltipProvider } from "@/components/ui/tooltip.js";
import { type Locale, useI18n } from "@/i18n/index.js";
import { useBackgroundLocation } from "@/lib/modal-route.js";
import { cn } from "@/lib/utils";
import { Digest } from "@/pages/Digest.js";
import { Doctor } from "@/pages/Doctor.js";
import { GraphComingSoon } from "@/pages/GraphComingSoon.js";
import { KnowledgeDetail } from "@/pages/KnowledgeDetail.js";
import { KnowledgeList } from "@/pages/KnowledgeList.js";
import { Overview } from "@/pages/Overview.js";
import { ReviewDetail } from "@/pages/ReviewDetail.js";
import { ReviewQueue } from "@/pages/ReviewQueue.js";
import { Search } from "@/pages/Search.js";
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
          isActive ? "font-medium text-ink" : "text-ink-muted hover:text-ink",
        )
      }
    >
      {({ isActive }) => (
        <>
          {label}
          {/* Active indicator carries the three-circle brand motif (matcha/clay/persimmon), not a plain underline. */}
          {isActive && (
            <span
              aria-hidden="true"
              className="absolute inset-x-0 -bottom-px flex h-0.5 overflow-hidden rounded-full"
            >
              <span className="flex-1 bg-matcha" />
              <span className="flex-1 bg-clay" />
              <span className="flex-1 bg-persimmon" />
            </span>
          )}
        </>
      )}
    </NavLink>
  );
}

export function App() {
  const { t, setLocale } = useI18n();
  const location = useLocation();
  const navigate = useNavigate();
  const background = useBackgroundLocation();
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
    <TooltipProvider>
      <div className="min-h-screen">
        <header className="sticky top-0 z-40 border-b border-hairline bg-paper-raised">
          <div className="mx-auto flex h-14 max-w-[1120px] items-center justify-between gap-6 px-6">
            <div className="flex items-center gap-8">
              <img src="/iroha-lockup-horizontal.svg" alt="iroha" className="h-6 w-auto" />
              {/* Two landmarks in one header: without labels a screen reader
                announces "navigation" twice with no way to tell them apart. */}
              <nav aria-label={t("nav.primaryLabel")} className="flex items-center gap-6">
                <NavItem to="/" label={t("nav.digest")} />
                <NavItem to="/overview" label={t("nav.overview")} />
                <NavItem to="/review" label={t("nav.review")} />
                <NavItem to="/knowledge" label={t("nav.knowledge")} />
                <NavItem to="/graph" label={t("nav.graph")} />
                <NavItem to="/search" label={t("nav.search")} />
              </nav>
            </div>
            <div className="flex items-center gap-5">
              <nav aria-label={t("nav.secondaryLabel")} className="flex items-center gap-5">
                <NavItem to="/settings" label={t("nav.settings")} />
                <NavItem to="/doctor" label={t("nav.doctor")} />
              </nav>
              <LanguageToggle />
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-[1120px] px-6 py-10">
          {/* Routed against the background when one is set, so the list a dialog was
            opened from stays mounted underneath instead of unmounting under it. */}
          <Routes location={background ?? location}>
            {/* The Digest is the front page; Overview keeps the non-period view of
              standing state (pending pressure, totals, recent sessions). */}
            <Route path="/" element={<Digest />} />
            <Route path="/overview" element={<Overview />} />
            <Route path="/review" element={<ReviewQueue />} />
            <Route path="/review/:id" element={<ReviewDetail />} />
            <Route path="/knowledge" element={<KnowledgeList />} />
            <Route path="/knowledge/:id" element={<KnowledgeDetail />} />
            <Route path="/graph" element={<GraphComingSoon />} />
            <Route path="/search" element={<Search />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/doctor" element={<Doctor />} />
          </Routes>
        </main>
        {/* Only when a background exists: reaching the same URL directly renders the
          full page above, which is what keeps a knowledge link shareable. */}
        {background !== undefined && (
          <Routes>
            <Route
              path="/knowledge/:id"
              element={
                <Dialog
                  open
                  onOpenChange={(open) => {
                    // Back, not a push to the list: the dialog is one history entry
                    // deep, so this returns to whatever page opened it.
                    if (!open) void navigate(-1);
                  }}
                >
                  {/* 60% of the viewport from `sm` up; below it the base
                      `max-w-[calc(100%-2rem)]` keeps winning, since 60% of a phone
                      is too narrow to read a rendered body in. */}
                  <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-[60vw]">
                    <KnowledgeDetail asDialog />
                  </DialogContent>
                </Dialog>
              }
            />
          </Routes>
        )}
        {/* Outside <main> because it outlives the route that raised it: approving a
          candidate navigates back to the queue, and the confirmation has to survive
          that unmount. */}
        <Toaster closeLabel={t("common.close")} />
      </div>
    </TooltipProvider>
  );
}
