import { CircleAlertIcon } from "lucide-react";
import type { ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert.js";
import { Button } from "@/components/ui/button.js";
import { useI18n } from "@/i18n/index.js";

/**
 * The three-dot brand mark (matcha / clay / persimmon) — the recurring motif for
 * loaders, empty states, and active nav (brand-and-design.md signature #2).
 */
export function Mark({ className = "h-6 w-6" }: { className?: string }) {
  return (
    <svg viewBox="0 0 96 96" className={className} aria-hidden="true" role="img">
      <circle cx="48" cy="37" r="24" fill="#6E7B57" fillOpacity="0.82" />
      <circle cx="35" cy="60" r="24" fill="#BC9870" fillOpacity="0.82" />
      <circle cx="61" cy="60" r="24" fill="#C26A3C" fillOpacity="0.82" />
    </svg>
  );
}

/**
 * Editorial page header — an uppercase tracked eyebrow, a 2px sumi-ink top rule,
 * and the rounded display face (brand signature #5). Optional description and a
 * right-aligned actions slot.
 */
export function PageHeader({
  eyebrow,
  title,
  description,
  actions,
}: {
  eyebrow?: string;
  title: ReactNode;
  description?: ReactNode;
  actions?: ReactNode;
}) {
  return (
    <div className="mb-8 flex flex-wrap items-end justify-between gap-4">
      <div className="min-w-0">
        <div className="mb-3 h-[2px] w-10 bg-ink" />
        {eyebrow !== undefined && (
          <p className="mb-1.5 text-xs font-semibold uppercase tracking-[0.18em] text-ink-faint">
            {eyebrow}
          </p>
        )}
        <h1 className="font-display text-[30px] font-semibold leading-tight tracking-[-0.01em] text-ink">
          {title}
        </h1>
        {description !== undefined && (
          <p className="mt-2 max-w-2xl text-sm text-ink-muted">{description}</p>
        )}
      </div>
      {actions !== undefined && <div className="flex shrink-0 items-center gap-2">{actions}</div>}
    </div>
  );
}

/** Mark-based loading state (brand signature #2 — the three-circle motif). */
export function Loading({ label }: { label?: string }) {
  const { t } = useI18n();
  return (
    <div className="flex items-center gap-2.5 py-10 text-ink-muted">
      <Mark className="h-5 w-5 animate-pulse" />
      <span className="text-sm">{label ?? t("common.loading")}</span>
    </div>
  );
}

/** Mark-based empty state with an optional action slot. */
export function EmptyState({ message, children }: { message: string; children?: ReactNode }) {
  return (
    <div className="flex flex-col items-center gap-4 py-20 text-center">
      <Mark className="h-11 w-11 opacity-90" />
      <p className="text-ink-muted">{message}</p>
      {children}
    </div>
  );
}

/** Inline error surface (shadcn Alert, persimmon/destructive). */
export function ErrorState({ message }: { message?: string }) {
  const { t } = useI18n();
  return (
    <Alert variant="destructive">
      <CircleAlertIcon />
      <AlertTitle>{t("common.error")}</AlertTitle>
      {message !== undefined && <AlertDescription>{message}</AlertDescription>}
    </Alert>
  );
}

/** A pill-shaped filter toggle (matcha when active) — the shared list-filter control. */
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
    <Button
      type="button"
      size="sm"
      variant={active ? "default" : "outline"}
      aria-pressed={active}
      onClick={onClick}
      className="rounded-full"
    >
      {children}
    </Button>
  );
}

/** "Load more" affordance for cursor-paginated lists (dashboard-api.md §4). */
export function LoadMore({ onClick, loading }: { onClick: () => void; loading: boolean }) {
  const { t } = useI18n();
  return (
    <div className="mt-5 flex justify-center">
      <Button type="button" variant="outline" onClick={onClick} disabled={loading}>
        {loading ? t("common.loading") : t("common.loadMore")}
      </Button>
    </div>
  );
}
