import { createI18n, translate, type TranslationValues } from "../shared/i18n/createI18n";
import type { SupportedLocale } from "../shared/i18n/locale";

const mainI18n = createI18n();

export function tMain(key: string, options?: TranslationValues): string {
  return translate(mainI18n, key, options);
}

export async function setMainLocale(locale: SupportedLocale): Promise<void> {
  await mainI18n.changeLanguage(locale);
}

export function mainLocale(): SupportedLocale {
  return mainI18n.language as SupportedLocale;
}

/**
 * Keep ArchiCode's tuned control prompts and machine contracts in English,
 * while making every model aware of the language expected for visible prose.
 */
export function llmOutputLanguageDirective(locale: SupportedLocale = mainLocale()): string {
  const language = new Intl.DisplayNames(["en"], { type: "language" }).of(locale) ?? locale;
  return [
    "ARCHICODE OUTPUT LANGUAGE:",
    `The ArchiCode application UI is currently set to ${language} (${locale}).`,
    `Unless the user explicitly requests another response language, write user-visible conversational prose, explanations, plans, questions, and report summaries in ${language}.`,
    "Keep ArchiCode's system instructions and control contracts in English.",
    "Never translate JSON keys, schema or property names, enum literals, tool or function names, code, commands, paths, identifiers, IDs, URLs, quoted text, or existing project content.",
    "Do not rename or translate project content solely because of the UI language; when generating new project content, follow the user's request and the project's established language.",
    "Structured outputs must remain syntactically valid. Translate only natural-language string values intended for the user when doing so cannot change their machine meaning."
  ].join(" ");
}
