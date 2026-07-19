import { registerMicroRunAgent } from "../microRuns";
import { mergeResolutionAgent } from "./mergeResolution";
import { testAuthoringAgent } from "./testAuthoring";
import { sherlockResearchAgent } from "./sherlockResearch";
import { picassoGraphAgent } from "./picassoGraph";
import { delphiTestingAgent } from "./delphiTesting";

export {
  mergeResolutionAgent,
  picassoGraphAgent as graphReconciliationAgent,
  testAuthoringAgent,
  sherlockResearchAgent,
  picassoGraphAgent,
  delphiTestingAgent
};

export function registerAllMicroRunAgents(): void {
  registerMicroRunAgent(mergeResolutionAgent);
  registerMicroRunAgent(picassoGraphAgent);
  registerMicroRunAgent(testAuthoringAgent);
  registerMicroRunAgent(sherlockResearchAgent);
  registerMicroRunAgent(delphiTestingAgent);
}
