import { readFile } from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import type { Node as SyntaxNode, Parser } from "web-tree-sitter";
import { createParserFor } from "./treeSitter";
import { CodebaseImportCancelledError, type CodeSymbolKind, type FileImport, type ParsedFile, type ParsedSemanticSymbol, type ScannedFile, type SupportedLanguage } from "./types";
import type { ImportSourceReader } from "./sourceCache";

const MAX_SYMBOLS_PER_FILE = 20;

type LanguageExtractor = {
  nodeTypes: Set<string>;
  extract: (node: SyntaxNode, out: ParsedFile) => void;
};

function addSymbol(out: ParsedFile, name: string | undefined | null, kind: CodeSymbolKind = "symbol"): void {
  if (!name || out.symbols.length >= MAX_SYMBOLS_PER_FILE || out.symbols.includes(name)) return;
  out.symbols.push(name);
  out.symbolRefs ??= [];
  out.symbolRefs.push({ name, kind });
}

const SEMANTIC_NODE_KINDS: Record<SupportedLanguage, Record<string, CodeSymbolKind>> = {
  javascript: { function_declaration: "function", class_declaration: "class", method_definition: "method", arrow_function: "function", function_expression: "function" },
  typescript: { function_declaration: "function", class_declaration: "class", interface_declaration: "interface", type_alias_declaration: "type", enum_declaration: "enum", method_definition: "method", arrow_function: "function", function_expression: "function" },
  tsx: { function_declaration: "function", class_declaration: "class", interface_declaration: "interface", type_alias_declaration: "type", enum_declaration: "enum", method_definition: "method", arrow_function: "function", function_expression: "function" },
  python: { function_definition: "function", class_definition: "class" },
  go: { function_declaration: "function", method_declaration: "method", type_declaration: "type" },
  rust: { function_item: "function", struct_item: "struct", enum_item: "enum", trait_item: "trait", impl_item: "class" },
  php: { function_definition: "function", method_declaration: "method", class_declaration: "class", interface_declaration: "interface", trait_declaration: "trait" },
  c: { function_definition: "function", struct_specifier: "struct", enum_specifier: "enum" },
  cpp: { function_definition: "function", class_specifier: "class", struct_specifier: "struct", enum_specifier: "enum" },
  c_sharp: { method_declaration: "method", constructor_declaration: "method", local_function_statement: "function", class_declaration: "class", interface_declaration: "interface", struct_declaration: "struct", record_declaration: "class", enum_declaration: "enum" },
  dart: { class_definition: "class", enum_declaration: "enum", function_signature: "function", method_signature: "method" },
  java: { class_declaration: "class", interface_declaration: "interface", enum_declaration: "enum", record_declaration: "class", method_declaration: "method", constructor_declaration: "method" },
  kotlin: { class_declaration: "class", object_declaration: "class", function_declaration: "function" },
  swift: { class_declaration: "class", protocol_declaration: "interface", function_declaration: "function" },
  ruby: { class: "class", module: "class", method: "method", singleton_method: "method" },
  scala: { class_definition: "class", trait_definition: "trait", object_definition: "class", enum_definition: "enum", function_definition: "function", function_declaration: "function" },
  lua: { function_definition_statement: "function", local_function_definition_statement: "function" },
  elixir: {},
  vue: { function_declaration: "function", class_declaration: "class", method_definition: "method", arrow_function: "function", function_expression: "function" },
  objc: { class_interface: "class", class_implementation: "class", protocol_declaration: "interface", method_declaration: "method", method_definition: "method" },
  solidity: { contract_declaration: "class", interface_declaration: "interface", library_declaration: "class", struct_declaration: "struct", enum_declaration: "enum", function_definition: "function" },
  zig: { struct_declaration: "struct", enum_declaration: "enum", union_declaration: "type", function_declaration: "function" },
  bash: { function_definition: "function" }
};

function semanticNodeName(node: SyntaxNode): string | null {
  const direct = node.childForFieldName("name")?.text;
  if (direct) return direct;
  const declaration = node.text.slice(0, 240).match(/^(?:public\s+|private\s+|protected\s+|internal\s+|open\s+|abstract\s+|final\s+|sealed\s+|data\s+|local\s+|static\s+|async\s+|pub\s+)*(?:class|interface|struct|record|enum|trait|protocol|object|module|contract|library|def|fun|func|function|fn)\s+([A-Za-z_$][\w$]*)/);
  if (declaration) return declaration[1];
  const objectiveC = node.text.slice(0, 240).match(/^\s*@(?:interface|implementation|protocol)\s+([A-Za-z_$][\w$]*)/);
  if (objectiveC) return objectiveC[1];
  let parent = node.parent;
  for (let depth = 0; parent && depth < 3; depth += 1, parent = parent.parent) {
    const named = parent.childForFieldName("name")?.text;
    if (named && !["function", "class", "interface", "type"].includes(named)) return named;
    const match = parent.text.slice(0, 240).match(/(?:const|let|var)\s+([A-Za-z_$][\w$]*)\s*=/);
    if (match) return match[1];
  }
  return null;
}

function semanticParentName(node: SyntaxNode, language: SupportedLanguage): string | undefined {
  let parent = node.parent;
  while (parent) {
    if (SEMANTIC_NODE_KINDS[language][parent.type]) {
      const name = semanticNodeName(parent);
      if (name) return name;
    }
    parent = parent.parent;
  }
  return undefined;
}

