import { readdir, stat } from "node:fs/promises";
import path from "node:path";
import pLimit from "p-limit";
import { isImportIgnoredDirectory, isIgnoredPath, loadIgnoreLayer, type IgnoreLayer } from "./ignore";
import { CodebaseImportCancelledError, type FileRole, type RepoScan, type ScannedFile, type SupportedLanguage } from "./types";
import { languageForSemanticSource } from "./sourceLanguages";

const LANGUAGE_BY_EXT: Record<string, SupportedLanguage> = {
  ".js": "javascript",
  ".jsx": "javascript",
  ".mjs": "javascript",
  ".cjs": "javascript",
  ".ts": "typescript",
  ".mts": "typescript",
  ".cts": "typescript",
  ".tsx": "tsx",
  ".py": "python",
  ".go": "go",
  ".rs": "rust",
  ".php": "php",
  ".c": "c",
  ".h": "c",
  ".cc": "cpp",
  ".cpp": "cpp",
  ".cxx": "cpp",
  ".hpp": "cpp",
  ".hh": "cpp",
  ".hxx": "cpp",
  ".cs": "c_sharp",
  ".dart": "dart",
  ".java": "java",
  ".kt": "kotlin",
  ".kts": "kotlin",
  ".swift": "swift",
  ".rb": "ruby",
  ".rake": "ruby",
  ".scala": "scala",
  ".sc": "scala",
  ".lua": "lua",
  ".ex": "elixir",
  ".exs": "elixir",
  ".vue": "vue",
  ".m": "objc",
  ".mm": "objc",
  ".sol": "solidity",
  ".zig": "zig",
  ".sh": "bash",
  ".bash": "bash",
  ".zsh": "bash"
};

export function languageForFile(relPath: string): SupportedLanguage | null {
  return LANGUAGE_BY_EXT[path.extname(relPath).toLowerCase()] ?? null;
}

export function roleForFile(relPath: string): FileRole {
  const lower = relPath.toLowerCase();
  const name = path.posix.basename(lower);
  if (/(^|\/)(__generated__|generated|gen)\//.test(lower) || /\.(generated|g)\.[^.]+$/.test(name)) return "generated";
  if (/(^|\/)(test|tests|__tests__|spec|specs)\//.test(lower) || /\.(test|spec)\.[^.]+$/.test(name)) return "test";
  if (/(^|\/)(fixture|fixtures|testdata|samples?)\//.test(lower)) return "fixture";
  if (/(^|\/)(migration|migrations)\//.test(lower)) return "migration";
  if (/(^|\/)(docs?|documentation)\//.test(lower) || /^(readme|changelog|contributing|architecture)(\.|$)/.test(name) || /\.(md|mdx|rst|adoc)$/.test(name)) return "docs";
  if (/\.(png|jpe?g|gif|webp|svg|ico|icns|mp3|wav|mp4|mov|woff2?|ttf|otf)$/.test(name)) return "asset";
  if (/(^|\/)(scripts?|tools?)\//.test(lower)) return "tooling";
  if (/^(package(-lock)?\.json|tsconfig.*\.json|vite\.config\.|webpack\.config\.|cargo\.toml|go\.mod|composer\.json|.*\.csproj|dockerfile|docker-compose|\.env)/.test(name) || /\.(ya?ml|toml|ini|lock)$/.test(name)) return "config";
  return "production";
}

export async function scanRepository(
  projectRoot: string,
  options: { onProgress?: (scanned: number) => void; deadlineMs?: number; shouldCancel?: () => boolean } = {}
): Promise<RepoScan> {
  const limit = pLimit(16);
  const files: ScannedFile[] = [];
  let truncated = false;

  async function walk(dirRelPath: string, layers: IgnoreLayer[]): Promise<void> {
    if (options.shouldCancel?.()) throw new CodebaseImportCancelledError();
    if (options.deadlineMs && Date.now() > options.deadlineMs) {
      truncated = true;
      return;
    }
    const absoluteDir = path.join(projectRoot, dirRelPath);
    const entries = await limit(() => readdir(absoluteDir, { withFileTypes: true }).catch(() => []));
    const ownLayer = await loadIgnoreLayer(projectRoot, dirRelPath);
    const activeLayers = ownLayer ? [...layers, ownLayer] : layers;

    const subdirectories: string[] = [];
    for (const entry of entries) {
      if (entry.isSymbolicLink()) continue;
      const relPath = dirRelPath ? `${dirRelPath}/${entry.name}` : entry.name;
      if (entry.isDirectory()) {
        if (isImportIgnoredDirectory(entry.name)) continue;
        if (isIgnoredPath(activeLayers, relPath, true)) continue;
        subdirectories.push(relPath);
        continue;
      }
      if (!entry.isFile()) continue;
      if (isIgnoredPath(activeLayers, relPath, false)) continue;
      const language = languageForFile(relPath);
      files.push({
        relPath,
        ext: path.extname(entry.name).toLowerCase(),
        sizeBytes: 0,
        language,
        detectedLanguage: language ?? languageForSemanticSource(relPath),
        role: roleForFile(relPath)
      });
      if (files.length % 500 === 0) options.onProgress?.(files.length);
    }
    await Promise.all(subdirectories.map((subdirectory) => walk(subdirectory, activeLayers)));
  }

  await walk("", []);
  files.sort((a, b) => a.relPath.localeCompare(b.relPath));

  // Real sizes let downstream ranking (key files, descriptions) work for languages we
  // cannot parse for line counts.
  await Promise.all(files.map((file) => limit(async () => {
    file.sizeBytes = (await stat(path.join(projectRoot, file.relPath)).catch(() => null))?.size ?? 0;
  })));

  const byLanguage: Record<string, number> = {};
  const byDetectedLanguage: Record<string, number> = {};
  for (const file of files) {
    if (file.language) byLanguage[file.language] = (byLanguage[file.language] ?? 0) + 1;
    if (file.detectedLanguage) byDetectedLanguage[file.detectedLanguage] = (byDetectedLanguage[file.detectedLanguage] ?? 0) + 1;
  }
  return {
    files,
    truncated,
    stats: {
      totalFiles: files.length,
      byLanguage,
      byDetectedLanguage,
      structuralFallbackFiles: files.filter((file) => file.detectedLanguage && !file.language).length
    }
  };
}
