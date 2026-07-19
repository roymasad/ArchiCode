import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { ResearchMarkdown } from "../src/renderer/src/components/ResearchMarkdown";

describe("ResearchMarkdown", () => {
  it("renders fenced code blocks with their language class", () => {
    const html = renderToStaticMarkup(
      <ResearchMarkdown content={'```typescript\nconst answer = 42;\n```'} />
    );

    expect(html).toContain("<pre><code class=\"hljs language-typescript\">");
    expect(html).toContain("hljs-keyword");
    expect(html).toContain("hljs-number");
    expect(html.replace(/<[^>]+>/g, "")).toContain("const answer = 42;");
  });

  it("renders an unfinished streamed code fence safely", () => {
    const html = renderToStaticMarkup(
      <ResearchMarkdown content={'```typescript\nconst partial ='} />
    );

    expect(html).toContain("<pre><code class=\"hljs language-typescript\">");
    expect(html.replace(/<[^>]+>/g, "")).toContain("const partial =");
  });

  it("routes Mermaid fences to the diagram renderer", () => {
    const html = renderToStaticMarkup(
      <ResearchMarkdown content={'```mermaid\nflowchart TD\n  A[Start] --> B[Done]\n```'} />
    );

    expect(html).toContain("research-mermaid-loading");
    expect(html).toContain("Rendering diagram");
    expect(html).not.toContain('class="hljs language-mermaid"');
  });

  it("renders GitHub-flavored tables, task lists, and strikethrough", () => {
    const html = renderToStaticMarkup(
      <ResearchMarkdown content={'| Feature | Ready |\n| --- | --- |\n| Markdown | Yes |\n\n- [x] Tables\n- [ ] Follow-up\n\n~~old~~'} />
    );

    expect(html).toContain("<table>");
    expect(html).toContain("type=\"checkbox\"");
    expect(html).toContain("checked=\"\"");
    expect(html).toContain("<del>old</del>");
  });

  it("preserves ArchiText links and rejects unsafe protocols", () => {
    const html = renderToStaticMarkup(
      <ResearchMarkdown content={'[Node](archicode://node/flow-1/node-1) [Unsafe](javascript:alert(1))'} />
    );

    expect(html).toContain('href="archicode://node/flow-1/node-1"');
    expect(html).not.toContain("javascript:");
  });

  it("keeps TTS highlighting across inline formatting", () => {
    const html = renderToStaticMarkup(
      <ResearchMarkdown content={'Hello **streaming** world'} highlightText="Hello streaming world" />
    );

    expect(html.match(/research-tts-highlight/g)).toHaveLength(3);
    expect(html).toContain("<strong><mark");
  });
});
