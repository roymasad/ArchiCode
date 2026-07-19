export type ResearchTurnKind = "user" | "goal-continuation" | "outcome-finalization" | "approval-resume";

export type ResearchTurnPolicy = {
  kind: ResearchTurnKind;
  includeExternalRetrieval: boolean;
  includeProjectContext: boolean;
  includeConversationHistory: boolean;
  includeSelectedSkills: boolean;
  enforceExplicitDelphiDelegation: boolean;
};

const RESEARCH_TURN_POLICIES: Record<ResearchTurnKind, ResearchTurnPolicy> = {
  user: {
    kind: "user",
    includeExternalRetrieval: true,
    includeProjectContext: true,
    includeConversationHistory: true,
    includeSelectedSkills: true,
    enforceExplicitDelphiDelegation: true
  },
  "goal-continuation": {
    kind: "goal-continuation",
    includeExternalRetrieval: true,
    includeProjectContext: true,
    includeConversationHistory: true,
    includeSelectedSkills: true,
    enforceExplicitDelphiDelegation: false
  },
  "outcome-finalization": {
    kind: "outcome-finalization",
    includeExternalRetrieval: false,
    includeProjectContext: true,
    includeConversationHistory: true,
    includeSelectedSkills: false,
    enforceExplicitDelphiDelegation: false
  },
  "approval-resume": {
    kind: "approval-resume",
    includeExternalRetrieval: true,
    includeProjectContext: true,
    includeConversationHistory: true,
    includeSelectedSkills: true,
    enforceExplicitDelphiDelegation: false
  }
};

export function deriveResearchTurnKind(input: {
  internalContinuation?: boolean;
  outcomeEvidenceProvided?: boolean;
  approvalResume?: boolean;
}): ResearchTurnKind {
  if (input.outcomeEvidenceProvided) return "outcome-finalization";
  if (input.approvalResume) return "approval-resume";
  if (input.internalContinuation) return "goal-continuation";
  return "user";
}

export function researchTurnPolicy(kind: ResearchTurnKind): ResearchTurnPolicy {
  return RESEARCH_TURN_POLICIES[kind];
}
