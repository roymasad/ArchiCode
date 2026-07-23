import { describe, expect, it } from "vitest";
import english from "../src/shared/i18n/locales/en.json";
import french from "../src/shared/i18n/locales/fr.json";
import { createI18n, translate } from "../src/shared/i18n/createI18n";
import { isLocalePreference, localeDirection, resolveSupportedLocale } from "../src/shared/i18n/locale";

describe("application localization", () => {
  it("resolves supported system languages and falls back to English", () => {
    expect(resolveSupportedLocale(["en-LB", "ar-LB"])).toBe("en");
    expect(resolveSupportedLocale(["fr-FR", "en-US"])).toBe("fr");
    expect(resolveSupportedLocale(["de-DE", "es-ES"])).toBe("en");
  });

  it("validates persisted locale preferences", () => {
    expect(isLocalePreference("system")).toBe(true);
    expect(isLocalePreference("en")).toBe(true);
    expect(isLocalePreference("fr")).toBe(true);
    expect(isLocalePreference("de")).toBe(false);
    expect(localeDirection("en")).toBe("ltr");
    expect(localeDirection("fr")).toBe("ltr");
  });

  it("loads English synchronously and interpolates values", () => {
    const instance = createI18n("en");
    expect(translate(instance, "app.language")).toBe("Language");
    expect(translate(instance, "app.languageResolved", { language: "English" })).toBe("Currently using English.");
  });

  it("loads French synchronously and preserves interpolation", () => {
    const instance = createI18n("fr");
    expect(translate(instance, "Project Settings")).toBe("Paramètres du projet");
    expect(translate(instance, "app.languageResolved", { language: "Français" })).toBe("Langue actuellement utilisée : Français.");
    expect(translate(instance, "Run completed")).toBe("Exécution terminée");
    expect(translate(instance, "Implementation history")).toBe("Historique de l’implémentation");
    expect(translate(instance, "Create node \"{{name}}\" on root flow", { name: "En-tête" }))
      .toBe("Créer le nœud \"En-tête\" sur le flux racine");
    expect(translate(instance, "research.reviewSummaryApplied", { applied: 2, rejected: 1, failed: 0 }))
      .toBe("2 appliquées, 1 rejetées, 0 échouées");
    expect(translate(instance, "run.implementation.batchUsed", {
      count: 1,
      tasks: translate(instance, "run.implementation.tasksDone", { done: 2, total: 2 })
    })).toBe("1 lot utilisé · 2/2 tâches terminées");
  });

  it("keeps complete, matching, non-empty catalogs", () => {
    expect(Object.keys(english).length).toBeGreaterThan(2_000);
    expect(Object.values(english).every((value) => typeof value === "string" && value.length > 0)).toBe(true);
    expect(Object.keys(french)).toEqual(Object.keys(english));
    expect(Object.values(french).every((value) => typeof value === "string" && value.length > 0)).toBe(true);
  });
});
