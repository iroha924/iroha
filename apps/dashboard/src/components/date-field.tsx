import { CalendarIcon } from "lucide-react";
import { Button } from "@/components/ui/button.js";
import { Calendar } from "@/components/ui/calendar.js";
import { Popover, PopoverContent, PopoverTrigger } from "@/components/ui/popover.js";
import { useI18n } from "@/i18n/index.js";
import { cn } from "@/lib/utils";

// Parse/format a bare YYYY-MM-DD using LOCAL calendar parts so the displayed day
// never shifts by a timezone (`new Date("2026-07-22")` would parse as UTC).
function parseLocalDate(value: string): Date | undefined {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return undefined;
  return new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function toLocalIso(date: Date): string {
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, "0");
  const d = String(date.getDate()).padStart(2, "0");
  return `${y}-${m}-${d}`;
}

/**
 * A themed single-date picker (shadcn Popover + Calendar) that displays the
 * chosen day in the app's own locale — replacing the browser-locale native
 * `<input type="date">` whose format could not follow the UI language. Works in
 * bare `YYYY-MM-DD` strings; `min`/`max` (also `YYYY-MM-DD`) bound the range.
 */
export function DateField({
  value,
  onChange,
  placeholder,
  min,
  max,
  ariaLabel,
}: {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  min?: string;
  max?: string;
  ariaLabel?: string;
}) {
  const { locale } = useI18n();
  const selected = value === "" ? undefined : parseLocalDate(value);
  const label =
    selected === undefined
      ? placeholder
      : selected.toLocaleDateString(locale, { year: "numeric", month: "short", day: "numeric" });

  // A union of matchers so days before `min` OR after `max` are disabled. A single
  // `{ before, after }` object is a DateInterval matcher (the days *between*),
  // which would disable the wrong set.
  const disabled: ({ before: Date } | { after: Date })[] = [];
  const minDate = min !== undefined && min !== "" ? parseLocalDate(min) : undefined;
  const maxDate = max !== undefined && max !== "" ? parseLocalDate(max) : undefined;
  if (minDate !== undefined) disabled.push({ before: minDate });
  if (maxDate !== undefined) disabled.push({ after: maxDate });

  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button
            variant="outline"
            size="sm"
            aria-label={ariaLabel}
            className={cn("justify-start gap-2 font-normal", value === "" && "text-ink-faint")}
          >
            <CalendarIcon className="size-4 text-ink-faint" />
            {label}
          </Button>
        }
      />
      <PopoverContent className="w-auto p-0" align="start">
        <Calendar
          mode="single"
          autoFocus
          selected={selected}
          {...(selected !== undefined ? { defaultMonth: selected } : {})}
          disabled={disabled}
          onSelect={(date) => onChange(date === undefined ? "" : toLocalIso(date))}
        />
      </PopoverContent>
    </Popover>
  );
}