function captureSemanticSymbol(node: SyntaxNode, language: SupportedLanguage, out: ParsedFile): void {
  let kind = SEMANTIC_NODE_KINDS[language][node.type];
  if (!kind) return;
  const name = semanticNodeName(node);
  if (!name) return;
  if (["javascript", "typescript", "tsx"].includes(language) && kind === "function" && /^[A-Z]/.test(name)) kind = "component";
  if (language === "swift" && node.type === "class_declaration") {
    if (/^\s*struct\b/.test(node.text)) kind = "struct";
    else if (/^\s*enum\b/.test(node.text)) kind = "enum";
  }
  const symbol: ParsedSemanticSymbol = {
    name,
    kind,
    startLine: node.startPosition.row + 1,
    endLine: node.endPosition.row + 1,
    parentName: semanticParentName(node, language)
  };
  out.semanticSymbols ??= [];
  if (!out.semanticSymbols.some((item) => item.name === symbol.name && item.startLine === symbol.startLine && item.endLine === symbol.endLine)) {
    out.semanticSymbols.push(symbol);
  }
}

function lastStringLiteral(text: string): string | null {
  const matches = text.match(/["']([^"'\n]+)["']/g);
  if (!matches || !matches.length) return null;
  return matches[matches.length - 1].slice(1, -1);
}

function firstStringLiteral(text: string): string | null {
  const match = text.match(/["']([^"'\n]+)["']/);
  return match ? match[1] : null;
}

function importLine(node: SyntaxNode): number {
  return node.startPosition.row + 1;
}

function jsImportedNames(text: string): string[] {
  const names: string[] = [];
  const named = text.match(/\{([^}]*)\}/)?.[1];
  if (named) {
    for (const part of named.split(",")) {
      const aliases = part.trim().replace(/^type\s+/, "").split(/\s+as\s+/).map((name) => name.trim()).filter(Boolean);
      names.push(...aliases);
    }
  }
  const defaultName = text.match(/^import\s+(?:type\s+)?([A-Za-z_$][\w$]*)\s*(?:,|from)/)?.[1];
  if (defaultName) names.unshift("default");
  if (/^import\s+\*/.test(text)) names.push("*");
  return [...new Set(names)].slice(0, 20);
}

