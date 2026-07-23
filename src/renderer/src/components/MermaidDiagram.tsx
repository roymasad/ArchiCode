import { formatNumber } from "@renderer/i18n";
import { t } from "@renderer/i18n";
import { useEffect, useId, useState } from "react";

const MAX_MERMAID_SOURCE_LENGTH = 20_000;
let mermaidRenderQueue: Promise<void> = Promise.resolve();

type MermaidRenderResult = {
  error?: string;
  source: string;
  svg?: string;
};

function currentMermaidTheme(): "dark" | "default" {
  if (typeof document === "undefined") return "default";
  return document.documentElement.dataset.theme === "dark" ? "dark" : "default";
}

async function renderMermaid(source: string, id: string, theme: "dark" | "default"): Promise<string> {
  let svg = "";
  const render = mermaidRenderQueue.then(async () => {
    const { default: mermaid } = await import("mermaid");
    mermaid.initialize({
      startOnLoad: false,
      securityLevel: "strict",
      suppressErrorRendering: true,
      theme,
      darkMode: theme === "dark",
      maxTextSize: MAX_MERMAID_SOURCE_LENGTH,
      maxEdges: 300
    });
    ({ svg } = await mermaid.render(id, source));
  });
  mermaidRenderQueue = render.then(() => undefined, () => undefined);
  await render;
  return svg;
}

function errorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) return error.message.split("\n")[0];
  return "The diagram source could not be rendered.";
}

export function MermaidDiagram({ source }: { source: string }) {
  const reactId = useId();
  const renderId = `research-mermaid-${reactId.replace(/[^a-zA-Z0-9_-]/g, "")}`;
  const [theme, setTheme] = useState<"dark" | "default">(() => currentMermaidTheme());
  const [result, setResult] = useState<MermaidRenderResult>({ source });

  useEffect(() => {
    const root = document.documentElement;
    const observer = new MutationObserver(() => setTheme(currentMermaidTheme()));
    observer.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    let cancelled = false;
    if (source.length > MAX_MERMAID_SOURCE_LENGTH) {
      setResult({ source, error: `Diagram source exceeds ${formatNumber(MAX_MERMAID_SOURCE_LENGTH)} characters.` });
      return;
    }

    setResult({ source });
    const timer = window.setTimeout(() => {
      void renderMermaid(source, renderId, theme)
        .then((svg) => {
          if (!cancelled) setResult({ source, svg });
        })
        .catch((error: unknown) => {
          document.getElementById(`d${renderId}`)?.remove();
          if (!cancelled) setResult({ source, error: errorMessage(error) });
        });
    }, 120);

    return () => {
      cancelled = true;
      window.clearTimeout(timer);
    };
  }, [renderId, source, theme]);

  if (result.source === source && result.svg) {
    return (
      <div
        className="research-mermaid"
        aria-label={t("Mermaid diagram")}
        dangerouslySetInnerHTML={{ __html: result.svg }}
      />
    );
  }

  if (result.source === source && result.error) {
    return (
      <div className="research-mermaid-error" role="alert">
        <strong>{t("Unable to render Mermaid diagram.")}</strong>
        <span>{result.error}</span>
        <pre><code className="language-mermaid">{source}</code></pre>
      </div>
    );
  }

  return <div className="research-mermaid-loading" role="status">{t("Rendering diagram…")}</div>;
}
