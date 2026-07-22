import type { ReactNode } from "react";
import { useI18n } from "@/i18n/index.js";

/** The three-dot brand mark (matcha / clay / persimmon) — a recurring motif for loaders and empty states. */
export function Mark({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 96 96" className={className} aria-hidden="true" role="img">
      <circle cx="48" cy="37" r="24" fill="#6E7B57" fillOpacity="0.82" />
      <circle cx="35" cy="60" r="24" fill="#BC9870" fillOpacity="0.82" />
      <circle cx="61" cy="60" r="24" fill="#C26A3C" fillOpacity="0.82" />
    </svg>
  );
}

// Button recipes — matcha carries the primary weight; persimmon is reject only.
export const btnPrimary =
  "inline-flex h-10 items-center rounded-xl bg-matcha px-4 font-medium text-paper-raised transition-colors hover:bg-matcha-hover disabled:cursor-not-allowed disabled:bg-hairline-strong disabled:text-ink-faint";
export const btnSecondary =
  "inline-flex h-10 items-center rounded-xl border border-hairline-strong bg-transparent px-4 font-medium text-ink transition-colors hover:bg-paper-inset disabled:opacity-50";
export const btnDanger =
  "inline-flex h-10 items-center rounded-xl bg-persimmon px-4 font-medium text-paper-raised transition-colors hover:bg-persimmon-hover disabled:opacity-50";

export function Card({ children, className = "" }: { children: ReactNode; className?: string }) {
  return (
    <div className={`rounded-2xl border border-hairline bg-paper-raised p-6 ${className}`}>
      {children}
    </div>
  );
}

/** Page title with an editorial ink top-rule and the rounded display face. */
export function PageTitle({ children }: { children: ReactNode }) {
  return (
    <div className="mb-6">
      <div className="mb-3 h-[2px] w-10 bg-ink" />
      <h1 className="font-display text-[30px] font-semibold leading-tight tracking-[-0.01em] text-ink">
        {children}
      </h1>
    </div>
  );
}

type PillTone = "approve" | "pending" | "reject" | "neutral";

export function Pill({ tone, children }: { tone: PillTone; children: ReactNode }) {
  const tones: Record<PillTone, string> = {
    approve: "bg-approve-tint text-approve",
    pending: "bg-warn-tint text-warn",
    reject: "bg-persimmon-tint text-persimmon-hover",
    neutral: "bg-paper-inset text-ink-muted",
  };
  return (
    <span
      className={`inline-flex items-center rounded-full px-2.5 py-0.5 text-[11.5px] font-semibold ${tones[tone]}`}
    >
      {children}
    </span>
  );
}

export function Loading() {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2 py-8 text-ink-muted">
      <Mark className="h-5 w-5 animate-pulse" />
      <span>{t("common.loading")}</span>
    </div>
  );
}

export function ErrorNote() {
  const { t } = useI18n();
  return (
    <p className="rounded-xl bg-persimmon-tint px-3 py-2 text-sm text-persimmon-hover">
      {t("common.error")}
    </p>
  );
}

export function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center gap-3 py-16 text-center">
      <Mark className="h-10 w-10" />
      <p className="text-ink-muted">{message}</p>
    </div>
  );
}

/** A pill-shaped toggle chip (matcha when active) — the shared control for list filters. */
export function FilterChip({
  active,
  onClick,
  children,
}: {
  active: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      onClick={onClick}
      className={`rounded-full border px-3 py-1 text-xs transition-colors ${
        active
          ? "border-matcha bg-matcha text-paper-raised"
          : "border-hairline bg-paper-raised text-ink-muted hover:bg-paper-inset"
      }`}
    >
      {children}
    </button>
  );
}

/** "Load more" affordance for cursor-paginated lists (dashboard-api.md §4). */
export function LoadMore({ onClick, loading }: { onClick: () => void; loading: boolean }) {
  const { t } = useI18n();
  return (
    <div className="mt-4 flex justify-center">
      <button type="button" onClick={onClick} disabled={loading} className={btnSecondary}>
        {loading ? t("common.loading") : t("common.loadMore")}
      </button>
    </div>
  );
}
