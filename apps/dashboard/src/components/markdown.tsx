import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";

const SAFE_URL = /^(?:https?:|mailto:|\/|#|[^:]*$)/i;

/**
 * An allowlist on top of react-markdown's own `urlTransform`, which neutralises a
 * dangerous scheme to an empty string rather than dropping the anchor. Returning
 * `undefined` for both is what keeps a `javascript:` link out of the DOM entirely
 * instead of leaving a clickable `<a href="">`.
 */
function safeHref(url: string | undefined): string | undefined {
  if (url === undefined || url === "") return undefined;
  return SAFE_URL.test(url) ? url : undefined;
}

const HEADING_CLASS: Record<number, string> = {
  1: "mt-6 font-display text-xl font-semibold tracking-[-0.005em] text-ink",
  2: "mt-6 font-display text-lg font-semibold tracking-[-0.005em] text-ink",
  3: "mt-5 font-display text-base font-semibold text-ink",
  4: "mt-4 text-sm font-semibold uppercase tracking-wider text-ink-muted",
  5: "mt-4 text-sm font-semibold text-ink-muted",
  6: "mt-4 text-sm font-semibold text-ink-faint",
};

function heading(depth: number) {
  const Tag = `h${depth}` as "h1";
  return function Heading({ children }: { children?: React.ReactNode }) {
    return <Tag className={HEADING_CLASS[depth]}>{children}</Tag>;
  };
}

const components: Components = {
  h1: heading(1),
  h2: heading(2),
  h3: heading(3),
  h4: heading(4),
  h5: heading(5),
  h6: heading(6),
  p: ({ children }) => <p>{children}</p>,
  strong: ({ children }) => <strong className="font-semibold">{children}</strong>,
  em: ({ children }) => <em className="italic">{children}</em>,
  del: ({ children }) => <del className="text-ink-faint line-through">{children}</del>,
  // GFM fences arrive as <pre><code>; only the inline form needs the chip styling.
  code: ({ children, className }) =>
    className === undefined ? (
      <code className="rounded bg-paper-inset px-1.5 py-0.5 font-mono text-[13px] text-ink">
        {children}
      </code>
    ) : (
      <code className={className}>{children}</code>
    ),
  pre: ({ children }) => (
    <pre className="overflow-x-auto rounded-2xl border border-hairline bg-paper-inset p-4 font-mono text-[13px] leading-relaxed text-ink">
      {children}
    </pre>
  ),
  ul: ({ children }) => <ul className="list-disc space-y-1 pl-5">{children}</ul>,
  ol: ({ children, start }) => (
    <ol className="list-decimal space-y-1 pl-5" {...(start != null ? { start } : {})}>
      {children}
    </ol>
  ),
  li: ({ children }) => <li>{children}</li>,
  blockquote: ({ children }) => (
    <blockquote className="border-l-2 border-hairline-strong pl-4 text-ink-muted">
      {children}
    </blockquote>
  ),
  hr: () => <hr className="border-hairline" />,
  a: ({ href, children }) => {
    const safe = safeHref(href);
    return safe === undefined ? (
      <span>{children}</span>
    ) : (
      <a href={safe} className="text-matcha hover:underline" rel="noreferrer noopener">
        {children}
      </a>
    );
  },
  // Alt text only: a remote URL is never fetched, so a tracking beacon in a body
  // has nothing to load.
  img: ({ alt }) => (alt ? <span className="text-ink-faint">{alt}</span> : null),
  // A table is the one node wide enough to push the page sideways; it scrolls in
  // its own box so the body around it never does.
  table: ({ children }) => (
    <div className="overflow-x-auto rounded-2xl border border-hairline bg-paper-raised">
      <table className="w-full border-collapse text-sm">{children}</table>
    </div>
  ),
  thead: ({ children }) => <thead className="bg-paper-inset">{children}</thead>,
  th: ({ children }) => (
    <th className="px-3.5 py-2.5 text-left font-semibold text-ink">{children}</th>
  ),
  td: ({ children }) => (
    <td className="border-t border-hairline px-3.5 py-2.5 align-top text-ink">{children}</td>
  ),
};

/**
 * Renders a canonical Markdown body as React elements — never as HTML. GFM is on,
 * so the tables and task lists this repository's docs are written with render as
 * such rather than as literal pipes.
 *
 * `rehype-raw` is deliberately absent: without it react-markdown never turns a raw
 * `html` node into markup, so `<script>…` or `<img onerror=…>` in a body stays
 * inert text and there is no `dangerouslySetInnerHTML` sink under the strict
 * `script-src 'self'` CSP. Links go through `safeHref` above, and an image renders
 * as its alt text.
 */
export function Markdown({ source }: { source: string }) {
  return (
    <div className="space-y-3 text-[15px] leading-relaxed text-ink">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={components}>
        {source}
      </ReactMarkdown>
    </div>
  );
}

/**
 * A summary rendered with its inline formatting but no block structure — the
 * places that show one (the detail lead, a search row) size it as one line,
 * so a heading or list there would break the row rather than inform it.
 */
const INLINE_COMPONENTS: Components = {
  ...components,
  p: ({ children }) => <>{children}</>,
  // Dropped, not unwrapped — see `disallowedElements` below.
  table: () => null,
};

export function MarkdownInline({ source }: { source: string }) {
  return (
    <ReactMarkdown
      remarkPlugins={[remarkGfm]}
      components={INLINE_COMPONENTS}
      // A summary is one line by construction; anything block-level in it is a
      // truncation artefact, not authored structure. A table is *dropped* rather
      // than unwrapped with the rest: unwrapping keeps its children, so the
      // `<thead>`/`<tbody>` would land straight under a `<div>` — markup no
      // browser accepts and React warns about.
      disallowedElements={["h1", "h2", "h3", "h4", "h5", "h6", "ul", "ol", "li", "pre"]}
      unwrapDisallowed
    >
      {source}
    </ReactMarkdown>
  );
}
