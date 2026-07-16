import type { RuntimeService } from "./schema";

export type RuntimeInsight = {
  tone: "neutral" | "success" | "warning" | "danger";
  label: string;
  detail: string;
  at?: string;
};

function compact(text: string, maxLength = 180): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length > maxLength ? `${normalized.slice(0, maxLength - 1)}...` : normalized;
}

function firstUsefulLine(text: string): string {
  return text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean)[0] ?? text.trim();
}

export function classifyRuntimeText(text: string): Omit<RuntimeInsight, "at"> | null {
  const line = firstUsefulLine(text);
  if (!line) return null;
  if (/address already in use|eaddrinuse|port .*in use/i.test(line)) {
    return { tone: "danger", label: "Port conflict", detail: compact(line) };
  }
  if (/missing .*env|environment variable|process\.env|dotenv/i.test(line)) {
    return { tone: "danger", label: "Missing environment", detail: compact(line) };
  }
  if (/cannot find module|module not found|package .*not found|dependency/i.test(line)) {
    return { tone: "danger", label: "Dependency error", detail: compact(line) };
  }
  if (/syntaxerror|typeerror|referenceerror|stack trace|^\s*at\s+\S+/i.test(line)) {
    return { tone: "danger", label: "Runtime exception", detail: compact(line) };
  }
  if (/failed to compile|compile error|build failed|vite.*error|webpack.*error/i.test(line)) {
    return { tone: "danger", label: "Compile error", detail: compact(line) };
  }
  if (/error:|failed|exception|crash/i.test(line)) {
    return { tone: "danger", label: "Runtime error", detail: compact(line) };
  }
  if (/warn|deprecated/i.test(line)) {
    return { tone: "warning", label: "Runtime warning", detail: compact(line) };
  }
  if (/https?:\/\/|localhost|127\.0\.0\.1|listening|ready|compiled successfully|started server/i.test(line)) {
    return { tone: "success", label: "Ready", detail: compact(line) };
  }
  return null;
}

export function runtimeInsight(service: RuntimeService): RuntimeInsight {
  for (const entry of [...service.logs].reverse()) {
    const insight = classifyRuntimeText(entry.text);
    if (insight) return { ...insight, at: entry.at };
  }
  if (service.status === "failed") {
    return { tone: "danger", label: "Runtime failed", detail: "The service exited or could not start.", at: service.stoppedAt };
  }
  if (service.status === "stale") {
    return { tone: "warning", label: "Runtime stale", detail: "The service has not produced recent output.", at: service.lastOutputAt };
  }
  if (service.status === "running" && service.url) {
    return { tone: "success", label: "Ready", detail: service.url, at: service.lastOutputAt };
  }
  if (service.status === "running") {
    return { tone: "neutral", label: "Running", detail: "Waiting for a ready URL or output.", at: service.lastOutputAt };
  }
  return { tone: "neutral", label: service.status, detail: service.command, at: service.lastOutputAt };
}
