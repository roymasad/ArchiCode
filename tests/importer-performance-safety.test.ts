import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { buildFileDependencyGraph } from "../src/main/importer/fileGraph";
import { buildContentInventory } from "../src/main/importer/inventory";
import { parseFiles } from "../src/main/importer/parsers";
import { scanRepository } from "../src/main/importer/scanner";
import { createImportSourceReader } from "../src/main/importer/sourceCache";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("importer lossless performance refactors", () => {
  it("keeps parsed facts, inventory, and dependency edges identical with concurrent language parsing and shared reads", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "archicode-import-concurrency-"));
    roots.push(root);
    await Promise.all(["src", "lib", "py"].map((directory) => mkdir(path.join(root, directory), { recursive: true })));
    await Promise.all([
      writeFile(path.join(root, "src", "main.ts"), "import { helper } from './helper';\nexport function main() { return helper(); }\n"),
      writeFile(path.join(root, "src", "helper.ts"), "export function helper() { return 'ok'; }\n"),
      writeFile(path.join(root, "lib", "main.dart"), "import 'store.dart';\nvoid main() { loadStore(); }\n"),
      writeFile(path.join(root, "lib", "store.dart"), "String loadStore() => 'stored';\n"),
      writeFile(path.join(root, "py", "main.py"), "from worker import run\n\ndef main():\n    return run()\n"),
      writeFile(path.join(root, "py", "worker.py"), "def run():\n    return 'done'\n")
    ]);

    const scan = await scanRepository(root);
    const sequential = await parseFiles(root, scan.files, { languageConcurrency: 1 });
    const sequentialInventory = await buildContentInventory(root, scan);
    const sequentialGraph = await buildFileDependencyGraph(root, scan, sequential);

    const sourceReader = createImportSourceReader(root);
    const [concurrent, concurrentInventory] = await Promise.all([
      parseFiles(root, scan.files, { languageConcurrency: 3, sourceReader }),
      buildContentInventory(root, scan, { sourceReader })
    ]);
    const concurrentGraph = await buildFileDependencyGraph(root, scan, concurrent);

    expect(concurrent).toEqual(sequential);
    expect(concurrentInventory).toEqual(sequentialInventory);
    expect(concurrentGraph.edges).toEqual(sequentialGraph.edges);
    expect([...concurrentGraph.externalsByFile]).toEqual([...sequentialGraph.externalsByFile]);
    expect(concurrentGraph.unresolved).toEqual(sequentialGraph.unresolved);
    expect(concurrentGraph.resolutionRate).toBe(sequentialGraph.resolutionRate);
    expect(sourceReader.hits).toBeGreaterThan(0);
    expect(sourceReader.misses).toBe(scan.files.filter((file) => file.language).length);
  });
});
