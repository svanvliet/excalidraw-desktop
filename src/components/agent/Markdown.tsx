/**
 * Safe GitHub-flavored Markdown renderer for agent output (react-markdown +
 * remark-gfm: tables, fenced code, task lists, strikethrough, autolinks…).
 * Raw HTML is escaped, never rendered; images are shown as their alt text so
 * model output can't trigger network loads; only http(s) links are clickable
 * and open in the system browser.
 */
import type { MouseEvent, ReactNode } from "react";
import ReactMarkdown, { type Components } from "react-markdown";
import remarkGfm from "remark-gfm";
import { log } from "../../lib/logger";
import { isSafeUrl } from "./markdownParse";

function openLink(e: MouseEvent<HTMLAnchorElement>, href: string) {
  e.preventDefault();
  import("@tauri-apps/plugin-opener")
    .then((m) => m.openUrl(href))
    .catch((err) => log.warn("agent: failed to open link", err));
}

function shiftHeading(Tag: "h3" | "h4" | "h5" | "h6") {
  function Heading({ children }: { children?: ReactNode }) {
    return <Tag>{children}</Tag>;
  }
  return Heading;
}

const COMPONENTS: Components = {
  a: ({ href, children }) =>
    href && isSafeUrl(href) ? (
      <a href={href} onClick={(e) => openLink(e, href)} rel="noreferrer noopener">
        {children}
      </a>
    ) : (
      <span>{children}</span>
    ),
  img: ({ alt }) => (alt ? <span className="md__img-alt">[{alt}]</span> : null),
  h1: shiftHeading("h3"),
  h2: shiftHeading("h4"),
  h3: shiftHeading("h5"),
  h4: shiftHeading("h6"),
  h5: shiftHeading("h6"),
  h6: shiftHeading("h6"),
  table: ({ children }) => (
    <div className="md__table-wrap">
      <table>{children}</table>
    </div>
  ),
};

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      <ReactMarkdown remarkPlugins={[remarkGfm]} components={COMPONENTS}>
        {text}
      </ReactMarkdown>
    </div>
  );
}
