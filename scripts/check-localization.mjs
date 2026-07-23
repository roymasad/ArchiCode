import fs from "node:fs";
import path from "node:path";
import ts from "typescript";

const root = path.resolve(import.meta.dirname, "..");
const rendererRoot = path.join(root, "src/renderer/src");
const localesRoot = path.join(root, "src/shared/i18n/locales");
const catalogs = Object.fromEntries(
  fs.readdirSync(localesRoot)
    .filter((file) => file.endsWith(".json"))
    .map((file) => [path.basename(file, ".json"), JSON.parse(fs.readFileSync(path.join(localesRoot, file), "utf8"))])
);
const catalog = catalogs.en;
const failures = [];
const configFile = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
const parsedConfig = ts.parseJsonConfigFileContent(configFile.config, ts.sys, root);
const program = ts.createProgram(parsedConfig.fileNames, parsedConfig.options);
const checker = program.getTypeChecker();
const localizedAttributes = new Set([
  "alt", "aria-label", "ariaLabel", "content", "description", "detailsDescription",
  "detailsTitle", "emptyLabel", "help", "hint", "label", "message", "placeholder", "title", "tooltip"
]);

function filesUnder(directory) {
  return fs.readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const target = path.join(directory, entry.name);
    if (entry.isDirectory()) return filesUnder(target);
    return /\.(?:ts|tsx)$/.test(entry.name) ? [target] : [];
  });
}

function lineOf(sourceFile, position) {
  return sourceFile.getLineAndCharacterOfPosition(position).line + 1;
}

function hasUnsafeInterpolationType(type) {
  if (type.isUnion()) return type.types.some(hasUnsafeInterpolationType);
  return Boolean(type.flags & (ts.TypeFlags.Object | ts.TypeFlags.Any | ts.TypeFlags.Unknown));
}

for (const file of filesUnder(rendererRoot)) {
  const sourceFile = program.getSourceFile(file);
  if (!sourceFile) {
    failures.push(`${path.relative(root, file)} could not be loaded for localization analysis`);
    continue;
  }
  function visit(node) {
    if (ts.isJsxText(node) && /[A-Za-z]/.test(node.text)) {
      failures.push(`${path.relative(root, file)}:${lineOf(sourceFile, node.getStart())} has hardcoded JSX text ${JSON.stringify(node.text.trim())}`);
    }
    if (ts.isJsxAttribute(node) && localizedAttributes.has(node.name.text) && node.initializer && ts.isStringLiteral(node.initializer)) {
      const value = node.initializer.text.trim();
      const technicalValue = /^https?:\/\//.test(value) || /^[a-z0-9_.:/-]+$/i.test(value);
      if (/[A-Za-z]/.test(value) && !technicalValue) {
        failures.push(`${path.relative(root, file)}:${lineOf(sourceFile, node.getStart())} has hardcoded ${node.name.text} text ${JSON.stringify(value)}`);
      }
    }
    if (ts.isCallExpression(node) && ts.isIdentifier(node.expression) && node.expression.text === "t" && node.arguments[0] && ts.isStringLiteral(node.arguments[0])) {
      const key = node.arguments[0].text;
      if (!(key in catalog)) failures.push(`${path.relative(root, file)}:${lineOf(sourceFile, node.getStart())} uses missing English key ${JSON.stringify(key)}`);
      const options = node.arguments[1];
      if (options && ts.isObjectLiteralExpression(options)) {
        for (const property of options.properties) {
          if (!ts.isPropertyAssignment(property)) continue;
          const valueType = checker.getTypeAtLocation(property.initializer);
          if (hasUnsafeInterpolationType(valueType)) {
            failures.push(
              `${path.relative(root, file)}:${lineOf(sourceFile, property.getStart())} passes ${checker.typeToString(valueType)} to translation interpolation; render React values outside t()`
            );
          }
        }
      }
    }
    ts.forEachChild(node, visit);
  }
  visit(sourceFile);
}

const placeholders = (value) => [...value.matchAll(/\{\{\s*([\w.-]+)\s*\}\}/g)].map((match) => match[1]).sort();
for (const [key, value] of Object.entries(catalog)) {
  if (typeof value !== "string" || !value.trim()) failures.push(`English catalog key ${JSON.stringify(key)} has an empty or non-string value`);
  const semanticKey = /^[a-z][\w.-]+$/.test(key);
  if (!semanticKey && JSON.stringify(placeholders(key)) !== JSON.stringify(placeholders(String(value)))) {
    failures.push(`English catalog key ${JSON.stringify(key)} does not preserve its interpolation variables`);
  }
}

for (const [locale, localizedCatalog] of Object.entries(catalogs)) {
  const englishKeys = Object.keys(catalog);
  const localizedKeys = Object.keys(localizedCatalog);
  if (JSON.stringify(localizedKeys) !== JSON.stringify(englishKeys)) {
    failures.push(`${locale}.json keys do not exactly match en.json`);
    continue;
  }
  for (const key of englishKeys) {
    const value = localizedCatalog[key];
    if (typeof value !== "string" || !value.trim()) {
      failures.push(`${locale}.json key ${JSON.stringify(key)} has an empty or non-string value`);
      continue;
    }
    if (JSON.stringify(placeholders(catalog[key])) !== JSON.stringify(placeholders(value))) {
      failures.push(`${locale}.json key ${JSON.stringify(key)} does not preserve its interpolation variables`);
    }
  }
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exitCode = 1;
} else {
  console.log(`Localization check passed (${Object.keys(catalog).length} entries across ${Object.keys(catalogs).length} locales).`);
}
