import i18next, { type i18n, type TOptions } from "i18next";
import english from "./locales/en.json";
import french from "./locales/fr.json";
import { supportedLocales, type SupportedLocale } from "./locale";

export type TranslationValues = TOptions & Record<string, unknown>;

export function createI18n(locale: SupportedLocale = "en", configure?: (instance: i18n) => void): i18n {
  const instance = i18next.createInstance();
  configure?.(instance);
  void instance.init({
    lng: locale,
    fallbackLng: "en",
    supportedLngs: supportedLocales,
    resources: {
      en: { translation: english },
      fr: { translation: french }
    },
    interpolation: { escapeValue: false },
    initAsync: false,
    returnNull: false
  });
  return instance;
}

export function translate(instance: i18n, key: string, options?: TranslationValues): string {
  return instance.t(key, options) as string;
}
