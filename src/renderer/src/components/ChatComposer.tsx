import { useCallback, useEffect, useRef, useState } from "react";
import type { ProjectBundle } from "@shared/schema";
import { useArchicodeStore, type ComposerSegment } from "../store/useArchicodeStore";

const MENTION_CLASS = "chat-mention";

type NodeOption = {
  flowId: string;
  nodeId: string;
  title: string;
  flowName: string;
  subflowName: string | null;
  label: string;
};

function listAllNodeOptions(bundle: ProjectBundle): NodeOption[] {
  const options: NodeOption[] = [];
  for (const flow of bundle.flows) {
    for (const node of flow.nodes) {
      const subflow = node.subflowId ? flow.subflows.find((sub) => sub.id === node.subflowId) : null;
      options.push({
        flowId: flow.id,
        nodeId: node.id,
        title: node.title,
        flowName: flow.name,
        subflowName: subflow?.name ?? null,
        label: subflow ? `${flow.name} › ${subflow.name} › ${node.title}` : `${flow.name} › ${node.title}`
      });
    }
  }
  return options;
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"']/g, (char) => {
    switch (char) {
      case "&": return "&amp;";
      case "<": return "&lt;";
      case ">": return "&gt;";
      case '"': return "&quot;";
      default: return "&#39;";
    }
  });
}

function segmentsToHtml(segments: ComposerSegment[], bundle: ProjectBundle | null): string {
  let html = "";
  for (const segment of segments) {
    if (segment.kind === "text") {
      html += escapeHtml(segment.text);
      continue;
    }
    if (!bundle) continue;
    const flow = bundle.flows.find((item) => item.id === segment.flowId);
    const node = flow?.nodes.find((item) => item.id === segment.nodeId);
    const title = node ? node.title : "(missing node)";
    html += `<span class="${MENTION_CLASS}${node ? "" : " chat-mention-missing"}" contenteditable="false" data-flow-id="${escapeHtml(segment.flowId)}" data-node-id="${escapeHtml(segment.nodeId)}" spellcheck="false">@${escapeHtml(title)}</span>`;
  }
  return html;
}

function readDomToSegments(root: HTMLElement): ComposerSegment[] {
  const segments: ComposerSegment[] = [];
  root.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      const text = child.textContent ?? "";
      if (text) segments.push({ kind: "text", text });
      return;
    }
    if (child.nodeType !== Node.ELEMENT_NODE) return;
    const element = child as HTMLElement;
    if (element.classList.contains(MENTION_CLASS)) {
      const flowId = element.getAttribute("data-flow-id") ?? "";
      const nodeId = element.getAttribute("data-node-id") ?? "";
      if (flowId && nodeId) segments.push({ kind: "mention", flowId, nodeId });
      return;
    }
    const text = element.textContent ?? "";
    if (text) segments.push({ kind: "text", text });
  });
  const merged: ComposerSegment[] = [];
  for (const segment of segments) {
    const last = merged[merged.length - 1];
    if (segment.kind === "text" && last?.kind === "text") {
      merged[merged.length - 1] = { kind: "text", text: last.text + segment.text };
    } else {
      merged.push(segment);
    }
  }
  return merged.filter((segment) => segment.kind === "mention" || segment.text.length > 0);
}

type ActiveTrigger = {
  textNode: Text;
  startIndex: number;
  query: string;
  range: Range;
};

function getActiveMentionTrigger(root: HTMLElement): ActiveTrigger | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  if (!range.collapsed) return null;
  const node = range.startContainer;
  if (node.nodeType !== Node.TEXT_NODE) return null;
  if (!root.contains(node)) return null;
  const text = (node as Text).textContent ?? "";
  const caret = range.startOffset;
  let i = caret - 1;
  while (i >= 0) {
    const ch = text[i];
    if (ch === "@") {
      if (i > 0 && /[@\w]/.test(text[i - 1])) return null;
      const before = text.slice(i + 1, caret);
      return /^\S*$/.test(before) ? { textNode: node as Text, startIndex: i, query: before, range: range.cloneRange() } : null;
    }
    if (/\s/.test(ch)) return null;
    i -= 1;
  }
  return null;
}

type RenderedTrigger =
  | { kind: "none" }
  | { kind: "popover"; left: number; top: number; options: NodeOption[] };

