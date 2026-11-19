/**
 * Minimal, safe Markdown renderer for agent output. Builds React elements
 * only (never `dangerouslySetInnerHTML`), so model text can't inject HTML.
 * Supports: paragraphs, ATX headings, bullet/numbered lists, fenced code,
 * blockquotes, inline code, **bold**, *italic*, and http(s) links.
 */
import type { MouseEvent, ReactNode } from "react";
import { log } from "../../lib/logger";
import { isSafeUrl, parseBlocks } from "./markdownParse";

const INLINE =
  /(`[^`\n]+`)|(\*\*[^*\n]+\*\*|__[^_\n]+__)|(\*[^*\n]+\*|_[^_\n]+_)|(\[[^\]\n]+\]\([^)\s]+\))|(https?:\/\/[^\s<>()]+[^\s<>().,;:!?'"])/g;

function openLink(e: MouseEvent<HTMLAnchorElement>, href: string) {
  e.preventDefault();
  import("@tauri-apps/plugin-opener")
    .then((m) => m.openUrl(href))
    .catch((err) => log.warn("agent: failed to open link", err));
}

function link(href: string, label: ReactNode, key: string): ReactNode {
  if (!isSafeUrl(href)) return <span key={key}>{label}</span>;
  return (
    <a key={key} href={href} onClick={(e) => openLink(e, href)} rel="noreferrer noopener">
      {label}
    </a>
  );
}

function renderInline(text: string, keyPrefix = "i"): ReactNode[] {
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  for (const m of text.matchAll(INLINE)) {
    const idx = m.index ?? 0;
    if (idx > last) out.push(text.slice(last, idx));
    const key = `${keyPrefix}-${n++}`;
    const tok = m[0];
    if (m[1]) out.push(<code key={key}>{tok.slice(1, -1)}</code>);
    else if (m[2]) out.push(<strong key={key}>{renderInline(tok.slice(2, -2), key)}</strong>);
    else if (m[3]) out.push(<em key={key}>{renderInline(tok.slice(1, -1), key)}</em>);
    else if (m[4]) {
      const close = tok.indexOf("](");
      out.push(link(tok.slice(close + 2, -1), tok.slice(1, close), key));
    } else if (m[5]) out.push(link(tok, tok, key));
    last = idx + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

function withBreaks(text: string, key: string): ReactNode[] {
  const out: ReactNode[] = [];
  text.split("\n").forEach((line, i) => {
    if (i > 0) out.push(<br key={`${key}-br${i}`} />);
    out.push(...renderInline(line, `${key}-${i}`));
  });
  return out;
}

export function Markdown({ text }: { text: string }) {
  return (
    <div className="md">
      {parseBlocks(text).map((b, i) => {
        const key = `b${i}`;
        switch (b.type) {
          case "p":
            return <p key={key}>{withBreaks(b.text, key)}</p>;
          case "h": {
            const Tag = `h${Math.min(b.level + 2, 6)}` as "h3" | "h4" | "h5" | "h6";
            return <Tag key={key}>{renderInline(b.text, key)}</Tag>;
          }
          case "ul":
          case "ol": {
            const Tag = b.type;
            return (
              <Tag key={key}>
                {b.items.map((it, j) => (
                  <li key={j}>{renderInline(it, `${key}-${j}`)}</li>
                ))}
              </Tag>
            );
          }
          case "code":
            return (
              <pre key={key} data-lang={b.lang || undefined}>
                <code>{b.text}</code>
              </pre>
            );
          case "quote":
            return <blockquote key={key}>{withBreaks(b.text, key)}</blockquote>;
        }
      })}
    </div>
  );
}
