export const supportedLocales = ["en", "fr", "es", "pt", "zh-Hans", "ja"] as const;

export type SupportedLocale = (typeof supportedLocales)[number];
export type LocalePreference = "system" | SupportedLocale;

export type LocaleState = {
  preference: LocalePreference;
  resolvedLocale: SupportedLocale;
};

export function isLocalePreference(value: unknown): value is LocalePreference {
  return value === "system" || supportedLocales.includes(value as SupportedLocale);
}

export function resolveSupportedLocale(languages: readonly string[]): SupportedLocale {
  for (const language of languages) {
    const normalized = language.trim().toLowerCase();
    if (
      normalized === "zh"
      || normalized === "zh-cn"
      || normalized === "zh-sg"
      || normalized === "zh-hans"
      || normalized.startsWith("zh-hans-")
    ) {
      return "zh-Hans";
    }
    const exact = supportedLocales.find((locale) => locale.toLowerCase() === normalized);
    if (exact) return exact;
    const base = normalized.split("-")[0];
    const baseMatch = supportedLocales.find((locale) => locale === base);
    if (baseMatch) return baseMatch;
  }
  return "en";
}

export function localeDirection(locale: SupportedLocale): "ltr" | "rtl" {
  return /^(ar|fa|he|ur)(-|$)/i.test(locale) ? "rtl" : "ltr";
}
