import { fromMarkdown } from "mdast-util-from-markdown";
import type { ReactNode } from "react";

// Derived from the parser's own return type so no separate `@types/mdast`
// dependency is needed (it is transitive to `mdast-util-from-markdown`).
type Root = ReturnType<typeof fromMarkdown>;
type RootContent = Root["children"][number];
type Nodes = Root | RootContent;

/**
 * Renders a canonical Markdown body as React elements — never as HTML. The body
 * is parsed to a CommonMark AST (`mdast-util-from-markdown`, the same parser
 * `@iroha/canonical` uses) and each node is mapped to a React element with
 * brand classes. Nothing is injected via `dangerouslySetInnerHTML`, so under the
 * strict `style-src 'self'`/`script-src 'self'` CSP there is no raw-HTML sink: a
 * raw `html` node (`<script>…`, `<img onerror=…>`) is rendered as its literal
 * text, and a link's `href` is dropped unless it is an http(s)/mailto/relative
 * URL, so a `javascript:` scheme can never reach the DOM.
 */
export function Markdown({ source }: { source: string }) {
  const tree = fromMarkdown(source);
  return (
    <div className="space-y-3 text-[15px] leading-relaxed text-ink">
      {renderNodes(tree.children)}
    </div>
  );
}

const SAFE_URL = /^(?:https?:|mailto:|\/|#|[^:]*$)/i;

/** Drop any scheme that is not http(s)/mailto; keep relative and fragment links. */
function safeHref(url: string): string | undefined {
  return SAFE_URL.test(url) ? url : undefined;
}

function renderNodes(nodes: readonly RootContent[] | undefined): ReactNode {
  return (nodes ?? []).map((node, index) => <Node key={index} node={node} />);
}

const HEADING_CLASS: Record<number, string> = {
  1: "mt-6 font-display text-xl font-semibold tracking-[-0.005em] text-ink",
  2: "mt-6 font-display text-lg font-semibold tracking-[-0.005em] text-ink",
  3: "mt-5 font-display text-base font-semibold text-ink",
  4: "mt-4 text-sm font-semibold uppercase tracking-wider text-ink-muted",
  5: "mt-4 text-sm font-semibold text-ink-muted",
  6: "mt-4 text-sm font-semibold text-ink-faint",
};

function Node({ node }: { node: Nodes }): ReactNode {
  switch (node.type) {
    case "heading": {
      const Tag = `h${Math.min(node.depth, 6)}` as "h1";
      return (
        <Tag className={HEADING_CLASS[Math.min(node.depth, 6)]}>{renderNodes(node.children)}</Tag>
      );
    }
    case "paragraph":
      return <p>{renderNodes(node.children)}</p>;
    case "text":
      return node.value;
    case "strong":
      return <strong className="font-semibold">{renderNodes(node.children)}</strong>;
    case "emphasis":
      return <em className="italic">{renderNodes(node.children)}</em>;
    case "inlineCode":
      return (
        <code className="rounded bg-paper-inset px-1.5 py-0.5 font-mono text-[13px] text-ink">
          {node.value}
        </code>
      );
    case "code":
      return (
        <pre className="overflow-x-auto rounded-2xl border border-hairline bg-paper-inset p-4 font-mono text-[13px] leading-relaxed text-ink">
          <code>{node.value}</code>
        </pre>
      );
    case "list":
      return node.ordered ? (
        <ol className="list-decimal space-y-1 pl-5">{renderNodes(node.children)}</ol>
      ) : (
        <ul className="list-disc space-y-1 pl-5">{renderNodes(node.children)}</ul>
      );
    case "listItem":
      return <li>{renderNodes(node.children)}</li>;
    case "link": {
      const href = safeHref(node.url);
      return href === undefined ? (
        <span>{renderNodes(node.children)}</span>
      ) : (
        <a href={href} className="text-matcha hover:underline" rel="noreferrer noopener">
          {renderNodes(node.children)}
        </a>
      );
    }
    case "blockquote":
      return (
        <blockquote className="border-l-2 border-hairline-strong pl-4 text-ink-muted">
          {renderNodes(node.children)}
        </blockquote>
      );
    case "thematicBreak":
      return <hr className="border-hairline" />;
    case "break":
      return <br />;
    // An image is shown as inert alt text, never fetched (a remote URL is blocked
    // by `img-src 'self' data:` anyway, and this avoids a tracking beacon).
    case "image":
      return node.alt ? <span className="text-ink-faint">{node.alt}</span> : null;
    // A raw HTML node is rendered as its literal text, never as markup.
    case "html":
      return <span className="font-mono text-[13px] text-ink-faint">{node.value}</span>;
    default:
      return "children" in node ? renderNodes(node.children) : null;
  }
}
