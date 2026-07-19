import { isValidElement, memo, useMemo } from "react";
import type { MouseEvent, ReactNode } from "react";
import Markdown, { type Components, type Options as MarkdownOptions, type UrlTransform } from "react-markdown";
import rehypeHighlight from "rehype-highlight";
import remarkGfm from "remark-gfm";
import type { Element, ElementContent, Root, RootContent, Text } from "hast";
import type { Plugin } from "unified";
import { MarkdownImageLink } from "./MarkdownImageLink";
import { MermaidDiagram } from "./MermaidDiagram";

const IMAGE_FILE_EXTENSION = /\.(?:avif|bmp|gif|jpe?g|png|svg|webp)$/i;
const IMAGE_FORMAT_VALUES = new Set(["avif", "bmp", "gif", "jpeg", "jpg", "png", "svg", "webp"]);

export function isSafeMarkdownHref(href: string): boolean {
  return /^(https?:|mailto:|archicode:\/\/)/i.test(href);
}

export type ArchicodeGraphLink =
  | { kind: "project" }
  | { kind: "flow"; flowId: string }
  | { kind: "subflow"; flowId: string; subflowId: string }
  | { kind: "node"; flowId: string; nodeId: string };

export type ArchicodeProjectPathLink = { relativePath: string };

export function parseArchicodeGraphHref(href: string): ArchicodeGraphLink | null {
  try {
    const url = new URL(href);
    if (url.protocol !== "archicode:") return null;
    const parts = url.pathname.split("/").filter(Boolean).map((part) => decodeURIComponent(part));
    if (url.hostname === "project") return { kind: "project" };
    if (url.hostname === "flow" && parts[0]) return { kind: "flow", flowId: parts[0] };
    if (url.hostname === "subflow" && parts[0] && parts[1]) return { kind: "subflow", flowId: parts[0], subflowId: parts[1] };
    if (url.hostname === "node" && parts[0] && parts[1]) return { kind: "node", flowId: parts[0], nodeId: parts[1] };
  } catch {
    return null;
  }
  return null;
}

export function parseArchicodeProjectPathHref(href: string): ArchicodeProjectPathLink | null {
  try {
    const url = new URL(href);
    if (url.protocol !== "archicode:" || url.hostname !== "project-file") return null;
    const relativePath = decodeURIComponent(url.pathname.replace(/^\/+/, ""));
    if (relativePath.includes("\0")) return null;
    return { relativePath };
  } catch {
    return null;
  }
}

export function isImageMarkdownHref(href: string): boolean {
  const projectTarget = parseArchicodeProjectPathHref(href);
  if (projectTarget) return IMAGE_FILE_EXTENSION.test(projectTarget.relativePath);
  try {
    const url = new URL(href);
    if (url.protocol !== "https:") return false;
    const queryFormat = url.searchParams.get("format")?.trim().toLowerCase();
    return IMAGE_FILE_EXTENSION.test(url.pathname) || Boolean(queryFormat && IMAGE_FORMAT_VALUES.has(queryFormat));
  } catch {
    return false;
  }
}

export function openExternalMarkdownHref(href: string): void {
  if (!/^https?:\/\//i.test(href)) {
    window.open(href, "_blank", "noopener,noreferrer");
    return;
  }
  if (window.archicode?.openExternalUrl) {
    void window.archicode.openExternalUrl(href);
    return;
  }
  window.open(href, "_blank", "noopener,noreferrer");
}

export type HighlightRange = { end: number; start: number };

