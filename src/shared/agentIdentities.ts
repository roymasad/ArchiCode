export type ArchicodePrimaryAgentIdentity = {
  id: "gaia" | "pandora";
  name: string;
  title: string;
  functionalLabel: "AI Implement" | "AI Debug";
  role: string;
};

export const gaiaAgent: ArchicodePrimaryAgentIdentity = {
  id: "gaia",
  name: "Gaia",
  title: "Gaia — Build & Implementation",
  functionalLabel: "AI Implement",
  role: "Plans and implements project changes, then carries them through verification."
};

export const pandoraAgent: ArchicodePrimaryAgentIdentity = {
  id: "pandora",
  name: "Pandora",
  title: "Pandora — Debug & Recovery",
  functionalLabel: "AI Debug",
  role: "Investigates failures and incidents, makes focused repairs, and verifies recovery."
};