export function ChatComposer({
  placeholder,
  disabled,
  onSubmit
}: {
  placeholder: string;
  disabled: boolean;
  onSubmit: () => void;
}) {
  const bundle = useArchicodeStore((state) => state.bundle);
  const segments = useArchicodeStore((state) => state.researchDraft);
  const focusNonce = useArchicodeStore((state) => state.researchComposerFocusNonce);
  const setResearchDraft = useArchicodeStore((state) => state.setResearchDraft);
  const requestFocus = useArchicodeStore((state) => state.requestResearchComposerFocus);

  const composerRef = useRef<HTMLDivElement | null>(null);
  const lastSyncHtmlRef = useRef<string>("");
  const internalUpdateRef = useRef<boolean>(false);
  const [renderedTrigger, setRenderedTrigger] = useState<RenderedTrigger>({ kind: "none" });
  const [highlightedIndex, setHighlightedIndex] = useState(0);

  const writeDomFromSegments = useCallback((focus: boolean) => {
    const root = composerRef.current;
    if (!root) return;
    const segmentsNow = useArchicodeStore.getState().researchDraft;
    const bundleNow = useArchicodeStore.getState().bundle;
    const html = segmentsToHtml(segmentsNow, bundleNow);
    if (lastSyncHtmlRef.current !== html) {
      root.innerHTML = html;
      lastSyncHtmlRef.current = html;
    }
    if (focus) {
      requestAnimationFrame(() => {
        const el = composerRef.current;
        if (!el) return;
        el.focus();
        const r = document.createRange();
        r.selectNodeContents(el);
        r.collapse(false);
        const s = window.getSelection();
        s?.removeAllRanges();
        s?.addRange(r);
      });
    }
  }, []);

  useEffect(() => {
    if (internalUpdateRef.current) {
      internalUpdateRef.current = false;
      // This update originated from the DOM itself (syncFromDom), so the DOM
      // already reflects these segments. Record that HTML instead of leaving
      // lastSyncHtmlRef stale, or a later external clear (e.g. after send)
      // that computes the same HTML as the last *known* write would be
      // wrongly treated as a no-op and leave stale text on screen.
      lastSyncHtmlRef.current = segmentsToHtml(segments, bundle);
      return;
    }
    writeDomFromSegments(false);
  }, [writeDomFromSegments, segments, bundle]);

  useEffect(() => {
    writeDomFromSegments(true);
  }, [focusNonce, writeDomFromSegments]);

  const syncFromDom = useCallback(() => {
    const root = composerRef.current;
    if (!root) return;
    const next = readDomToSegments(root);
    const currentStoreSegments = useArchicodeStore.getState().researchDraft;
    const same = next.length === currentStoreSegments.length && next.every((segment, index) => {
      const other = currentStoreSegments[index];
      if (!other || segment.kind !== other.kind) return false;
      if (segment.kind === "text" && other.kind === "text") return segment.text === other.text;
      if (segment.kind === "mention" && other.kind === "mention") return segment.flowId === other.flowId && segment.nodeId === other.nodeId;
      return false;
    });
    if (same) return;
    internalUpdateRef.current = true;
    setResearchDraft(next);
  }, [setResearchDraft]);

  const allOptionsRef = useRef<NodeOption[]>([]);
  allOptionsRef.current = bundle ? listAllNodeOptions(bundle) : [];

  const updateTrigger = useCallback(() => {
    const root = composerRef.current;
    if (!root) {
      setRenderedTrigger({ kind: "none" });
      return;
    }
    const trigger = getActiveMentionTrigger(root);
    if (!trigger) {
      setRenderedTrigger({ kind: "none" });
      return;
    }
    const rootRect = root.getBoundingClientRect();
    const caretRange = trigger.range.cloneRange();
    caretRange.setStart(trigger.textNode, trigger.startIndex);
    const caretRect = caretRange.getBoundingClientRect();
    const query = trigger.query.toLowerCase();
    const matches = allOptionsRef.current
      .filter((option) => !query || option.title.toLowerCase().includes(query) || option.label.toLowerCase().includes(query))
      .slice(0, 12);
    if (!matches.length) {
      setRenderedTrigger({ kind: "none" });
      return;
    }
    setHighlightedIndex(0);
    setRenderedTrigger({
      kind: "popover",
      left: caretRect.left - rootRect.left + root.scrollLeft,
      top: caretRect.bottom - rootRect.top + root.scrollTop,
      options: matches
    });
  }, []);

  const insertMention = useCallback((option: NodeOption) => {
    const root = composerRef.current;
    if (!root) return;
    const trigger = getActiveMentionTrigger(root);
    if (!trigger) return;
    const mentionNode = document.createElement("span");
    mentionNode.className = MENTION_CLASS;
    mentionNode.setAttribute("contenteditable", "false");
    mentionNode.setAttribute("data-flow-id", option.flowId);
    mentionNode.setAttribute("data-node-id", option.nodeId);
    mentionNode.setAttribute("spellcheck", "false");
    mentionNode.textContent = `@${option.title}`;
    const trailingSpace = document.createTextNode(" ");

    const replaceRange = document.createRange();
    replaceRange.setStart(trigger.textNode, trigger.startIndex);
    replaceRange.setEnd(trigger.textNode, Math.min(trigger.startIndex + 1 + trigger.query.length, trigger.textNode.length));
    replaceRange.deleteContents();
    const fragment = document.createDocumentFragment();
    fragment.appendChild(mentionNode);
    fragment.appendChild(trailingSpace);
    replaceRange.insertNode(fragment);

    const caret = document.createRange();
    caret.setStartAfter(trailingSpace);
    caret.collapse(true);
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(caret);

    setRenderedTrigger({ kind: "none" });
    syncFromDom();
    requestFocus();
  }, [requestFocus, syncFromDom]);

  const handleInput = useCallback(() => {
    syncFromDom();
    updateTrigger();
  }, [syncFromDom, updateTrigger]);

  const handleKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>) => {
    if (renderedTrigger.kind === "popover") {
      const options = renderedTrigger.options;
      if (event.key === "Escape") {
        event.preventDefault();
        setRenderedTrigger({ kind: "none" });
        return;
      }
      if (event.key === "ArrowDown" && options.length) {
        event.preventDefault();
        setHighlightedIndex((current) => (current + 1) % options.length);
        return;
      }
      if (event.key === "ArrowUp" && options.length) {
        event.preventDefault();
        setHighlightedIndex((current) => (current - 1 + options.length) % options.length);
        return;
      }
      if (event.key === "Enter" && options.length) {
        event.preventDefault();
        insertMention(options[highlightedIndex]);
        return;
      }
      if (event.key === "Tab" && options.length) {
        event.preventDefault();
        insertMention(options[highlightedIndex]);
        return;
      }
    }
    if (event.key === "Enter" && !event.altKey && !event.shiftKey && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      onSubmit();
    }
  }, [renderedTrigger, highlightedIndex, insertMention, onSubmit]);

  useEffect(() => {
    setRenderedTrigger({ kind: "none" });
  }, [focusNonce]);

  return (
    <div className="chat-composer">
      <div
        ref={composerRef}
        className="chat-composer-input ui-textarea"
        contentEditable={!disabled}
        suppressContentEditableWarning
        spellCheck
        data-placeholder={placeholder}
        onInput={handleInput}
        onKeyDown={handleKeyDown}
        onBlur={() => setRenderedTrigger({ kind: "none" })}
      />
      {renderedTrigger.kind === "popover" && renderedTrigger.options.length ? (
        <div
          className="chat-mention-popover"
          style={{ left: renderedTrigger.left, top: renderedTrigger.top }}
          role="listbox"
          onMouseDown={(event) => event.preventDefault()}
        >
          {renderedTrigger.options.map((option, index) => (
            <button
              key={`${option.flowId}:${option.nodeId}`}
              type="button"
              role="option"
              aria-selected={index === highlightedIndex}
              className={`chat-mention-option${index === highlightedIndex ? " is-active" : ""}`}
              onMouseDown={(event) => {
                event.preventDefault();
                insertMention(option);
              }}
              onMouseEnter={() => setHighlightedIndex(index)}
            >
              <span className="chat-mention-option-title">{option.title}</span>
              <span className="chat-mention-option-context">{option.subflowName ? `${option.flowName} › ${option.subflowName}` : option.flowName}</span>
            </button>
          ))}
        </div>
      ) : null}
    </div>
  );
}