function jsImportBindings(text: string): NonNullable<FileImport["bindings"]> {
  const clause = text.match(/^import\s+(?:type\s+)?([\s\S]*?)\s+from\s+["']/)?.[1]?.trim();
  if (!clause) return [];
  const bindings: NonNullable<FileImport["bindings"]> = [];
  const namespace = clause.match(/\*\s+as\s+([A-Za-z_$][\w$]*)/);
  if (namespace) bindings.push({ imported: "*", local: namespace[1], namespace: true });
  const named = clause.match(/\{([\s\S]*?)\}/)?.[1];
  if (named) {
    for (const part of named.split(",")) {
      const clean = part.trim().replace(/^type\s+/, "");
      if (!clean) continue;
      const [imported, local = imported] = clean.split(/\s+as\s+/).map((value) => value.trim());
      if (imported && local) bindings.push({ imported, local });
    }
  }
  const withoutNamed = clause.replace(/\{[\s\S]*?\}/, "").replace(/\*\s+as\s+[A-Za-z_$][\w$]*/, "").replace(/^\s*,|,\s*$/g, "").trim();
  const defaultBinding = withoutNamed.match(/^([A-Za-z_$][\w$]*)/i)?.[1];
  if (defaultBinding) bindings.unshift({ imported: "default", local: defaultBinding });
  return [...new Map(bindings.map((binding) => [`${binding.imported}\0${binding.local}`, binding])).values()].slice(0, 24);
}

const javascriptExtractor: LanguageExtractor = {
  nodeTypes: new Set(["import_statement", "export_statement", "call_expression", "new_expression"]),
  extract: (node, out) => {
    const text = node.text;
    if (node.type === "import_statement") {
      const spec = lastStringLiteral(text);
      if (spec) out.imports.push({ specifier: spec, kind: "static", importedNames: jsImportedNames(text), bindings: jsImportBindings(text), line: importLine(node), typeOnly: /^import\s+type\b/.test(text) });
      return;
    }
    if (node.type === "export_statement") {
      out.exportCount += 1;
      if (/\bfrom\s+["']/.test(text)) {
        const spec = lastStringLiteral(text);
        if (spec) out.imports.push({ specifier: spec, kind: "reexport", importedNames: jsImportedNames(text), line: importLine(node), typeOnly: /^export\s+type\b/.test(text) });
        return;
      }
      const declared = text.match(/^export\s+(?:default\s+)?(?:abstract\s+)?(?:async\s+)?(function\*?|class|const|let|var|type|interface|enum)\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
      if (declared) {
        const declarationKind: CodeSymbolKind = declared[1].startsWith("function")
          ? "function"
          : declared[1] === "class" || declared[1] === "interface" || declared[1] === "type" || declared[1] === "enum"
            ? declared[1]
            : "symbol";
        addSymbol(out, declared[2], declarationKind);
        return;
      }
      const defaultExport = text.match(/^export\s+default\s+([A-Za-z_$][A-Za-z0-9_$]*)/);
      if (defaultExport) {
        addSymbol(out, defaultExport[1]);
        return;
      }
      const named = text.match(/^export\s*\{([^}]*)\}/);
      if (named) {
        for (const part of named[1].split(",")) {
          addSymbol(out, part.trim().split(/\s+as\s+/).pop()?.trim() || null);
        }
      }
      return;
    }
    if (text.startsWith("require(") || text.startsWith("require (")) {
      const spec = firstStringLiteral(text);
      if (spec) out.imports.push({ specifier: spec, kind: "require", line: importLine(node) });
      return;
    }
    if (text.startsWith("import(") || text.startsWith("import (")) {
      const spec = firstStringLiteral(text);
      if (spec) out.imports.push({ specifier: spec, kind: "dynamic", line: importLine(node) });
      return;
    }
    const constructed = node.type === "new_expression" ? text.match(/^new\s+([A-Za-z_$][\w$]*)\s*\(/)?.[1] : undefined;
    const memberCall = node.type === "call_expression"
      ? text.match(/^([A-Za-z_$][\w$]*)\s*(?:\?\.)?\.\s*([A-Za-z_$][\w$]*)\s*(?:\?\.)?\s*\(/)
      : null;
    const directCall = node.type === "call_expression" ? text.match(/^([A-Za-z_$][\w$]*)\s*(?:\?\.)?\s*\(/)?.[1] : undefined;
    const called = constructed ?? memberCall?.[2] ?? directCall;
    if (called) {
      out.calledSymbols ??= [];
      if (!out.calledSymbols.includes(called)) out.calledSymbols.push(called);
      out.callSites ??= [];
      const site = {
        callee: called,
        ...(memberCall?.[1] ? { receiver: memberCall[1] } : {}),
        line: importLine(node),
        kind: constructed ? "construct" as const : "call" as const
      };
      if (!out.callSites.some((item) => item.line === site.line && item.callee === site.callee && item.receiver === site.receiver && item.kind === site.kind)) {
        out.callSites.push(site);
      }
    }
  }
};

const pythonExtractor: LanguageExtractor = {
  nodeTypes: new Set(["import_statement", "import_from_statement", "function_definition", "class_definition"]),
  extract: (node, out) => {
    if (node.type === "function_definition" || node.type === "class_definition") {
      if (node.parent?.type !== "module") return;
      const name = node.childForFieldName("name")?.text;
      if (name && !name.startsWith("_")) addSymbol(out, name, node.type === "class_definition" ? "class" : "function");
      return;
    }
    const text = node.text.replace(/\\\n/g, " ");
    if (node.type === "import_statement") {
      const body = text.replace(/^import\s+/, "");
      for (const part of body.split(",")) {
        const moduleName = part.trim().split(/\s+as\s+/)[0].trim();
        if (moduleName) out.imports.push({ specifier: moduleName, kind: "static", line: importLine(node) });
      }
      return;
    }
    const match = text.match(/^from\s+([.\w]+)\s+import\b/);
    if (match) {
      const names = text.slice(match[0].length).split(",").map((part) => part.trim().split(/\s+as\s+/)[0]).filter(Boolean);
      out.imports.push({ specifier: match[1], kind: "static", importedNames: names, line: importLine(node) });
    }
  }
};

const goExtractor: LanguageExtractor = {
  nodeTypes: new Set(["import_declaration", "function_declaration", "method_declaration", "type_declaration"]),
  extract: (node, out) => {
    if (node.type !== "import_declaration") {
      const name = node.type === "type_declaration"
        ? node.text.match(/^type\s+([A-Z]\w*)/)?.[1]
        : node.childForFieldName("name")?.text;
      if (name && /^[A-Z]/.test(name)) addSymbol(out, name, node.type === "method_declaration" ? "method" : node.type === "function_declaration" ? "function" : "type");
      return;
    }
    const matches = node.text.match(/"([^"\n]+)"/g) ?? [];
    for (const raw of matches) {
      out.imports.push({ specifier: raw.slice(1, -1), kind: "static" });
    }
  }
};

const rustExtractor: LanguageExtractor = {
  nodeTypes: new Set(["use_declaration", "mod_item", "function_item", "struct_item", "enum_item", "trait_item"]),
  extract: (node, out) => {
    const text = node.text;
    if (["function_item", "struct_item", "enum_item", "trait_item"].includes(node.type)) {
      if (!/^pub\b/.test(text)) return;
      const kind: CodeSymbolKind = node.type === "function_item" ? "function" : node.type === "struct_item" ? "struct" : node.type === "enum_item" ? "enum" : "trait";
      addSymbol(out, node.childForFieldName("name")?.text ?? null, kind);
      return;
    }
    if (node.type === "use_declaration") {
      const body = text.replace(/^(pub(\([^)]*\))?\s+)?use\s+/, "").replace(/;\s*$/, "");
      out.imports.push({ specifier: body.trim(), kind: "use" });
      return;
    }
    const match = text.match(/^(?:pub(?:\([^)]*\))?\s+)?mod\s+(\w+)\s*;/);
    if (match) out.imports.push({ specifier: match[1], kind: "mod" });
  }
};

const phpExtractor: LanguageExtractor = {
  nodeTypes: new Set([
    "namespace_use_declaration",
    "namespace_definition",
    "require_expression",
    "require_once_expression",
    "include_expression",
    "include_once_expression",
    "class_declaration",
    "interface_declaration",
    "function_definition"
  ]),
  extract: (node, out) => {
    const text = node.text;
    if (["class_declaration", "interface_declaration", "function_definition"].includes(node.type)) {
      addSymbol(out, node.childForFieldName("name")?.text ?? null, node.type === "function_definition" ? "function" : node.type === "interface_declaration" ? "interface" : "class");
      return;
    }
    if (node.type === "namespace_definition") {
      const match = text.match(/^namespace\s+([\w\\]+)/);
      if (match) out.declaredNamespaces.push(match[1]);
      return;
    }
    if (node.type === "namespace_use_declaration") {
      const body = text.replace(/^use\s+(function\s+|const\s+)?/, "").replace(/;\s*$/, "");
      for (const part of body.split(",")) {
        const target = part.trim().split(/\s+as\s+/i)[0].trim().replace(/^\\/, "");
        if (target) out.imports.push({ specifier: target, kind: "use" });
      }
      return;
    }
    const spec = firstStringLiteral(text);
    if (spec) out.imports.push({ specifier: spec, kind: "require" });
  }
};

const clikeExtractor: LanguageExtractor = {
  nodeTypes: new Set(["preproc_include"]),
  extract: (node, out) => {
    const text = node.text;
    const quoted = text.match(/#\s*include\s+"([^"\n]+)"/);
    if (quoted) {
      out.imports.push({ specifier: quoted[1], kind: "include" });
      return;
    }
    const angled = text.match(/#\s*include\s+<([^>\n]+)>/);
    if (angled) out.imports.push({ specifier: `<${angled[1]}>`, kind: "include" });
  }
};

const csharpExtractor: LanguageExtractor = {
  nodeTypes: new Set([
    "using_directive",
    "namespace_declaration",
    "file_scoped_namespace_declaration",
    "class_declaration",
    "interface_declaration",
    "struct_declaration",
    "record_declaration",
    "enum_declaration"
  ]),
  extract: (node, out) => {
    const text = node.text;
    if (["class_declaration", "interface_declaration", "struct_declaration", "record_declaration", "enum_declaration"].includes(node.type)) {
      const kind: CodeSymbolKind = node.type === "interface_declaration" ? "interface" : node.type === "struct_declaration" ? "struct" : node.type === "enum_declaration" ? "enum" : "class";
      addSymbol(out, node.childForFieldName("name")?.text ?? null, kind);
      return;
    }
    if (node.type === "using_directive") {
      const match = text.match(/using\s+(?:static\s+)?(?:\w+\s*=\s*)?([\w.]+)\s*;/);
      if (match) out.imports.push({ specifier: match[1], kind: "use" });
      return;
    }
    const match = text.match(/namespace\s+([\w.]+)/);
    if (match) out.declaredNamespaces.push(match[1]);
  }
};

function namespaceImportedNames(specifier: string): string[] {
  const clean = specifier.replace(/\{[\s\S]*$/, "").replace(/[.*{}]+$/, "");
  const name = clean.split(/[.\\/:]+/).filter(Boolean).pop();
  return name ? [name] : [];
}

const dartExtractor: LanguageExtractor = {
  nodeTypes: new Set(["import_or_export", "part_directive", "library_name", "class_definition", "enum_declaration", "function_signature"]),
  extract: (node, out) => {
    const text = node.text;
    const dependency = text.match(/^\s*(import|export)\s+['"]([^'"]+)['"]/);
    if (dependency) {
      out.imports.push({ specifier: dependency[2], kind: dependency[1] === "export" ? "reexport" : "static", line: importLine(node) });
      if (dependency[1] === "export") out.exportCount += 1;
      return;
    }
    const part = text.match(/^\s*part\s+(?!of\b)['"]([^'"]+)['"]/);
    if (part) {
      out.imports.push({ specifier: part[1], kind: "include", line: importLine(node) });
      return;
    }
    const library = text.match(/^\s*library\s+([\w.]+)/);
    if (library) out.declaredNamespaces.push(library[1]);
    if (node.type === "class_definition" || node.type === "enum_declaration") {
      addSymbol(out, semanticNodeName(node), node.type === "enum_declaration" ? "enum" : "class");
    } else if (node.type === "function_signature" && node.parent?.type === "program") {
      addSymbol(out, semanticNodeName(node), "function");
    }
  }
};

const javaExtractor: LanguageExtractor = {
  nodeTypes: new Set(["package_declaration", "import_declaration", "class_declaration", "interface_declaration", "enum_declaration", "record_declaration"]),
  extract: (node, out) => {
    const text = node.text;
    if (node.type === "package_declaration") {
      const match = text.match(/^\s*package\s+([\w.]+)/);
      if (match) out.declaredNamespaces.push(match[1]);
      return;
    }
    if (node.type === "import_declaration") {
      const match = text.match(/^\s*import\s+(?:static\s+)?([\w.*]+)/);
      if (match) out.imports.push({ specifier: match[1], kind: "use", importedNames: namespaceImportedNames(match[1]), line: importLine(node) });
      return;
    }
    const kind: CodeSymbolKind = node.type === "interface_declaration" ? "interface" : node.type === "enum_declaration" ? "enum" : "class";
    addSymbol(out, semanticNodeName(node), kind);
  }
};

const kotlinExtractor: LanguageExtractor = {
  nodeTypes: new Set(["package_header", "import_header", "class_declaration", "object_declaration", "function_declaration"]),
  extract: (node, out) => {
    const text = node.text;
    if (node.type === "package_header") {
      const match = text.match(/^\s*package\s+([\w.]+)/);
      if (match) out.declaredNamespaces.push(match[1]);
      return;
    }
    if (node.type === "import_header") {
      const match = text.match(/^\s*import\s+([\w.*]+)(?:\s+as\s+(\w+))?/);
      if (match) out.imports.push({ specifier: match[1], kind: "use", importedNames: match[2] ? [match[2]] : namespaceImportedNames(match[1]), line: importLine(node) });
      return;
    }
    if (node.type === "function_declaration" && node.parent?.type !== "source_file") return;
    const kind: CodeSymbolKind = node.type === "function_declaration" ? "function" : "class";
    addSymbol(out, semanticNodeName(node), kind);
  }
};

const swiftExtractor: LanguageExtractor = {
  nodeTypes: new Set(["import_declaration", "class_declaration", "protocol_declaration", "function_declaration"]),
  extract: (node, out) => {
    if (node.type === "import_declaration") {
      const match = node.text.match(/^\s*import\s+(?:class\s+|struct\s+|func\s+|enum\s+|protocol\s+|var\s+|let\s+)?([\w.]+)/);
      if (match) out.imports.push({ specifier: match[1], kind: "use", importedNames: namespaceImportedNames(match[1]), line: importLine(node) });
      return;
    }
    if (node.type === "function_declaration" && node.parent?.type !== "source_file") return;
    const kind: CodeSymbolKind = node.type === "protocol_declaration" ? "interface" : node.type === "function_declaration" ? "function" : /^\s*struct\b/.test(node.text) ? "struct" : /^\s*enum\b/.test(node.text) ? "enum" : "class";
    addSymbol(out, semanticNodeName(node), kind);
  }
};

const rubyExtractor: LanguageExtractor = {
  nodeTypes: new Set(["call", "class", "module", "method", "singleton_method"]),
  extract: (node, out) => {
    if (node.type === "call") {
      const match = node.text.match(/^\s*(require_relative|require|load)\s*(?:\(\s*)?['"]([^'"]+)['"]/);
      if (match) out.imports.push({ specifier: match[2], kind: match[1] === "require_relative" ? "include" : "require", line: importLine(node) });
      return;
    }
    if ((node.type === "method" || node.type === "singleton_method") && !["program", "body_statement"].includes(node.parent?.type ?? "")) return;
    addSymbol(out, semanticNodeName(node), node.type === "method" || node.type === "singleton_method" ? "function" : "class");
  }
};

const scalaExtractor: LanguageExtractor = {
  nodeTypes: new Set(["package_clause", "import_declaration", "class_definition", "trait_definition", "object_definition", "enum_definition", "function_definition", "function_declaration"]),
  extract: (node, out) => {
    const text = node.text;
    if (node.type === "package_clause") {
      const match = text.match(/^\s*package\s+([\w.]+)/);
      if (match) out.declaredNamespaces.push(match[1]);
      return;
    }
    if (node.type === "import_declaration") {
      const match = text.match(/^\s*import\s+([\w.]+)/);
      if (match) out.imports.push({ specifier: match[1], kind: "use", importedNames: namespaceImportedNames(match[1]), line: importLine(node) });
      return;
    }
    if ((node.type === "function_definition" || node.type === "function_declaration") && !["compilation_unit", "template_body"].includes(node.parent?.type ?? "")) return;
    const kind: CodeSymbolKind = node.type === "trait_definition" ? "trait" : node.type === "enum_definition" ? "enum" : node.type.startsWith("function_") ? "function" : "class";
    addSymbol(out, semanticNodeName(node), kind);
  }
};

const luaExtractor: LanguageExtractor = {
  nodeTypes: new Set(["call", "function_call", "call_expression", "function_definition_statement", "local_function_definition_statement"]),
  extract: (node, out) => {
    if (node.type === "call") {
      const match = node.text.match(/^\s*require\s*(?:\(\s*)?['"]([^'"]+)['"]/);
      if (match) out.imports.push({ specifier: match[1], kind: "require", line: importLine(node) });
      return;
    }
    addSymbol(out, semanticNodeName(node), "function");
  }
};

const elixirExtractor: LanguageExtractor = {
  nodeTypes: new Set(["call"]),
  extract: (node, out) => {
    const text = node.text;
    const module = text.match(/^\s*defmodule\s+([A-Z][\w.]*)\s+do\b/);
    if (module) {
      out.declaredNamespaces.push(module[1]);
      addSymbol(out, module[1].split(".").pop(), "class");
      return;
    }
    const dependency = text.match(/^\s*(alias|import|use|require)\s+([A-Z][\w.]*)/);
    if (dependency) out.imports.push({ specifier: dependency[2], kind: "use", importedNames: namespaceImportedNames(dependency[2]), line: importLine(node) });
    const fn = text.match(/^\s*defp?\s+([a-z_][\w!?]*)/);
    if (fn) addSymbol(out, fn[1], "function");
  }
};

const objcExtractor: LanguageExtractor = {
  nodeTypes: new Set(["preproc_include", "class_interface", "class_implementation", "protocol_declaration", "method_declaration", "method_definition"]),
  extract: (node, out) => {
    if (node.type === "preproc_include") {
      const quoted = node.text.match(/#\s*(?:import|include)\s+"([^"\n]+)"/);
      if (quoted) out.imports.push({ specifier: quoted[1], kind: "include", line: importLine(node) });
      else {
        const angled = node.text.match(/#\s*(?:import|include)\s+<([^>\n]+)>/);
        if (angled) out.imports.push({ specifier: `<${angled[1]}>`, kind: "include", line: importLine(node) });
      }
      return;
    }
    if (node.type === "class_interface" || node.type === "class_implementation" || node.type === "protocol_declaration") {
      addSymbol(out, semanticNodeName(node), node.type === "protocol_declaration" ? "interface" : "class");
    }
  }
};

const solidityExtractor: LanguageExtractor = {
  nodeTypes: new Set(["import_directive", "contract_declaration", "interface_declaration", "library_declaration", "struct_declaration", "enum_declaration"]),
  extract: (node, out) => {
    if (node.type === "import_directive") {
      const strings = node.text.match(/["']([^"']+)["']/g);
      const specifier = strings?.at(-1)?.slice(1, -1);
      if (specifier) out.imports.push({ specifier, kind: "static", importedNames: [...node.text.matchAll(/\b([A-Za-z_$][\w$]*)\s*(?:as\s+[A-Za-z_$][\w$]*)?(?=\s*[,}])/g)].map((match) => match[1]).slice(0, 20), line: importLine(node) });
      return;
    }
    const kind: CodeSymbolKind = node.type === "interface_declaration" ? "interface" : node.type === "struct_declaration" ? "struct" : node.type === "enum_declaration" ? "enum" : "class";
    addSymbol(out, semanticNodeName(node), kind);
  }
};

const zigExtractor: LanguageExtractor = {
  nodeTypes: new Set(["variable_declaration", "function_declaration"]),
  extract: (node, out) => {
    if (node.type === "variable_declaration") {
      const dependency = node.text.match(/@import\s*\(\s*["']([^"']+)["']\s*\)/);
      if (dependency) {
        out.imports.push({ specifier: dependency[1], kind: "static", line: importLine(node) });
        return;
      }
      const declaration = node.text.match(/\b(?:const|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(struct|enum|union)\b/);
      if (declaration) addSymbol(out, declaration[1], declaration[2] === "struct" ? "struct" : declaration[2] === "enum" ? "enum" : "type");
      return;
    }
    if (/^\s*pub\b/.test(node.text) || node.parent?.type === "source_file") addSymbol(out, semanticNodeName(node), "function");
  }
};

const bashExtractor: LanguageExtractor = {
  nodeTypes: new Set(["command", "function_definition"]),
  extract: (node, out) => {
    if (node.type === "command") {
      const dependency = node.text.match(/^\s*(?:source|\.)\s+["']?([^\s"']+)["']?/);
      if (dependency) out.imports.push({ specifier: dependency[1], kind: "include", line: importLine(node) });
      return;
    }
    addSymbol(out, semanticNodeName(node), "function");
  }
};

const EXTRACTORS: Record<SupportedLanguage, LanguageExtractor> = {
  javascript: javascriptExtractor,
  typescript: javascriptExtractor,
  tsx: javascriptExtractor,
  python: pythonExtractor,
  go: goExtractor,
  rust: rustExtractor,
  php: phpExtractor,
  c: clikeExtractor,
  cpp: clikeExtractor,
  c_sharp: csharpExtractor,
  dart: dartExtractor,
  java: javaExtractor,
  kotlin: kotlinExtractor,
  swift: swiftExtractor,
  ruby: rubyExtractor,
  scala: scalaExtractor,
  lua: luaExtractor,
  elixir: elixirExtractor,
  vue: javascriptExtractor,
  objc: objcExtractor,
  solidity: solidityExtractor,
  zig: zigExtractor,
  bash: bashExtractor
};

function walkTree(root: SyntaxNode, language: SupportedLanguage, extractor: LanguageExtractor, out: ParsedFile): void {
  const cursor = root.walk();
  try {
    let reachedRoot = false;
    while (!reachedRoot) {
      const node = cursor.currentNode;
      captureSemanticSymbol(node, language, out);
      if (extractor.nodeTypes.has(node.type)) extractor.extract(node, out);
      if (cursor.gotoFirstChild()) continue;
      if (cursor.gotoNextSibling()) continue;
      while (true) {
        if (!cursor.gotoParent()) {
          reachedRoot = true;
          break;
        }
        if (cursor.gotoNextSibling()) break;
      }
    }
  } finally {
    cursor.delete();
  }
}

const LIGHTWEIGHT_POLYGLOT_LANGUAGES = new Set<SupportedLanguage>(["dart", "java", "kotlin", "swift", "ruby", "scala", "lua", "elixir", "vue", "objc", "solidity", "zig", "bash"]);

/** Grammar-tolerant extraction used as a fallback and to cap WASM pressure in polyglot repositories. */
function captureStableTextRelations(language: SupportedLanguage, text: string, out: ParsedFile): void {
  const lineAt = (offset: number): number => text.slice(0, offset).split("\n").length;
  const addImport = (specifier: string, kind: FileImport["kind"], offset: number, importedNames?: string[]): void => {
    if (!out.imports.some((item) => item.specifier === specifier && item.kind === kind)) out.imports.push({ specifier, kind, line: lineAt(offset), importedNames });
  };
  if (language === "dart") {
    for (const match of text.matchAll(/^\s*(import|export)\s+["']([^"']+)["']/gm)) addImport(match[2], match[1] === "export" ? "reexport" : "static", match.index ?? 0);
    for (const match of text.matchAll(/^\s*part\s+(?!of\b)["']([^"']+)["']/gm)) addImport(match[1], "include", match.index ?? 0);
    for (const match of text.matchAll(/^\s*(?:abstract\s+|base\s+|final\s+|sealed\s+)?(class|enum|mixin|extension)\s+([A-Za-z_$][\w$]*)/gm)) addSymbol(out, match[2], match[1] === "enum" ? "enum" : "class");
    return;
  }
  if (language === "java" || language === "kotlin" || language === "scala") {
    const packageMatch = text.match(/^\s*package\s+([\w.]+)/m);
    if (packageMatch && !out.declaredNamespaces.includes(packageMatch[1])) out.declaredNamespaces.push(packageMatch[1]);
    for (const match of text.matchAll(/^\s*import\s+(?:static\s+)?([\w.*]+)/gm)) addImport(match[1], "use", match.index ?? 0, namespaceImportedNames(match[1]));
    for (const match of text.matchAll(/^\s*(?:public\s+|private\s+|protected\s+|internal\s+|open\s+|abstract\s+|final\s+|sealed\s+|data\s+)*(class|interface|enum|record|trait|object)\s+([A-Za-z_$][\w$]*)/gm)) {
      addSymbol(out, match[2], match[1] === "interface" ? "interface" : match[1] === "enum" ? "enum" : match[1] === "trait" ? "trait" : "class");
    }
    return;
  }
  if (language === "swift") {
    for (const match of text.matchAll(/^\s*import\s+(?:class\s+|struct\s+|func\s+|enum\s+|protocol\s+)?([\w.]+)/gm)) addImport(match[1], "use", match.index ?? 0, namespaceImportedNames(match[1]));
    for (const match of text.matchAll(/^\s*(?:public\s+|private\s+|internal\s+|open\s+|final\s+)*(class|struct|protocol|enum)\s+([A-Za-z_$][\w$]*)/gm)) {
      addSymbol(out, match[2], match[1] === "struct" ? "struct" : match[1] === "protocol" ? "interface" : match[1] === "enum" ? "enum" : "class");
    }
    return;
  }
  if (language === "ruby") {
    for (const match of text.matchAll(/^\s*(require_relative|require|load)\s*(?:\(\s*)?["']([^"']+)["']/gm)) addImport(match[2], match[1] === "require_relative" ? "include" : "require", match.index ?? 0);
    for (const match of text.matchAll(/^\s*(class|module|def)\s+(?:self\.)?([A-Za-z_$][\w$]*)/gm)) addSymbol(out, match[2], match[1] === "def" ? "function" : "class");
    return;
  }
  if (language === "lua") {
    const pattern = /\brequire\s*(?:\(\s*)?["']([^"']+)["']/g;
    for (const match of text.matchAll(pattern)) {
      if (!out.imports.some((item) => item.specifier === match[1])) {
        out.imports.push({ specifier: match[1], kind: "require", line: lineAt(match.index ?? 0) });
      }
    }
    for (const match of text.matchAll(/^\s*(?:local\s+)?function\s+([A-Za-z_$][\w$]*)/gm)) addSymbol(out, match[1], "function");
    return;
  }
  if (language === "elixir") {
    for (const match of text.matchAll(/^\s*defmodule\s+([A-Z][\w.]*)\s+do\b/gm)) {
      if (!out.declaredNamespaces.includes(match[1])) out.declaredNamespaces.push(match[1]);
      addSymbol(out, match[1].split(".").pop(), "class");
    }
    for (const match of text.matchAll(/^\s*(?:alias|import|use|require)\s+([A-Z][\w.]*)/gm)) addImport(match[1], "use", match.index ?? 0, namespaceImportedNames(match[1]));
    for (const match of text.matchAll(/^\s*defp?\s+([a-z_][\w!?]*)/gm)) addSymbol(out, match[1], "function");
    return;
  }
  if (language === "objc") {
    for (const match of text.matchAll(/^\s*#\s*(?:import|include)\s+([<"])([^>"\n]+)[>"]/gm)) addImport(match[1] === "<" ? `<${match[2]}>` : match[2], "include", match.index ?? 0);
    for (const match of text.matchAll(/^\s*@(interface|implementation|protocol)\s+([A-Za-z_$][\w$]*)/gm)) addSymbol(out, match[2], match[1] === "protocol" ? "interface" : "class");
    return;
  }
  if (language === "solidity") {
    for (const match of text.matchAll(/^\s*import\s+(?:[^;\n]*?\s+from\s+)?["']([^"']+)["']/gm)) addImport(match[1], "static", match.index ?? 0);
    for (const match of text.matchAll(/^\s*(contract|interface|library|struct|enum)\s+([A-Za-z_$][\w$]*)/gm)) addSymbol(out, match[2], match[1] === "interface" ? "interface" : match[1] === "struct" ? "struct" : match[1] === "enum" ? "enum" : "class");
    return;
  }
  if (language === "zig") {
    for (const match of text.matchAll(/@import\s*\(\s*["']([^"']+)["']\s*\)/g)) addImport(match[1], "static", match.index ?? 0);
    for (const match of text.matchAll(/^\s*pub\s+(?:const|var)\s+([A-Za-z_$][\w$]*)\s*=\s*(struct|enum|union)\b/gm)) addSymbol(out, match[1], match[2] === "struct" ? "struct" : match[2] === "enum" ? "enum" : "type");
    for (const match of text.matchAll(/^\s*pub\s+fn\s+([A-Za-z_$][\w$]*)/gm)) addSymbol(out, match[1], "function");
    return;
  }
  if (language === "bash") {
    for (const match of text.matchAll(/^\s*(?:source|\.)\s+["']?([^\s"']+)["']?/gm)) addImport(match[1], "include", match.index ?? 0);
    for (const match of text.matchAll(/^\s*(?:function\s+)?([A-Za-z_$][\w$]*)\s*(?:\(\s*\))?\s*\{/gm)) addSymbol(out, match[1], "function");
    return;
  }
  if (language === "vue") {
    const pattern = /\b(import|export)\s+(?:type\s+)?(?:[^;\n]*?\s+from\s+)?["']([^"']+)["']/g;
    for (const match of text.matchAll(pattern)) {
      if (!out.imports.some((item) => item.specifier === match[2])) {
        const line = text.slice(0, match.index ?? 0).split("\n").length;
        out.imports.push({ specifier: match[2], kind: match[1] === "export" ? "reexport" : "static", line, typeOnly: /\b(?:import|export)\s+type\b/.test(match[0]) });
      }
    }
    for (const match of text.matchAll(/\bexport\s+(?:default\s+)?(?:async\s+)?(?:class|function|const|let|var|interface|type|enum)\s+([A-Za-z_$][\w$]*)/g)) {
      addSymbol(out, match[1]);
    }
  }
}

function emptyParsedFile(file: ScannedFile, language: SupportedLanguage): ParsedFile {
  return { relPath: file.relPath, language, imports: [], declaredNamespaces: [], symbols: [], symbolRefs: [], semanticSymbols: [], calledSymbols: [], exportCount: 0, loc: 0 };
}

async function parseLightweightFile(projectRoot: string, file: ScannedFile, language: SupportedLanguage, sourceReader?: ImportSourceReader): Promise<ParsedFile> {
  const parsed = emptyParsedFile(file, language);
  const bytes = sourceReader ? await sourceReader.read(file.relPath) : await readFile(path.join(projectRoot, file.relPath)).catch(() => null);
  if (!bytes || bytes.includes(0)) {
    parsed.parseError = bytes ? "Skipped: binary" : "Skipped: unreadable";
    return parsed;
  }
  const text = bytes.toString("utf8");
  parsed.loc = text.split("\n").length;
  captureStableTextRelations(language, text, parsed);
  return parsed;
}

export async function parseFiles(
  projectRoot: string,
  files: ScannedFile[],
  options: { onProgress?: (done: number, total: number) => void; deadlineMs?: number; shouldCancel?: () => boolean; sourceReader?: ImportSourceReader; languageConcurrency?: number } = {}
): Promise<ParsedFile[]> {
  const parseable = files.filter((file) => file.language !== null);
  const byLanguage = new Map<SupportedLanguage, ScannedFile[]>();
  for (const file of parseable) {
    const bucket = byLanguage.get(file.language as SupportedLanguage) ?? [];
    bucket.push(file);
    byLanguage.set(file.language as SupportedLanguage, bucket);
  }

  const results: ParsedFile[] = [];
  let done = 0;
  const recordProgress = (): void => {
    done += 1;
    if (done % 200 === 0) options.onProgress?.(done, parseable.length);
  };
  const processLanguage = async (language: SupportedLanguage, bucket: ScannedFile[]): Promise<ParsedFile[]> => {
    const languageResults: ParsedFile[] = [];
    if (byLanguage.size > 4 && LIGHTWEIGHT_POLYGLOT_LANGUAGES.has(language)) {
      for (const file of bucket) {
        if (options.shouldCancel?.()) throw new CodebaseImportCancelledError();
        if (options.deadlineMs && Date.now() > options.deadlineMs) {
          const parsed = emptyParsedFile(file, language);
          parsed.parseError = "Skipped: import time budget exceeded";
          languageResults.push(parsed);
        } else {
          languageResults.push(await parseLightweightFile(projectRoot, file, language, options.sourceReader));
        }
        recordProgress();
      }
      return languageResults;
    }
    let parser: Parser | null = null;
    try {
      parser = await createParserFor(language);
    } catch (error) {
      for (const file of bucket) {
        const parsed = LIGHTWEIGHT_POLYGLOT_LANGUAGES.has(language)
          ? await parseLightweightFile(projectRoot, file, language, options.sourceReader)
          : emptyParsedFile(file, language);
        if (!LIGHTWEIGHT_POLYGLOT_LANGUAGES.has(language)) {
          parsed.parseError = `Grammar unavailable: ${error instanceof Error ? error.message : String(error)}`;
        }
        languageResults.push(parsed);
        recordProgress();
      }
      return languageResults;
    }
    try {
      for (const file of bucket) {
        if (options.shouldCancel?.()) throw new CodebaseImportCancelledError();
        const parsed = emptyParsedFile(file, language);
        if (options.deadlineMs && Date.now() > options.deadlineMs) {
          parsed.parseError = "Skipped: import time budget exceeded";
          languageResults.push(parsed);
          recordProgress();
          continue;
        }
        const bytes = options.sourceReader ? await options.sourceReader.read(file.relPath) : await readFile(path.join(projectRoot, file.relPath)).catch(() => null);
        if (!bytes || bytes.includes(0)) {
          parsed.parseError = bytes ? "Skipped: binary" : "Skipped: unreadable";
          languageResults.push(parsed);
          recordProgress();
          continue;
        }
        const text = bytes.toString("utf8");
        parsed.loc = text.split("\n").length;
        try {
          const tree = parser.parse(text);
          if (tree) {
            try {
              walkTree(tree.rootNode, language, EXTRACTORS[language], parsed);
              captureStableTextRelations(language, text, parsed);
            } finally {
              tree.delete();
            }
          } else {
            parsed.parseError = "Parser returned no tree";
          }
        } catch (error) {
          parsed.parseError = error instanceof Error ? error.message : String(error);
        }
        languageResults.push(parsed);
        recordProgress();
      }
    } finally {
      parser.delete();
    }
    return languageResults;
  };
  const concurrency = options.deadlineMs ? 1 : Math.max(1, Math.min(options.languageConcurrency ?? 3, byLanguage.size));
  const limit = pLimit(concurrency);
  const languageResults = await Promise.all([...byLanguage.entries()].map(([language, bucket]) => limit(() => processLanguage(language, bucket))));
  results.push(...languageResults.flat());
  options.onProgress?.(done, parseable.length);
  const inputOrder = new Map(parseable.map((file, index) => [file.relPath, index]));
  return results.sort((left, right) => (inputOrder.get(left.relPath) ?? 0) - (inputOrder.get(right.relPath) ?? 0));
}
