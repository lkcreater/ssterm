import { memo, useId, type ReactNode } from "react";
import Markdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { ErrorBoundary } from "@/components/error-boundary";
import { plainOnly } from "@/lib/agent-chat";

/**
 * SST-043: agent text (untrusted provider output) as safe Markdown. Raw HTML is dropped (`skipHtml`, no rehype-raw),
 * embedded content is disallowed, every URL attribute is emptied, and links become plain text with their URL shown:
 * nothing is clickable or fetched. No syntax highlighting. Text that is too large or too deeply nested, or that fails to
 * render, is shown as plain text (review H1).
 */
const DISALLOWED = ["img", "picture", "source", "video", "audio", "iframe", "object", "embed", "script", "style", "link", "meta", "base",
  "form", "button", "textarea", "select", "svg", "math"];

type Node = { type: string; url?: string; value?: string; children?: Node[] };
const plainText = (node: Node): string => node.value ?? node.children?.map(plainText).join("") ?? "";
/** remark plugin: a link is replaced by its text, followed by the URL when the text is not already the URL. */
function linksAsText() {
  const visit = (node: Node) => {
    if (!node.children) return;
    node.children = node.children.flatMap((child) => {
      visit(child);
      if (child.type !== "link") return [child];
      const url = child.url ?? "";
      return url && plainText(child) !== url && plainText(child) !== url.replace(/^mailto:/u, "")
        ? [...(child.children ?? []), { type: "text", value: ` (${url})` }] : child.children ?? [];
    });
  };
  return (tree: Node) => visit(tree);
}
const PLUGINS = [remarkGfm, linksAsText];

type Hast = { type: string; tagName?: string; value?: string; children?: Hast[] };
const hastText = (node: Hast): string => node.value ?? node.children?.map(hastText).join("") ?? "";
const headerCells = (node: Hast | undefined): string[] => {
  const head = node?.children?.find((child) => child.tagName === "thead");
  const row = head?.children?.find((child) => child.tagName === "tr");
  return row?.children?.filter((child) => child.tagName === "th").map((cell) => hastText(cell).trim()).filter(Boolean) ?? [];
};

const components: Components = {
  // Reference-style links never become anchors either.
  a: ({ children }) => <span data-link="">{children}</span>,
  // GFM task-list items: a mark as text, never a form control.
  input: ({ checked }) => <span>{checked ? "☑ " : "☐ "}</span>,
  table: ({ children, node }) => {
    const headers = headerCells(node as Hast | undefined);
    return (
      <div className="agent-markdown-table" tabIndex={0} role="region" aria-label={headers.length ? `Table: ${headers.join(", ").slice(0, 120)}` : "Table"}>
        <table>{children}</table>
      </div>
    );
  },
};

const Plain = ({ text }: { text: string }): ReactNode => <div className="agent-markdown whitespace-pre-wrap" data-plain="">{text}</div>;

/** Memoized: unchanged messages are not parsed again when the conversation updates (review M2). */
export const ChatMarkdown = memo(function ChatMarkdown({ text }: { text: string }) {
  // Footnote ids are prefixed per message, so two messages never share an id (review L4).
  const prefix = `md${useId().replace(/[^A-Za-z0-9]/gu, "")}-`;
  if (plainOnly(text)) return <Plain text={text} />;
  return (
    <ErrorBoundary fallback={() => <Plain text={text} />}>
      <div className="agent-markdown">
        <Markdown remarkPlugins={PLUGINS} remarkRehypeOptions={{ clobberPrefix: prefix }} skipHtml disallowedElements={DISALLOWED}
          unwrapDisallowed={false} urlTransform={() => ""} components={components}>
          {text}
        </Markdown>
      </div>
    </ErrorBoundary>
  );
});
