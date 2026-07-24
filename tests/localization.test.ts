import { describe, expect, it } from "vitest";
import english from "../src/shared/i18n/locales/en.json";
import french from "../src/shared/i18n/locales/fr.json";
import japanese from "../src/shared/i18n/locales/ja.json";
import portuguese from "../src/shared/i18n/locales/pt.json";
import simplifiedChinese from "../src/shared/i18n/locales/zh-Hans.json";
import spanish from "../src/shared/i18n/locales/es.json";
import { createI18n, translate } from "../src/shared/i18n/createI18n";
import { isLocalePreference, localeDirection, resolveSupportedLocale } from "../src/shared/i18n/locale";

describe("application localization", () => {
  it("resolves supported system languages and falls back to English", () => {
    expect(resolveSupportedLocale(["en-LB", "ar-LB"])).toBe("en");
    expect(resolveSupportedLocale(["fr-FR", "en-US"])).toBe("fr");
    expect(resolveSupportedLocale(["es-ES", "en-US"])).toBe("es");
    expect(resolveSupportedLocale(["pt-BR", "en-US"])).toBe("pt");
    expect(resolveSupportedLocale(["zh-Hans-CN", "en-US"])).toBe("zh-Hans");
    expect(resolveSupportedLocale(["zh-CN", "en-US"])).toBe("zh-Hans");
    expect(resolveSupportedLocale(["zh-TW", "en-US"])).toBe("en");
    expect(resolveSupportedLocale(["ja-JP", "en-US"])).toBe("ja");
    expect(resolveSupportedLocale(["de-DE", "it-IT"])).toBe("en");
  });

  it("validates persisted locale preferences", () => {
    expect(isLocalePreference("system")).toBe(true);
    expect(isLocalePreference("en")).toBe(true);
    expect(isLocalePreference("fr")).toBe(true);
    expect(isLocalePreference("es")).toBe(true);
    expect(isLocalePreference("pt")).toBe(true);
    expect(isLocalePreference("zh-Hans")).toBe(true);
    expect(isLocalePreference("ja")).toBe(true);
    expect(isLocalePreference("de")).toBe(false);
    expect(localeDirection("en")).toBe("ltr");
    expect(localeDirection("fr")).toBe("ltr");
    expect(localeDirection("es")).toBe("ltr");
    expect(localeDirection("pt")).toBe("ltr");
    expect(localeDirection("zh-Hans")).toBe("ltr");
    expect(localeDirection("ja")).toBe("ltr");
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

  it("loads Spanish synchronously and preserves interpolation", () => {
    const instance = createI18n("es");
    expect(translate(instance, "Project Settings")).toBe("Configuración del proyecto");
    expect(translate(instance, "app.languageResolved", { language: "Español" })).toBe("Actualmente se utiliza Español.");
    expect(translate(instance, "Run completed")).toBe("Ejecución completada");
    expect(translate(instance, "Create node \"{{name}}\" on root flow", { name: "Encabezado" }))
      .toBe("Crear nodo \"Encabezado\" en el flujo raíz");
  });

  it("loads Portuguese synchronously and preserves interpolation", () => {
    const instance = createI18n("pt");
    expect(translate(instance, "Project Settings")).toBe("Configurações do projeto");
    expect(translate(instance, "app.languageResolved", { language: "Português" })).toBe("Atualmente usando Português.");
    expect(translate(instance, "Run completed")).toBe("Execução concluída");
    expect(translate(instance, "Create node \"{{name}}\" on root flow", { name: "Cabeçalho" }))
      .toBe("Criar nó \"Cabeçalho\" no fluxo raiz");
  });

  it("loads Simplified Chinese synchronously and preserves interpolation", () => {
    const instance = createI18n("zh-Hans");
    expect(translate(instance, "Project Settings")).toBe("项目设置");
    expect(translate(instance, "app.languageResolved", { language: "简体中文" })).toBe("当前使用简体中文。");
    expect(translate(instance, "Run completed")).toBe("运行完成");
    expect(translate(instance, "Create node \"{{name}}\" on root flow", { name: "页眉" }))
      .toBe("在根流程中创建节点“页眉”");
  });

  it("loads Japanese synchronously and preserves interpolation", () => {
    const instance = createI18n("ja");
    expect(translate(instance, "Project Settings")).toBe("プロジェクト設定");
    expect(translate(instance, "app.languageResolved", { language: "日本語" })).toBe("現在は日本語を使用しています。");
    expect(translate(instance, "Run completed")).toBe("実行完了");
    expect(translate(instance, "Create node \"{{name}}\" on root flow", { name: "ヘッダー" }))
      .toBe("ルートフローにノード「ヘッダー」を作成");
  });

  it("localizes the branch graph preview and its change details", () => {
    const cases = [
      { locale: "fr", title: "Aperçu des modifications du graphe", candidate: "Branche candidate", position: "Position", count: "3 supprimés" },
      { locale: "es", title: "Vista previa de cambios del grafo", candidate: "Rama candidata", position: "Posición", count: "3 eliminados" },
      { locale: "pt", title: "Pré-visualização de alterações do grafo", candidate: "Ramificação candidata", position: "Posição", count: "3 removidos" },
      { locale: "zh-Hans", title: "图谱变更预览", candidate: "候选分支", position: "位置", count: "移除 3 项" },
      { locale: "ja", title: "グラフ変更プレビュー", candidate: "候補ブランチ", position: "位置", count: "削除 3 件" }
    ] as const;

    for (const item of cases) {
      const instance = createI18n(item.locale);
      expect(translate(instance, "Graph change preview")).toBe(item.title);
      expect(translate(instance, "Candidate branch")).toBe(item.candidate);
      expect(translate(instance, "Position")).toBe(item.position);
      expect(translate(instance, "{{count}} removed", { count: 3 })).toBe(item.count);
    }
  });

  it("localizes the curator's casual greeting", () => {
    expect(translate(createI18n("en"), "Hi! I’m Archi. How should I brief you?")).toBe("Hi! I’m Archi. How should I brief you?");
    expect(translate(createI18n("fr"), "Hi! I’m Archi. How should I brief you?")).toContain("Archi");
    expect(translate(createI18n("es"), "Hi! I’m Archi. How should I brief you?")).toContain("Archi");
    expect(translate(createI18n("pt"), "Hi! I’m Archi. How should I brief you?")).toContain("Archi");
    expect(translate(createI18n("zh-Hans"), "Hi! I’m Archi. How should I brief you?")).toContain("Archi");
    expect(translate(createI18n("ja"), "Hi! I’m Archi. How should I brief you?")).toContain("Archi");
  });

  it("keeps complete, matching, non-empty catalogs", () => {
    expect(Object.keys(english).length).toBeGreaterThan(2_000);
    expect(Object.values(english).every((value) => typeof value === "string" && value.length > 0)).toBe(true);
    expect(Object.keys(french)).toEqual(Object.keys(english));
    expect(Object.values(french).every((value) => typeof value === "string" && value.length > 0)).toBe(true);
    expect(Object.keys(spanish)).toEqual(Object.keys(english));
    expect(Object.values(spanish).every((value) => typeof value === "string" && value.length > 0)).toBe(true);
    expect(Object.keys(portuguese)).toEqual(Object.keys(english));
    expect(Object.values(portuguese).every((value) => typeof value === "string" && value.length > 0)).toBe(true);
    expect(Object.keys(simplifiedChinese)).toEqual(Object.keys(english));
    expect(Object.values(simplifiedChinese).every((value) => typeof value === "string" && value.length > 0)).toBe(true);
    expect(Object.keys(japanese)).toEqual(Object.keys(english));
    expect(Object.values(japanese).every((value) => typeof value === "string" && value.length > 0)).toBe(true);
  });
});
