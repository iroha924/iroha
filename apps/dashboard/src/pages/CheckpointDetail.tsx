import { useQuery } from "@tanstack/react-query";
import { useParams } from "react-router-dom";
import { api } from "@/api/client.js";
import { BackLink, ErrorState, Loading } from "@/components/brand.js";
import { Badge } from "@/components/ui/badge.js";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card.js";
import { useI18n } from "@/i18n/index.js";
import { checkpointOutcomeTone, validationResultTone } from "@/lib/status.js";

/** The Checkpoint JSON columns arrive as `unknown` over the wire; narrowed defensively here. */
interface ImplementationItem {
  file: string | null;
  symbol: string | null;
  change: string;
}
interface ValidationItem {
  command: string | null;
  result: string;
  note: string | null;
  durationMs: number | null;
}
interface Reference {
  type: string;
  ref: string;
  url: string | null;
  path: string | null;
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function array(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

const SAFE_URL = /^https?:\/\//i;

function implementationItems(value: unknown): ImplementationItem[] {
  return array(value).map((v) => {
    const item = record(v);
    return { file: str(item.file), symbol: str(item.symbol), change: str(item.change) ?? "" };
  });
}
function validationItems(value: unknown): ValidationItem[] {
  return array(value).map((v) => {
    const item = record(v);
    return {
      command: str(item.command),
      result: str(item.result) ?? "not_run",
      note: str(item.note),
      durationMs: typeof item.durationMs === "number" ? item.durationMs : null,
    };
  });
}
function references(value: unknown): Reference[] {
  return array(value).map((v) => {
    const item = record(v);
    return {
      type: str(item.type) ?? "reference",
      ref: str(item.ref) ?? "",
      url: str(item.url),
      path: str(item.path),
    };
  });
}

/** Structured Checkpoint detail (dashboard-api.md §6): what was done, validated, and left open. */
export function CheckpointDetail() {
  const { t } = useI18n();
  const { id = "", checkpointId = "" } = useParams();
  const q = useQuery({
    queryKey: ["checkpoint", checkpointId],
    queryFn: () => api.checkpoint(checkpointId),
  });

  if (q.isPending) return <Loading />;
  if (q.isError || q.data === undefined) return <ErrorState />;
  const d = q.data;
  const implementation = implementationItems(d.implementation);
  const validation = validationItems(d.validation);
  const unresolved = array(d.unresolved).filter((v): v is string => typeof v === "string");
  const refs = references(d.references);
  const labels = array(d.labels).filter((v): v is string => typeof v === "string");

  return (
    <section>
      <BackLink to={`/sessions/${id}`}>{t("common.back")}</BackLink>
      <div className="flex flex-wrap items-center gap-3">
        <Badge variant={checkpointOutcomeTone(d.outcome)}>{d.outcome}</Badge>
        <h1 className="font-display text-2xl font-semibold tracking-[-0.005em] text-ink">
          {d.objective}
        </h1>
      </div>
      <div className="mt-2 text-xs tabular-nums text-ink-faint">
        {d.createdAt.slice(0, 16).replace("T", " ")}
      </div>

      {d.summary.length > 0 && (
        <p className="mt-4 text-[15px] leading-relaxed text-ink-muted">{d.summary}</p>
      )}

      <div className="mt-6 space-y-6">
        {implementation.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>{t("checkpoint.implementation")}</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="divide-y divide-hairline">
                {implementation.map((item, i) => (
                  <li key={`${item.file ?? item.symbol ?? "impl"}-${i}`} className="py-2.5 text-sm">
                    {(item.file !== null || item.symbol !== null) && (
                      <div className="font-mono text-[13px] text-ink">
                        {item.file ?? item.symbol}
                        {item.file !== null && item.symbol !== null && (
                          <span className="text-ink-faint"> · {item.symbol}</span>
                        )}
                      </div>
                    )}
                    <p className="mt-0.5 text-ink-muted">{item.change}</p>
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {validation.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>{t("checkpoint.validation")}</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="divide-y divide-hairline">
                {validation.map((item, i) => (
                  <li
                    key={`${item.command ?? "check"}-${i}`}
                    className="flex items-center gap-3 py-2.5 text-sm"
                  >
                    <Badge variant={validationResultTone(item.result)}>{item.result}</Badge>
                    <span className="flex-1 font-mono text-[13px] text-ink">
                      {item.command ?? item.note ?? "—"}
                    </span>
                    {item.durationMs !== null && (
                      <span className="text-xs tabular-nums text-ink-faint">
                        {item.durationMs} ms
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {unresolved.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>{t("checkpoint.unresolved")}</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="list-inside list-disc space-y-1 text-sm text-ink">
                {unresolved.map((item, i) => (
                  <li key={`${item.slice(0, 24)}-${i}`}>{item}</li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {refs.length > 0 && (
          <Card>
            <CardHeader>
              <CardTitle>{t("checkpoint.references")}</CardTitle>
            </CardHeader>
            <CardContent>
              <ul className="divide-y divide-hairline">
                {refs.map((ref, i) => (
                  <li key={`${ref.ref}-${i}`} className="flex items-center gap-3 py-2.5 text-sm">
                    <Badge variant="neutral">{ref.type}</Badge>
                    {ref.url !== null && SAFE_URL.test(ref.url) ? (
                      <a
                        href={ref.url}
                        className="font-mono text-[13px] text-matcha hover:underline"
                        rel="noreferrer noopener"
                      >
                        {ref.ref}
                      </a>
                    ) : (
                      <span className="font-mono text-[13px] text-ink">
                        {ref.ref}
                        {ref.path !== null && <span className="text-ink-faint"> · {ref.path}</span>}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </CardContent>
          </Card>
        )}

        {labels.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {labels.map((label, i) => (
              <Badge key={`${label}-${i}`} variant="neutral">
                {label}
              </Badge>
            ))}
          </div>
        )}
      </div>
    </section>
  );
}
