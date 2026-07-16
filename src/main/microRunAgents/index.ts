import { registerMicroRunAgent } from "../microRuns";
import { mergeResolutionAgent } from "./mergeResolution";
import { testAuthoringAgent } from "./testAuthoring";
import { sherlockResearchAgent } from "./sherlockResearch";
import { picassoGraphAgent } from "./picassoGraph";

export {
  mergeResolutionAgent,
  picassoGraphAgent as graphReconciliationAgent,
  testAuthoringAgent,
  sherlockResearchAgent,
  picassoGraphAgent
};

export function registerAllMicroRunAgents(): void {
  registerMicroRunAgent(mergeResolutionAgent);
  registerMicroRunAgent(picassoGraphAgent);
  registerMicroRunAgent(testAuthoringAgent);
  registerMicroRunAgent(sherlockResearchAgent);
}
