import type { ContentInteraction, ContentInventory } from "./inventory";
import type { CodeRelationKind, FileDependencyGraph, FileEdge } from "./types";

function normalizedRuntimePath(raw: string): string | null {
  let target = raw.trim();
  if (!target) return null;
  if (/^https?:\/\//i.test(target)) {
    try {
      target = new URL(target).pathname;
    } catch {
      return null;
    }
  } else if (target.startsWith("${")) {
    const close = target.indexOf("}");
    if (close === -1) return null;
    target = target.slice(close + 1);
  } else if (target.startsWith("$")) {
    const slash = target.indexOf("/");
    if (slash === -1) return null;
    target = target.slice(slash);
  }
  target = target.split(/[?#]/)[0]
    .replace(/\$\{[^}]+\}/g, ":*")
    .replace(/:[A-Za-z_][\w-]*/g, ":*");
  if (!target.startsWith("/") || /[$`{}]/.test(target)) return null;
  return target.length > 1 ? target.replace(/\/+$/, "") : target;
}

function addRuntimeEdge(
  graph: FileDependencyGraph,
  edgeByKey: Map<string, FileEdge>,
  source: ContentInteraction,
  target: ContentInteraction,
  relation: Extract<CodeRelationKind, "ipc" | "http" | "hosts" | "event" | "shared-data">,
  specifier: string
): void {
  if (source.file === target.file) return;
  const key = `${source.file}\u0000${target.file}`;
  const confidence = Math.min(source.confidence ?? 0.9, target.confidence ?? 0.9);
  const existing = edgeByKey.get(key);
  if (existing) {
    existing.occurrences = (existing.occurrences ?? 1) + 1;
    existing.relationKinds = [...new Set([...(existing.relationKinds ?? []), relation])];
    existing.confidence = Math.min(existing.confidence ?? 1, confidence);
    existing.evidence ??= [];
    if (!existing.evidence.some((item) => item.line === source.line && item.specifier === specifier) && existing.evidence.length < 8) {
      existing.evidence.push({ line: source.line, specifier });
    }
    return;
  }
  const edge: FileEdge = {
    from: source.file,
    to: target.file,
    kinds: [],
    importedNames: [],
    evidence: [{ line: source.line, specifier }],
    occurrences: 1,
    confidence,
    relationKinds: [relation]
  };
  graph.edges.push(edge);
  edgeByKey.set(key, edge);
}

/** Add only correlations backed by matching literal channels or method/path pairs. */
export function addHighConfidenceRuntimeEdges(graph: FileDependencyGraph, inventory: ContentInventory): number {
  const edgeByKey = new Map(graph.edges.map((edge) => [`${edge.from}\u0000${edge.to}`, edge]));
  let added = 0;
  const sends = inventory.interactions.filter((item) => item.kind === "ipc-send");
  const handlers = inventory.interactions.filter((item) => item.kind === "ipc-handle");
  for (const send of sends) {
    for (const handler of handlers) {
      const sendChannel = send.target.split("#")[0];
      const handlerChannel = handler.target.split("#")[0];
      const sendMethod = send.target.split("#")[1];
      const handlerMethod = handler.target.split("#")[1];
      if (sendChannel !== handlerChannel || (sendMethod && handlerMethod && handlerMethod !== "*" && sendMethod !== handlerMethod)) continue;
      const before = graph.edges.length;
      addRuntimeEdge(graph, edgeByKey, send, handler, "ipc", `ipc:${send.target}`);
      if (graph.edges.length > before) added += 1;
    }
  }

  for (const writer of inventory.interactions.filter((item) => item.kind === "shared-write")) {
    for (const reader of inventory.interactions.filter((item) => item.kind === "shared-read")) {
      if (writer.target !== reader.target) continue;
      const before = graph.edges.length;
      addRuntimeEdge(graph, edgeByKey, writer, reader, "shared-data", `shared-data:${writer.target}`);
      if (graph.edges.length > before) added += 1;
    }
  }

  const urlByFactory = new Map(inventory.interactions.filter((item) => item.kind === "http-url" && item.reference).map((item) => [item.reference as string, item.target]));
  const calls = inventory.interactions.filter((item) => item.kind === "http-call").map((item) => {
    if (!item.target.startsWith("@uri:")) return item;
    const resolved = urlByFactory.get(item.target.slice("@uri:".length));
    return resolved ? { ...item, target: resolved } : item;
  });
  const routes = inventory.interactions.filter((item) => item.kind === "http-route");
  for (const call of calls) {
    const callPath = normalizedRuntimePath(call.target);
    if (!callPath) continue;
    for (const route of routes) {
      const routePath = normalizedRuntimePath(route.target);
      if (!routePath || routePath !== callPath) continue;
      if (call.method && route.method && call.method !== route.method) continue;
      const method = call.method ?? route.method ?? "HTTP";
      const before = graph.edges.length;
      addRuntimeEdge(graph, edgeByKey, call, route, "http", `http:${method} ${callPath}`);
      if (graph.edges.length > before) added += 1;
    }
  }

  // Native shells that literally embed the Flutter runtime host the app's entrypoint;
  // without this the native platform system floats disconnected from the app it runs.
  const appEntrypoint = inventory.entrypoints.find((entry) => /(^|\/)main\.dart$/.test(entry));
  if (appEntrypoint) {
    const entryInteraction: ContentInteraction = { file: appEntrypoint, kind: "platform-host", target: "flutter-app", confidence: 0.97 };
    for (const host of inventory.interactions.filter((item) => item.kind === "platform-host")) {
      const before = graph.edges.length;
      addRuntimeEdge(graph, edgeByKey, host, entryInteraction, "hosts", "hosts:flutter-app");
      if (graph.edges.length > before) added += 1;
    }
  }
  return added;
}
