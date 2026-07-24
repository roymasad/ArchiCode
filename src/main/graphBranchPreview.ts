import type { Flow } from "../shared/schema";
import { flowSchema } from "../shared/schema";
import {
  buildGraphBranchPreviewDiff,
  type GraphBranchPreview
} from "../shared/graphBranchPreview";
import { tMain } from "./i18n";
import { runGit } from "./projectTools";
import { flowFromDisk } from "./storage/persistence";

const MAX_GRAPH_PREVIEW_FLOWS = 200;

async function requireCommit(projectRoot: string, revision: string): Promise<string> {
  const candidate = revision.trim();
  if (!candidate) throw new Error(tMain("Choose both branches before previewing graph changes."));
  const result = await runGit(projectRoot, ["rev-parse", "--verify", "--end-of-options", `${candidate}^{commit}`]);
  if (!result.ok) throw new Error(tMain("Git branch or revision “{{candidate}}” is not available.", { candidate }));
  return result.stdout.trim();
}

async function showFile(projectRoot: string, commit: string, relativePath: string): Promise<string | null> {
  const result = await runGit(projectRoot, ["show", `${commit}:${relativePath}`]);
  return result.ok ? result.stdout : null;
}

async function readGraphFlows(projectRoot: string, commit: string): Promise<Flow[]> {
  const tree = await runGit(projectRoot, ["ls-tree", "-r", "--name-only", commit, "--", ".archicode/flows"]);
  if (!tree.ok) return [];
  const paths = tree.stdout
    .split(/\r?\n/)
    .map((item) => item.trim())
    .filter((item) => item.endsWith(".json"));
  if (paths.length > MAX_GRAPH_PREVIEW_FLOWS) {
    throw new Error(tMain("This graph contains more than {{maxFlows}} flows and is too large to preview safely.", {
      maxFlows: MAX_GRAPH_PREVIEW_FLOWS
    }));
  }
  const snapshots = await Promise.all(paths.map(async (filePath) => {
    const text = await showFile(projectRoot, commit, filePath);
    if (!text) throw new Error(tMain("Unable to read committed graph flow {{filePath}}.", { filePath }));
    try {
      const parsed = flowSchema.safeParse(flowFromDisk(JSON.parse(text)));
      if (!parsed.success) throw new Error(parsed.error.issues[0]?.message ?? "invalid graph data");
      return parsed.data;
    } catch {
      throw new Error(tMain("Committed graph flow {{filePath}} is not valid ArchiCode data.", { filePath }));
    }
  }));
  return snapshots;
}

export async function previewGraphBranches(
  projectRoot: string,
  baseRef: string,
  candidateRef: string
): Promise<GraphBranchPreview> {
  const [baseCommit, candidateCommit] = await Promise.all([
    requireCommit(projectRoot, baseRef),
    requireCommit(projectRoot, candidateRef)
  ]);
  if (baseCommit === candidateCommit) {
    const flows = await readGraphFlows(projectRoot, candidateCommit);
    return {
      baseRef,
      candidateRef,
      baseCommit,
      candidateCommit,
      comparisonCommit: baseCommit,
      ...buildGraphBranchPreviewDiff(flows, flows)
    };
  }
  const mergeBase = await runGit(projectRoot, ["merge-base", baseCommit, candidateCommit]);
  if (!mergeBase.ok || !mergeBase.stdout.trim()) {
    throw new Error(tMain("These branches do not share a Git ancestor, so a PR-style graph preview is unavailable."));
  }
  const comparisonCommit = mergeBase.stdout.trim().split(/\r?\n/)[0];
  const [beforeFlows, afterFlows] = await Promise.all([
    readGraphFlows(projectRoot, comparisonCommit),
    readGraphFlows(projectRoot, candidateCommit)
  ]);
  return {
    baseRef,
    candidateRef,
    baseCommit,
    candidateCommit,
    comparisonCommit,
    ...buildGraphBranchPreviewDiff(beforeFlows, afterFlows)
  };
}
