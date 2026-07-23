import { afterEach, describe, expect, it } from "vitest";
import { rendererI18n } from "../src/renderer/src/i18n";
import {
  localizeChangeSetResultDetails,
  localizeChangeSetResultNarrative
} from "../src/renderer/src/utils/researchResultLocalization";
import { changeSetResultReportPresentation } from "../src/shared/researchResultPresentation";

afterEach(async () => {
  await rendererI18n.changeLanguage("en");
});

describe("deterministic research review report localization", () => {
  it("localizes a rejected graph-review fallback at display time", async () => {
    await rendererI18n.changeLanguage("fr");

    const report = changeSetResultReportPresentation([
      'Graph review complete for "Révision ciblée".',
      "0 applied, 1 rejected, 0 failed.",
      "Outcome: Not applied by your selection: Update node Vue/Vite Architecture. I kept this exact review outcome and did not generate another proposal.",
      "Rejected: Update node Vue/Vite Architecture. (Rejected or left unapplied by the user.)",
      "No automatic retry was created. Ask explicitly for a retry or a new proposal if you want to change the remaining operations."
    ].join("\n\n"));
    const localized = localizeChangeSetResultNarrative(report?.narrative ?? "");

    expect(localized).toBe(
      "Non appliqué selon votre sélection : Mettre à jour le nœud Vue/Vite Architecture. J’ai conservé ce résultat de révision exact et n’ai pas généré d’autre proposition."
    );
  });

  it("localizes the complete no-retry footer", async () => {
    await rendererI18n.changeLanguage("fr");

    const localized = localizeChangeSetResultDetails(
      "Rejected: Update node Vue/Vite Architecture. (Rejected or left unapplied by the user.)\n\nNo automatic retry was created. Ask explicitly for a retry or a new proposal if you want to change the remaining operations."
    );

    expect(localized).toContain(
      "Rejeté: Mettre à jour le nœud Vue/Vite Architecture. (Rejeté ou non appliqué par l’utilisateur.)"
    );
    expect(localized).toContain(
      "Aucune nouvelle tentative automatique n’a été créée. Demandez explicitement une nouvelle tentative ou une nouvelle proposition si vous souhaitez modifier les opérations restantes."
    );
  });

  it("leaves ordinary assistant prose untouched", async () => {
    await rendererI18n.changeLanguage("fr");
    expect(localizeChangeSetResultNarrative("A normal model-authored response."))
      .toBe("A normal model-authored response.");
  });
});
