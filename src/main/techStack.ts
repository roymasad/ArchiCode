import * as fs from "fs/promises";
import * as path from "path";

export type TechStackLanguage =
  | "javascript"
  | "typescript"
  | "python"
  | "rust"
  | "go"
  | "java"
  | "ruby"
  | "php"
  | "swift"
  | "kotlin"
  | "csharp"
  | "elixir"
  | "dart"
  | "c"
  | "cpp"
  | "scala"
  | "unknown";

export type PackageManager =
  | "npm"
  | "yarn"
  | "pnpm"
  | "bun"
  | "pip"
  | "pipenv"
  | "poetry"
  | "uv"
  | "cargo"
  | "go"
  | "maven"
  | "gradle"
  | "bundler"
  | "composer"
  | "mix"
  | "swift"
  | "nuget"
  | null;

export type BuildTool =
  | "npm"
  | "yarn"
  | "pnpm"
  | "bun"
  | "make"
  | "cargo"
  | "go"
  | "maven"
  | "gradle"
  | "ant"
  | "bazel"
  | "rake"
  | "composer"
  | "mix"
  | "swift"
  | "dotnet"
  | null;

export type TechStack = {
  primaryLanguage: TechStackLanguage;
  languages: TechStackLanguage[];
  packageManager: PackageManager;
  buildTool: BuildTool;
  testFramework: string | null;
  lintTool: string | null;
  typecheckTool: string | null;
  suggestedCommands: {
    typecheck?: string;
    lint?: string;
    test?: string;
    build?: string;
  };
  configFiles: string[];
};

const languageIndicators: Record<string, TechStackLanguage> = {
  "package.json": "javascript",
  "tsconfig.json": "typescript",
  "requirements.txt": "python",
  "pyproject.toml": "python",
  "setup.py": "python",
  "setup.cfg": "python",
  "Cargo.toml": "rust",
  "go.mod": "go",
  "pom.xml": "java",
  "build.gradle": "java",
  "build.gradle.kts": "java",
  "Gemfile": "ruby",
  "composer.json": "php",
  "Package.swift": "swift",
  "build.sbt": "scala",
  "mix.exs": "elixir",
  "pubspec.yaml": "dart",
  "Makefile": "c",
  "CMakeLists.txt": "cpp",
  "*.csproj": "csharp",
  "*.sln": "csharp"
};

const packageManagerIndicators: Record<string, PackageManager> = {
  "package-lock.json": "npm",
  "yarn.lock": "yarn",
  "pnpm-lock.yaml": "pnpm",
  "bun.lockb": "bun",
  "bun.lock": "bun",
  "Pipfile.lock": "pipenv",
  "poetry.lock": "poetry",
  "uv.lock": "uv",
  "Cargo.lock": "cargo",
  "go.sum": "go",
  "Gemfile.lock": "bundler",
  "composer.lock": "composer",
  "mix.lock": "mix"
};

async function fileExists(projectRoot: string, fileName: string): Promise<boolean> {
  try {
    await fs.access(path.join(projectRoot, fileName));
    return true;
  } catch {
    return false;
  }
}

async function readJsonFile<T>(projectRoot: string, fileName: string): Promise<T | null> {
  try {
    const content = await fs.readFile(path.join(projectRoot, fileName), "utf8");
    return JSON.parse(content) as T;
  } catch {
    return null;
  }
}

async function detectLanguages(projectRoot: string): Promise<TechStackLanguage[]> {
  const languages: TechStackLanguage[] = [];
  const seen = new Set<string>();

  for (const [fileName, language] of Object.entries(languageIndicators)) {
    if (fileName.startsWith("*.")) {
      continue;
    }
    if (await fileExists(projectRoot, fileName) && !seen.has(language)) {
      languages.push(language);
      seen.add(language);
    }
  }

  // Check for .csproj and .sln files
  try {
    const entries = await fs.readdir(projectRoot);
    if (entries.some((e) => e.endsWith(".csproj") || e.endsWith(".sln")) && !seen.has("csharp")) {
      languages.push("csharp");
      seen.add("csharp");
    }
  } catch {
    // ignore
  }

  if (languages.length === 0) {
    languages.push("unknown");
  }

  return languages;
}

function detectPackageManager(languages: TechStackLanguage[], configFiles: string[]): PackageManager {
  for (const [fileName, pm] of Object.entries(packageManagerIndicators)) {
    if (configFiles.includes(fileName)) {
      return pm;
    }
  }

  // Fallback based on language
  if (languages.includes("javascript") || languages.includes("typescript")) {
    return "npm";
  }
  if (languages.includes("python")) {
    return "pip";
  }
  if (languages.includes("rust")) {
    return "cargo";
  }
  if (languages.includes("go")) {
    return "go";
  }
  if (languages.includes("java")) {
    return "maven";
  }
  if (languages.includes("ruby")) {
    return "bundler";
  }
  if (languages.includes("php")) {
    return "composer";
  }
  if (languages.includes("elixir")) {
    return "mix";
  }
  if (languages.includes("swift")) {
    return "swift";
  }
  if (languages.includes("csharp")) {
    return "nuget";
  }

  return null;
}

