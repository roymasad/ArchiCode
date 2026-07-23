import { initReactI18next } from "react-i18next";
import { createI18n, translate, type TranslationValues } from "@shared/i18n/createI18n";
import { localeDirection, resolveSupportedLocale, type LocaleState, type SupportedLocale } from "@shared/i18n/locale";

const storedLocale = typeof localStorage === "undefined" ? null : localStorage.getItem("archicode-resolved-locale");
const initialLocale: SupportedLocale = storedLocale ? resolveSupportedLocale([storedLocale]) : "en";

export const rendererI18n = createI18n(initialLocale, (instance) => {
  instance.use(initReactI18next);
});

if (typeof document !== "undefined") {
  document.documentElement.lang = initialLocale;
  document.documentElement.dir = localeDirection(initialLocale);
}

export function t(key: string, options?: TranslationValues): string {
  return translate(rendererI18n, key, options);
}

export async function applyRendererLocale(state: LocaleState): Promise<void> {
  localStorage.setItem("archicode-resolved-locale", state.resolvedLocale);
  // Several option/descriptor tables are translated at module initialization.
  // Reload on an actual locale transition so those values are rebuilt too.
  if (rendererI18n.language !== state.resolvedLocale) {
    window.location.reload();
    return;
  }
  await rendererI18n.changeLanguage(state.resolvedLocale);
  document.documentElement.lang = state.resolvedLocale;
  document.documentElement.dir = localeDirection(state.resolvedLocale);
}

export function formatNumber(value: number, locale: SupportedLocale = rendererI18n.language as SupportedLocale): string {
  return new Intl.NumberFormat(locale).format(value);
}

export function formatDateTime(
  value: string | number | Date,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium", timeStyle: "short" },
  locale: SupportedLocale = rendererI18n.language as SupportedLocale
): string {
  return new Intl.DateTimeFormat(locale, options).format(new Date(value));
}

export function formatDate(
  value: string | number | Date,
  options: Intl.DateTimeFormatOptions = { dateStyle: "medium" },
  locale: SupportedLocale = rendererI18n.language as SupportedLocale
): string {
  return new Intl.DateTimeFormat(locale, options).format(new Date(value));
}

export function formatTime(
  value: string | number | Date,
  options: Intl.DateTimeFormatOptions = { timeStyle: "medium" },
  locale: SupportedLocale = rendererI18n.language as SupportedLocale
): string {
  return new Intl.DateTimeFormat(locale, options).format(new Date(value));
}