function normalizeHighlightText(content: string): string {
  return content
    .replace(/\r\n?/g, "\n")
    .replace(/```[\w.-]*\n?([\s\S]*?)```/g, "$1")
    .replace(/`([^`\n]+)`/g, "$1")
    .replace(/!\[([^\]\n]*)\]\([^)]+\)/g, "$1")
    .replace(/\[([^\]\n]+)\]\([^) \n]+\)/g, "$1")
    .replace(/^#{1,6}\s+/gm, "")
    .replace(/^\s{0,3}>\s?/gm, "")
    .replace(/^\s*[-*+]\s+/gm, "")
    .replace(/^\s*\d+[.)]\s+/gm, "")
    .replace(/^\s*[-*_]{3,}\s*$/gm, "")
    .replace(/\*\*([^*\n][\s\S]*?)\*\*/g, "$1")
    .replace(/__([^_\n][\s\S]*?)__/g, "$1")
    .replace(/\*([^*\n]+)\*/g, "$1")
    .replace(/_([^_\n]+)_/g, "$1")
    .replace(/~~([^~\n]+)~~/g, "$1")
    .replace(/[`*]+/g, "")
    .replace(/[<>]/g, "")
    .replace(/[ \t]*\n[ \t]*/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function findHighlightRanges(displayText: string, highlightText?: string | null): HighlightRange[] {
  if (!highlightText) return [];
  const normalizedHighlight = normalizeHighlightText(highlightText);
  if (!normalizedHighlight) return [];
  const lowerText = displayText.toLowerCase();
  const lowerHighlight = normalizedHighlight.toLowerCase();
  const exactIndex = lowerText.indexOf(lowerHighlight);
  if (exactIndex >= 0) {
    return [{ start: exactIndex, end: exactIndex + normalizedHighlight.length }];
  }

  const compactText = displayText.replace(/\s+/g, " ").trim();
  const substantialFragment = compactText.length >= 14 || (compactText.length >= 10 && /\s/.test(compactText));
  if (substantialFragment && lowerHighlight.includes(compactText.toLowerCase())) {
    const fragmentStart = displayText.indexOf(compactText);
    return [{ start: Math.max(0, fragmentStart), end: Math.max(0, fragmentStart) + compactText.length }];
  }

  return [];
}

const HIGHLIGHT_BLOCKS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6", "li", "td", "th"]);

function elementText(node: RootContent | ElementContent): string {
  if (node.type === "text") return node.value;
  if (node.type !== "element") return "";
  return node.children.map(elementText).join("");
}

function highlightedTextNodes(text: Text, ranges: HighlightRange[], offset: number): ElementContent[] {
  const localRanges = ranges
    .map((range) => ({
      start: Math.max(0, range.start - offset),
      end: Math.min(text.value.length, range.end - offset)
    }))
    .filter((range) => range.start < range.end)
    .sort((left, right) => left.start - right.start);
  if (!localRanges.length) return [text];

  const nodes: ElementContent[] = [];
  let cursor = 0;
  for (const range of localRanges) {
    if (range.start > cursor) nodes.push({ type: "text", value: text.value.slice(cursor, range.start) });
    nodes.push({
      type: "element",
      tagName: "mark",
      properties: { className: ["research-tts-highlight"] },
      children: [{ type: "text", value: text.value.slice(range.start, range.end) }]
    });
    cursor = range.end;
  }
  if (cursor < text.value.length) nodes.push({ type: "text", value: text.value.slice(cursor) });
  return nodes;
}

function highlightElement(element: Element, highlightText: string): void {
  const ranges = findHighlightRanges(elementText(element), highlightText);
  if (!ranges.length) return;
  let offset = 0;

  const visit = (parent: Element): void => {
    parent.children = parent.children.flatMap((child): ElementContent[] => {
      if (child.type === "text") {
        const start = offset;
        offset += child.value.length;
        return highlightedTextNodes(child, ranges, start);
      }
      if (child.type === "element") visit(child);
      return [child];
    });
  };

  visit(element);
}

function rehypeTtsHighlight(highlightText?: string | null): Plugin<[], Root> {
  return () => (tree) => {
    if (!highlightText?.trim()) return;
    const visit = (node: Root | Element): void => {
      for (const child of node.children) {
        if (child.type !== "element") continue;
        if (HIGHLIGHT_BLOCKS.has(child.tagName)) {
          highlightElement(child, highlightText);
        } else {
          visit(child);
        }
      }
    };
    visit(tree);
  };
}

export const transformMarkdownUrl: UrlTransform = (url, key) => {
  if (key === "src") return /^https:\/\//i.test(url) || parseArchicodeProjectPathHref(url) ? url : "";
  return isSafeMarkdownHref(url) ? url : "";
};

export const ResearchMarkdown = memo(function ResearchMarkdown({ content, highlightText, loadProjectImage, onGraphLink, onProjectPathLink }: {
  content: string;
  highlightText?: string | null;
  loadProjectImage?: (target: ArchicodeProjectPathLink) => Promise<string>;
  onGraphLink?: (target: ArchicodeGraphLink) => void;
  onProjectPathLink?: (target: ArchicodeProjectPathLink) => void;
}) {
  const components = useMemo<Components>(() => ({
    pre: ({ children, node: _node, ...props }) => {
      const code = isValidElement<{ children?: ReactNode; className?: string }>(children) ? children : null;
      const languageClasses = code?.props.className?.split(/\s+/) ?? [];
      if (code && languageClasses.includes("language-mermaid")) {
        const source = String(code.props.children ?? "").replace(/\n$/, "");
        return <MermaidDiagram source={source} />;
      }
      return <pre {...props}>{children}</pre>;
    },
    a: ({ href, children, node: _node, ...props }) => {
      const safeHref = href && isSafeMarkdownHref(href) ? href : undefined;
      const graphTarget = safeHref ? parseArchicodeGraphHref(safeHref) : null;
      const projectPathTarget = graphTarget || !safeHref ? null : parseArchicodeProjectPathHref(safeHref);
      const handleClick = (event: MouseEvent<HTMLAnchorElement>) => {
        event.preventDefault();
        if (graphTarget && onGraphLink) {
          onGraphLink(graphTarget);
          return;
        }
        if (projectPathTarget && onProjectPathLink) {
          onProjectPathLink(projectPathTarget);
          return;
        }
        if (safeHref) openExternalMarkdownHref(safeHref);
      };
      if (safeHref && !graphTarget && isImageMarkdownHref(safeHref)) {
        return (
          <MarkdownImageLink
            href={safeHref}
            label={children}
            projectTarget={projectPathTarget}
            loadProjectImage={loadProjectImage}
            onProjectPathLink={onProjectPathLink}
            onOpenExternal={openExternalMarkdownHref}
          />
        );
      }
      return (
        <a
          {...props}
          href={safeHref}
          target={graphTarget || projectPathTarget ? undefined : "_blank"}
          rel={graphTarget || projectPathTarget ? undefined : "noreferrer"}
          onClick={handleClick}
        >
          {children}
        </a>
      );
    },
    img: ({ src, alt, node: _node, ..._props }) => {
      if (!src) return null;
      const projectTarget = parseArchicodeProjectPathHref(src);
      return (
        <MarkdownImageLink
          href={src}
          label={alt || projectTarget?.relativePath || "Image"}
          projectTarget={projectTarget}
          loadProjectImage={loadProjectImage}
          onProjectPathLink={onProjectPathLink}
          onOpenExternal={openExternalMarkdownHref}
        />
      );
    }
  }), [loadProjectImage, onGraphLink, onProjectPathLink]);
  const rehypePlugins = useMemo<NonNullable<MarkdownOptions["rehypePlugins"]>>(() => [
    [rehypeHighlight, { detect: true, plainText: ["text", "txt", "mermaid"] }],
    rehypeTtsHighlight(highlightText)
  ], [highlightText]);

  return (
    <div className="research-markdown">
      <Markdown
        remarkPlugins={[remarkGfm]}
        rehypePlugins={rehypePlugins}
        components={components}
        urlTransform={transformMarkdownUrl}
        skipHtml
      >
        {content}
      </Markdown>
    </div>
  );
});