function detectBuildTool(languages: TechStackLanguage[], packageManager: PackageManager): BuildTool {
  if (packageManager === "npm" || packageManager === "yarn" || packageManager === "pnpm" || packageManager === "bun") {
    return packageManager;
  }
  if (packageManager === "cargo") return "cargo";
  if (packageManager === "go") return "go";
  if (packageManager === "maven") return "maven";
  if (packageManager === "gradle") return "gradle";
  if (packageManager === "bundler") return "rake";
  if (packageManager === "composer") return "composer";
  if (packageManager === "mix") return "mix";
  if (packageManager === "swift") return "swift";
  if (packageManager === "nuget") return "dotnet";

  if (languages.includes("python")) return "make";
  if (languages.includes("c") || languages.includes("cpp")) return "make";

  return null;
}

async function inferCommandsFromPackageJson(projectRoot: string): Promise<{ typecheck?: string; lint?: string; test?: string; build?: string }> {
  const pkg = await readJsonFile<{ scripts?: Record<string, string> }>(projectRoot, "package.json");
  if (!pkg?.scripts) return {};

  const scripts = pkg.scripts;
  const commands: { typecheck?: string; lint?: string; test?: string; build?: string } = {};

  // Typecheck
  if (scripts["typecheck"]) commands.typecheck = `npm run typecheck`;
  else if (scripts["type-check"]) commands.typecheck = `npm run type-check`;
  else if (scripts["tsc"]) commands.typecheck = `npm run tsc`;
  else if (scripts["check"]) commands.typecheck = `npm run check`;

  // Lint
  if (scripts["lint"]) commands.lint = `npm run lint`;
  else if (scripts["eslint"]) commands.lint = `npm run eslint`;

  // Test
  if (scripts["test"]) commands.test = `npm test`;
  else if (scripts["jest"]) commands.test = `npm run jest`;
  else if (scripts["vitest"]) commands.test = `npm run vitest`;
  else if (scripts["mocha"]) commands.test = `npm run mocha`;

  // Build
  if (scripts["build"]) commands.build = `npm run build`;

  return commands;
}

async function inferCommandsFromPyproject(projectRoot: string): Promise<{ typecheck?: string; lint?: string; test?: string; build?: string }> {
  const content = await fs.readFile(path.join(projectRoot, "pyproject.toml"), "utf8").catch(() => null);
  if (!content) return {};

  const commands: { typecheck?: string; lint?: string; test?: string; build?: string } = {};

  if (content.includes("mypy") || content.includes("pyright")) {
    commands.typecheck = content.includes("mypy") ? "mypy ." : "pyright";
  }
  if (content.includes("ruff") || content.includes("flake8") || content.includes("pylint")) {
    commands.lint = content.includes("ruff") ? "ruff check ." : content.includes("flake8") ? "flake8" : "pylint .";
  }
  if (content.includes("pytest") || content.includes("unittest")) {
    commands.test = content.includes("pytest") ? "pytest" : "python -m unittest";
  }

  return commands;
}

async function inferCommandsFromCargo(projectRoot: string): Promise<{ typecheck?: string; lint?: string; test?: string; build?: string }> {
  if (await fileExists(projectRoot, "Cargo.toml")) {
    return {
      typecheck: "cargo check",
      lint: "cargo clippy",
      test: "cargo test",
      build: "cargo build"
    };
  }
  return {};
}

async function inferCommandsFromGo(projectRoot: string): Promise<{ typecheck?: string; lint?: string; test?: string; build?: string }> {
  if (await fileExists(projectRoot, "go.mod")) {
    return {
      typecheck: "go build ./...",
      lint: "golangci-lint run",
      test: "go test ./...",
      build: "go build"
    };
  }
  return {};
}

async function inferCommandsFromMaven(projectRoot: string): Promise<{ typecheck?: string; lint?: string; test?: string; build?: string }> {
  if (await fileExists(projectRoot, "pom.xml")) {
    return {
      typecheck: "mvn compile",
      lint: "mvn checkstyle:check",
      test: "mvn test",
      build: "mvn package"
    };
  }
  return {};
}

