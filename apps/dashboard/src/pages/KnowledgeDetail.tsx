import { useQuery } from "@tanstack/react-query";
import { Link, useParams } from "react-router-dom";
import { api } from "@/api/client.js";
import { BackLink, ErrorState, Loading } from "@/components/brand.js";
import { Markdown } from "@/components/markdown.js";
import { Badge } from "@/components/ui/badge.js";
import { useI18n } from "@/i18n/index.js";
import { knowledgeStatusTone } from "@/lib/status.js";

/** Canonical frontmatter is snake_case free-form JSON (`unknown` over the wire), narrowed defensively. */
interface Actor {
  displayName: string | null;
  provider: string | null;
}
interface Source {
  ref: string | null;
  url: string | null;
  path: string | null;
}
interface Provenance {
  createdBy: Actor | null;
  approvedBy: Actor | null;
  labels: string[];
  paths: string[];
  symbols: string[];
  languages: string[];
  sources: Source[];
}

function record(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null ? (value as Record<string, unknown>) : {};
}
function str(value: unknown): string | null {
  return typeof value === "string" && value.length > 0 ? value : null;
}
function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
}
function actor(value: unknown): Actor | null {
  const a = record(value);
  const displayName = str(a.display_name);
  const provider = str(a.provider);
  return displayName === null && provider === null ? null : { displayName, provider };
}

function provenanceFrom(frontmatter: unknown): Provenance {
  const fm = record(frontmatter);
  const scope = record(fm.scope);
  return {
    createdBy: actor(fm.created_by),
    approvedBy: actor(fm.approved_by),
    labels: strings(fm.labels),
    paths: strings(scope.paths),
    symbols: strings(scope.symbols),
    languages: strings(scope.languages),
    sources: Array.isArray(fm.sources)
      ? fm.sources.map((s) => {
          const src = record(s);
          return { ref: str(src.ref), url: str(src.url), path: str(src.path) };
        })
      : [],
  };
}

const SAFE_URL = /^https?:\/\//i;

/** Approved-knowledge detail with rendered body, provenance, and relations (dashboard-api.md §6). */
export function KnowledgeDetail() {
  const { t } = useI18n();
  const { id = "" } = useParams();
  const q = useQuery({ queryKey: ["knowledge", id], queryFn: () => api.knowledgeDetail(id) });

  if (q.isPending) return <Loading />;
  if (q.isError || q.data === undefined) return <ErrorState />;
  const d = q.data;
  const p = provenanceFrom(d.frontmatter);
  const approver = p.approvedBy?.displayName ?? p.approvedBy?.provider ?? null;

  return (
    <section>
      <BackLink to="/knowledge">{t("common.back")}</BackLink>
      <h1 className="font-display text-2xl font-semibold tracking-[-0.005em] text-ink">
        {d.title}
      </h1>
      <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-ink-muted">
        <Badge variant="neutral">{t(`ktype.${d.type}`)}</Badge>
        <Badge variant={knowledgeStatusTone(d.status)}>{t(`status.${d.status}`)}</Badge>
        <span className="tabular-nums">
          {t("knowledge.authority")} {d.authority}
        </span>
        {d.revision !== null && (
          <span className="tabular-nums">
            {t("knowledge.revision")} {d.revision}
          </span>
        )}
      </div>

      {d.summary !== null && d.summary.length > 0 && (
        <p className="mt-4 text-[15px] leading-relaxed text-ink-muted">{d.summary}</p>
      )}

      {d.body !== null && (
        <article className="mt-6 rounded-2xl border border-hairline bg-paper-raised p-6">
          <Markdown source={d.body} />
        </article>
      )}

      <dl className="mt-6 grid grid-cols-1 gap-x-8 gap-y-3 text-sm sm:grid-cols-2">
        {approver !== null && (
          <Meta label={t("knowledge.approvedBy")}>
            {approver}
            {d.approvedAt !== null && (
              <span className="text-ink-faint"> · {d.approvedAt.slice(0, 10)}</span>
            )}
          </Meta>
        )}
        {p.createdBy !== null && (
          <Meta label={t("knowledge.createdBy")}>
            {p.createdBy.displayName ?? p.createdBy.provider}
          </Meta>
        )}
        {p.sources.length > 0 && (
          <Meta label={t("knowledge.sources")}>
            <ul className="space-y-1">
              {p.sources.map((s, i) => (
                <li key={`${s.ref ?? s.url ?? s.path ?? "src"}-${i}`}>
                  {s.url !== null && SAFE_URL.test(s.url) ? (
                    <a
                      href={s.url}
                      className="text-matcha hover:underline"
                      rel="noreferrer noopener"
                    >
                      {s.ref ?? s.url}
                    </a>
                  ) : (
                    <span className="font-mono text-[13px]">{s.ref ?? s.path ?? s.url}</span>
                  )}
                </li>
              ))}
            </ul>
          </Meta>
        )}
        {p.paths.length > 0 && (
          <Meta label={t("knowledge.scopePaths")}>
            <span className="font-mono text-[13px]">{p.paths.join(", ")}</span>
          </Meta>
        )}
        {p.symbols.length > 0 && (
          <Meta label={t("knowledge.scopeSymbols")}>
            <span className="font-mono text-[13px]">{p.symbols.join(", ")}</span>
          </Meta>
        )}
        {p.languages.length > 0 && (
          <Meta label={t("knowledge.languages")}>{p.languages.join(", ")}</Meta>
        )}
        {p.labels.length > 0 && (
          <Meta label={t("knowledge.labels")}>
            <div className="flex flex-wrap gap-1.5">
              {p.labels.map((label, i) => (
                <Badge key={`${label}-${i}`} variant="neutral">
                  {label}
                </Badge>
              ))}
            </div>
          </Meta>
        )}
        {d.canonicalPath !== null && (
          <Meta label={t("knowledge.canonicalPath")}>
            <span className="font-mono text-[13px]">{d.canonicalPath}</span>
          </Meta>
        )}
      </dl>

      {d.relations.length > 0 && (
        <ul className="mt-6 space-y-1.5 text-sm text-ink-muted">
          {d.relations.map((r) => (
            <li key={`${r.direction}-${r.relationType}-${r.entityId}`}>
              <span className="text-ink-faint">{r.direction === "outgoing" ? "→" : "←"}</span>{" "}
              <span className="font-medium text-ink">{r.relationType}</span>{" "}
              <Link to={`/knowledge/${r.entityId}`} className="text-matcha hover:underline">
                {r.entityId}
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

function Meta({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-[11.5px] font-semibold uppercase tracking-wider text-ink-faint">
        {label}
      </dt>
      <dd className="mt-1 text-ink">{children}</dd>
    </div>
  );
}