async function inferCommandsFromGradle(projectRoot: string): Promise<{ typecheck?: string; lint?: string; test?: string; build?: string }> {
  if (await fileExists(projectRoot, "build.gradle") || await fileExists(projectRoot, "build.gradle.kts")) {
    return {
      typecheck: "gradle compileJava",
      lint: "gradle check",
      test: "gradle test",
      build: "gradle build"
    };
  }
  return {};
}

async function detectConfigFiles(projectRoot: string): Promise<string[]> {
  const allIndicators = [...Object.keys(languageIndicators), ...Object.keys(packageManagerIndicators)];
  const found: string[] = [];

  for (const fileName of allIndicators) {
    if (fileName.startsWith("*.")) continue;
    if (await fileExists(projectRoot, fileName)) {
      found.push(fileName);
    }
  }

  // Check for CI/CD configs
  const ciConfigs = [
    ".github/workflows",
    ".gitlab-ci.yml",
    ".circleci/config.yml",
    "Jenkinsfile",
    ".travis.yml"
  ];

  for (const ciConfig of ciConfigs) {
    if (await fileExists(projectRoot, ciConfig)) {
      found.push(ciConfig);
    }
  }

  return found;
}

export async function detectTechStack(projectRoot: string): Promise<TechStack> {
  const configFiles = await detectConfigFiles(projectRoot);
  const languages = await detectLanguages(projectRoot);
  const packageManager = detectPackageManager(languages, configFiles);
  const buildTool = detectBuildTool(languages, packageManager);

  let suggestedCommands: { typecheck?: string; lint?: string; test?: string; build?: string } = {};

  // Infer commands based on detected stack
  if (languages.includes("javascript") || languages.includes("typescript")) {
    suggestedCommands = { ...suggestedCommands, ...await inferCommandsFromPackageJson(projectRoot) };
  }
  if (languages.includes("python") && configFiles.includes("pyproject.toml")) {
    suggestedCommands = { ...suggestedCommands, ...await inferCommandsFromPyproject(projectRoot) };
  }
  if (languages.includes("rust")) {
    suggestedCommands = { ...suggestedCommands, ...await inferCommandsFromCargo(projectRoot) };
  }
  if (languages.includes("go")) {
    suggestedCommands = { ...suggestedCommands, ...await inferCommandsFromGo(projectRoot) };
  }
  if (languages.includes("java") && configFiles.includes("pom.xml")) {
    suggestedCommands = { ...suggestedCommands, ...await inferCommandsFromMaven(projectRoot) };
  }
  if (languages.includes("java") && (configFiles.includes("build.gradle") || configFiles.includes("build.gradle.kts"))) {
    suggestedCommands = { ...suggestedCommands, ...await inferCommandsFromGradle(projectRoot) };
  }

  // Detect test framework
  let testFramework: string | null = null;
  if (await fileExists(projectRoot, "jest.config.js") || await fileExists(projectRoot, "jest.config.ts")) {
    testFramework = "jest";
  } else if (await fileExists(projectRoot, "vitest.config.ts")) {
    testFramework = "vitest";
  } else if (await fileExists(projectRoot, "pytest.ini") || await fileExists(projectRoot, "pyproject.toml")) {
    testFramework = "pytest";
  } else if (configFiles.includes("Cargo.toml")) {
    testFramework = "cargo test";
  } else if (configFiles.includes("go.mod")) {
    testFramework = "go test";
  }

  // Detect lint tool
  let lintTool: string | null = null;
  if (await fileExists(projectRoot, ".eslintrc.js") || await fileExists(projectRoot, ".eslintrc.json") || await fileExists(projectRoot, "eslint.config.js")) {
    lintTool = "eslint";
  } else if (await fileExists(projectRoot, ".prettierrc")) {
    lintTool = "prettier";
  } else if (await fileExists(projectRoot, "ruff.toml") || (await fs.readFile(path.join(projectRoot, "pyproject.toml"), "utf8").catch(() => "")).includes("ruff")) {
    lintTool = "ruff";
  } else if (configFiles.includes("Cargo.toml")) {
    lintTool = "clippy";
  }

  // Detect typecheck tool
  let typecheckTool: string | null = null;
  if (await fileExists(projectRoot, "tsconfig.json")) {
    typecheckTool = "tsc";
  } else if ((await fs.readFile(path.join(projectRoot, "pyproject.toml"), "utf8").catch(() => "")).includes("mypy")) {
    typecheckTool = "mypy";
  } else if ((await fs.readFile(path.join(projectRoot, "pyproject.toml"), "utf8").catch(() => "")).includes("pyright")) {
    typecheckTool = "pyright";
  }

  return {
    primaryLanguage: languages[0] ?? "unknown",
    languages,
    packageManager,
    buildTool,
    testFramework,
    lintTool,
    typecheckTool,
    suggestedCommands,
    configFiles
  };
}
