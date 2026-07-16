import { describe, expect, it } from "vitest";
import { emitArchitectureAtlasOperations } from "../src/main/importer/atlas";
import { enforceSemanticTruthOnAtlasOperations } from "../src/main/importer/lensFlows";
import {
  clusterHasDurablePersistenceEvidence,
  graphHasDurablePersistenceEvidence,
  normalizeProjectionSemanticScope,
  normalizeSemanticLensClaim
} from "../src/main/importer/semanticTruth";
import type { ArchitectureLensPlan, GraphProjection, ModuleCluster, ModuleGraph } from "../src/main/importer/types";

function cluster(input: Partial<ModuleCluster> & Pick<ModuleCluster, "id" | "path" | "files">): ModuleCluster {
  return {
    title: input.path,
    unit: "module",
    tier: 1,
    ownedFiles: input.files,
    loc: 20,
    languages: ["typescript"],
    topFiles: input.files.slice(0, 2),
    externalDeps: [],
    docTitles: [],
    symbols: [],
    ...input
  };
}

function projection(input: Partial<GraphProjection> & Pick<GraphProjection, "id" | "clusterIds">): GraphProjection {
  return {
    title: input.id,
    question: "What happens?",
    description: "Evidence-backed perspective.",
    evidenceBasis: ["repository evidence"],
    confidence: "medium",
    edgePairs: [],
    ...input
  };
}

describe("importer semantic truth contracts", () => {
  it("distinguishes transient application stores from durable persistence sinks", () => {
    const pinia = cluster({
      id: "cluster-state",
      path: "src/stores/session.ts",
      files: ["src/stores/session.ts"],
      externalDeps: ["pinia"],
      symbols: ["useSessionStore"]
    });
    const sqlite = cluster({
      id: "cluster-db",
      path: "src/storage/sqlite.ts",
      files: ["src/storage/sqlite.ts"],
      externalDeps: ["sqlite"],
      symbols: ["saveOrder"]
    });
    expect(clusterHasDurablePersistenceEvidence(pinia)).toBe(false);
    expect(clusterHasDurablePersistenceEvidence(sqlite)).toBe(true);
    expect(graphHasDurablePersistenceEvidence({ levels: "1", granularity: "system", entrypoints: [], clusters: [pinia], edges: [] })).toBe(false);
  });

  it("renames a data perspective when only runtime state is evidenced", () => {
    const state = cluster({ id: "cluster-state", path: "src/stores/session.ts", files: ["src/stores/session.ts"], externalDeps: ["pinia"] });
    const raw = projection({ id: "data", title: "Data Ownership & Persistence", clusterIds: [state.id] });
    const normalized = normalizeProjectionSemanticScope(raw, { levels: "1", granularity: "system", entrypoints: [], clusters: [state], edges: [], projections: [raw] });
    expect(normalized.title).toBe("Data Ownership & Runtime State");
    expect(normalized.description).toContain("No durable persistence sink was observed");
  });

  it("retains completed-effect wording when a matching implementation operation is observed", () => {
    const orders = cluster({ id: "cluster-orders", path: "src/orders.ts", files: ["src/orders.ts"], symbols: ["submitOrder"] });
    const journey = projection({
      id: "user-journey",
      clusterIds: [orders.id],
      behavioralContracts: [{ file: "src/orders.ts", line: 20, text: "Submit the confirmed order.", title: "Submit order", terms: ["submit", "confirmed", "order"], sequence: 20, evidenceMode: "declared" }]
    });
    const claim = normalizeSemanticLensClaim({
      lensId: "user-journey",
      projection: journey,
      title: "Order Submitted",
      description: "The confirmed order is submitted by the application.",
      type: "outcome",
      sourcePaths: ["src/orders.ts"],
      anchorClusters: [orders]
    });
    expect(claim.status).toBe("implemented-effect");
    expect(claim.title).toBe("Order Submitted");
    expect(claim.corrections).toEqual([]);
  });

  it("requires the effect verb and affected concept in the same implementation evidence unit", () => {
    const mixed = cluster({
      id: "cluster-mixed",
      path: "src/actions.ts",
      files: ["src/actions.ts"],
      symbols: ["submitPayment", "orderSummary"]
    });
    const journey = projection({ id: "user-journey", clusterIds: [mixed.id] });
    const claim = normalizeSemanticLensClaim({
      lensId: "user-journey",
      projection: journey,
      title: "Order Submitted",
      description: "The order is submitted by the application.",
      type: "outcome",
      sourcePaths: ["src/actions.ts"],
      anchorClusters: [mixed]
    });
    expect(claim.status).toBe("evidence-bounded");
    expect(claim.title).not.toMatch(/submitted/i);
    expect(claim.corrections).toHaveLength(1);
  });

  it("does not treat its own semantic boundary as a new unsupported claim", () => {
    const state = cluster({ id: "cluster-state", path: "src/state.ts", files: ["src/state.ts"], symbols: ["useSessionState"] });
    const data = projection({ id: "data", clusterIds: [state.id] });
    const first = normalizeSemanticLensClaim({
      lensId: "data",
      projection: data,
      title: "Microphone Sensitivity Setting",
      description: "Persists the microphone sensitivity for the active session.",
      type: "data-state",
      sourcePaths: ["src/state.ts"],
      anchorClusters: [state]
    });
    const second = normalizeSemanticLensClaim({
      lensId: "data",
      projection: data,
      title: first.title,
      description: first.description,
      type: "data-state",
      sourcePaths: ["src/state.ts"],
      anchorClusters: [state]
    });
    expect(first.corrections).toHaveLength(1);
    expect(second.title).toBe(first.title);
    expect(second.description).toBe(first.description);
    expect(second.corrections).toEqual([]);
  });

  it("does not let an unrelated database validate a completed product outcome", () => {
    const service = cluster({
      id: "cluster-service",
      path: "src/service.ts",
      files: ["src/service.ts"],
      externalDeps: ["@prisma/client"],
      symbols: ["saveOrder"]
    });
    const journey = projection({
      id: "user-journey",
      clusterIds: [service.id],
      behavioralContracts: [{
        file: "src/service.ts",
        line: 30,
        text: "Tell the guest that payment is completed.",
        title: "Complete payment",
        terms: ["guest", "payment", "completed"],
        sequence: 30,
        evidenceMode: "declared"
      }]
    });
    const payment = normalizeSemanticLensClaim({
      lensId: "user-journey",
      projection: journey,
      title: "Payment Completed",
      description: "The guest's payment is completed.",
      type: "outcome",
      sourcePaths: ["src/service.ts"],
      anchorClusters: [service]
    });
    const welcome = normalizeSemanticLensClaim({
      lensId: "functional",
      projection: projection({ id: "functional", clusterIds: [service.id] }),
      title: "Personalized Welcome",
      description: "Greets the guest by name.",
      type: "capability",
      sourcePaths: ["src/service.ts"],
      anchorClusters: [service]
    });
    expect(payment.status).toBe("prompt-defined");
    expect(payment.corrections).toHaveLength(1);
    expect(payment.title).not.toMatch(/completed/i);
    expect(payment.description).toContain("does not prove durable persistence or completion");
    expect(welcome.status).toBe("evidence-bounded");
  });

  it("reframes prompt-only menu, order, and rating claims without losing the useful flows", () => {
    const server = cluster({ id: "cluster-server", path: "server.ts", files: ["server.ts"], symbols: ["createSession"] });
    const state = cluster({ id: "cluster-state", path: "src/stores/session.ts", files: ["src/stores/session.ts"], externalDeps: ["pinia"], symbols: ["useSessionStore"] });
    const contracts: NonNullable<GraphProjection["behavioralContracts"]> = [
      { file: "server.ts", line: 24, text: "Before starting the conversation, create a fictional seafood menu.", title: "Create a fictional seafood menu", terms: ["create", "fictional", "seafood", "menu"], sequence: 24, kind: "constraint", evidenceMode: "declared" },
      { file: "server.ts", line: 70, text: "Ask the user for a rating and feedback before saying goodbye.", title: "Ask for a rating and feedback", terms: ["ask", "rating", "feedback", "goodbye"], sequence: 70, kind: "journey-step", evidenceMode: "declared" }
    ];
    const data = projection({
      id: "data",
      title: "Data Ownership & Persistence",
      clusterIds: [server.id, state.id],
      edgePairs: [{ source: server.id, target: state.id }],
      behavioralContracts: contracts
    });
    const journey = projection({
      id: "user-journey",
      title: "User Journeys & UX",
      clusterIds: [server.id, state.id],
      edgePairs: [{ source: server.id, target: state.id }],
      behavioralContracts: contracts
    });
    const graph: ModuleGraph = {
      levels: "1",
      granularity: "system",
      entrypoints: ["server.ts"],
      clusters: [server, state],
      edges: [{ source: server.id, target: state.id, importCount: 1, sampleImports: [], relationKinds: ["calls"] }],
      projections: [data, journey],
      behavioralContracts: contracts
    };
    const lensPlans: ArchitectureLensPlan[] = [{
      id: "data",
      nodes: [
        { id: "menu", title: "Restaurant Menu", type: "data-entity", description: "The complete list of dishes and prices embedded in the system prompt.", evidenceMembers: ["server.ts"] },
        { id: "transcript", title: "Conversation Transcript", type: "data-store", description: "Stores the active transcript for the current session.", evidenceMembers: ["src/stores/session.ts"] },
        { id: "mic", title: "Microphone Sensitivity Setting", type: "data-state", description: "Controls audio input filtering for the current session.", evidenceMembers: ["src/stores/session.ts"] }
      ],
      edges: [
        { source: "menu", target: "transcript", label: "informs the active conversation" },
        { source: "transcript", target: "mic", label: "persists" }
      ]
    }, {
      id: "user-journey",
      nodes: [
        { id: "guest", title: "Restaurant Guest", type: "actor", description: "Participates in the conversation.", evidenceMembers: [], contextOnly: true },
        { id: "conversation", title: "Order Conversation", type: "journey-step", description: "Discusses and confirms an order.", evidenceMembers: ["server.ts"] },
        { id: "outcome", title: "Order Finalized and Rating Registered", type: "outcome", description: "The order is complete and the rating has been logged.", evidenceMembers: ["server.ts"] }
      ],
      edges: [
        { source: "guest", target: "conversation", label: "starts the order conversation" },
        { source: "conversation", target: "outcome", label: "ends by requesting feedback" }
      ]
    }];
    const atlas = emitArchitectureAtlasOperations({
      baseFlowId: "flow-main",
      moduleGraph: graph,
      annotations: null,
      projectName: "Waiterly",
      codebaseHints: ["TypeScript"],
      checkedAt: "2026-07-14T00:00:00.000Z",
      lensPlans,
      expectLensPlans: true
    });
    const hardened = enforceSemanticTruthOnAtlasOperations(atlas.operations, graph);
    const dataFlow = hardened.find((operation) => operation.kind === "create-flow" && operation.flow.perspective?.kind === "data-persistence");
    const journeyFlow = hardened.find((operation) => operation.kind === "create-flow" && operation.flow.perspective?.kind === "user-journeys");
    expect(dataFlow?.kind === "create-flow" ? dataFlow.flow.name : "").toBe("Data Ownership & Runtime State");
    const dataNodes = dataFlow?.kind === "create-flow" ? dataFlow.flow.nodes : [];
    expect(dataNodes.find((node) => node.title === "Restaurant Menu")?.description).toContain("create a fictional seafood menu");
    expect(dataNodes.find((node) => node.title === "Conversation Transcript")?.type).toBe("data-state");
    expect(dataNodes.find((node) => node.title === "Conversation Transcript")?.visual.shape).toBe("rounded");
    expect(dataNodes.find((node) => node.title === "Conversation Transcript")?.description).toBe("Stores the active transcript for the current session.");
    const dataEdges = dataFlow?.kind === "create-flow" ? dataFlow.flow.edges : [];
    expect(dataEdges.find((edge) => edge.target.includes("mic"))?.label).toBe("updates transient in-memory state");
    const outcome = journeyFlow?.kind === "create-flow" ? journeyFlow.flow.nodes.find((node) => node.id.includes("outcome")) : undefined;
    expect(outcome?.title).not.toMatch(/finalized|registered/i);
    expect(outcome?.description).toContain("does not prove durable persistence or completion");

    // Simulate a provider review patch reintroducing both false persistence and
    // completed-effect wording; post-review enforcement must remove both and be
    // stable when applied again.
    const providerReviewed = structuredClone(hardened);
    const reviewedData = providerReviewed.find((operation) => operation.kind === "create-flow" && operation.flow.perspective?.kind === "data-persistence");
    if (reviewedData?.kind === "create-flow") {
      const micEdge = reviewedData.flow.edges.find((edge) => edge.target.includes("mic"));
      if (micEdge) micEdge.label = "persists";
    }
    const reviewedJourney = providerReviewed.find((operation) => operation.kind === "create-flow" && operation.flow.perspective?.kind === "user-journeys");
    if (reviewedJourney?.kind === "create-flow") {
      const reviewedOutcome = reviewedJourney.flow.nodes.find((node) => node.id.includes("outcome"));
      if (reviewedOutcome) {
        reviewedOutcome.title = "Order Finalized and Rating Registered";
        reviewedOutcome.description = "The order is finalized and the rating is registered.";
      }
    }
    const rehardened = enforceSemanticTruthOnAtlasOperations(providerReviewed, graph);
    const rehardenedData = rehardened.find((operation) => operation.kind === "create-flow" && operation.flow.perspective?.kind === "data-persistence");
    const rehardenedJourney = rehardened.find((operation) => operation.kind === "create-flow" && operation.flow.perspective?.kind === "user-journeys");
    expect(rehardenedData?.kind === "create-flow" ? rehardenedData.flow.edges.find((edge) => edge.target.includes("mic"))?.label : "").toBe("updates transient in-memory state");
    expect(rehardenedJourney?.kind === "create-flow" ? rehardenedJourney.flow.nodes.find((node) => node.id.includes("outcome"))?.title : "").not.toMatch(/finalized|registered/i);
    expect(enforceSemanticTruthOnAtlasOperations(rehardened, graph)).toEqual(rehardened);
  });

  it("keeps declared prompt bullets as coverage evidence when healthy capabilities already cover them", () => {
    const app = cluster({ id: "cluster-app", path: "src/app.ts", files: ["src/app.ts"], symbols: ["startConversation"] });
    const contracts: NonNullable<GraphProjection["behavioralContracts"]> = [
      { file: "src/app.ts", line: 10, text: "Ask for the guest's name and wait for a reply.", title: "Ask for the guest name", terms: ["ask", "guest", "name", "reply"], sequence: 10, evidenceMode: "declared" },
      { file: "src/app.ts", line: 11, text: "Show the menu and recommend dishes.", title: "Show the menu", terms: ["show", "menu", "recommend", "dishes"], sequence: 11, evidenceMode: "declared" },
      { file: "src/app.ts", line: 12, text: "Tell the guest the order total when confirming.", title: "Tell the order total", terms: ["guest", "order", "total", "confirming"], sequence: 12, evidenceMode: "declared" }
    ];
    const functional = projection({ id: "functional", title: "Product Capabilities", clusterIds: [app.id], behavioralContracts: contracts });
    const graph: ModuleGraph = { levels: "1", granularity: "system", entrypoints: ["src/app.ts"], clusters: [app], edges: [], projections: [functional], behavioralContracts: contracts };
    const atlas = emitArchitectureAtlasOperations({
      baseFlowId: "flow-main",
      moduleGraph: graph,
      annotations: null,
      projectName: "Demo",
      codebaseHints: [],
      checkedAt: "2026-07-14T00:00:00.000Z",
      expectLensPlans: true,
      lensPlans: [{
        id: "functional",
        nodes: [
          { id: "welcome", title: "Personalized Welcome", type: "capability", description: "Greets the guest and asks for their name.", evidenceMembers: ["src/app.ts"] },
          { id: "menu", title: "Menu Discovery", type: "capability", description: "Shows the menu and recommends dishes.", evidenceMembers: ["src/app.ts"] },
          { id: "order", title: "Order Confirmation", type: "capability", description: "Confirms the order and tells the guest the total.", evidenceMembers: ["src/app.ts"] }
        ],
        edges: [
          { source: "welcome", target: "menu", label: "leads into menu discovery" },
          { source: "menu", target: "order", label: "supports order confirmation" }
        ]
      }]
    });
    const flow = atlas.operations.find((operation) => operation.kind === "create-flow" && operation.flow.perspective?.kind === "product-capabilities");
    const capabilityNodes = flow?.kind === "create-flow" ? flow.flow.nodes.filter((node) => node.id !== "node-project") : [];
    expect(capabilityNodes).toHaveLength(3);
    expect(capabilityNodes.every((node) => !node.id.includes("observed-contract"))).toBe(true);
  });

  it("does not treat generic stopwords as coverage for a missing declared capability", () => {
    const app = cluster({ id: "cluster-app", path: "src/app.ts", files: ["src/app.ts"], symbols: ["startConversation"] });
    const contracts: NonNullable<GraphProjection["behavioralContracts"]> = [{
      file: "src/app.ts",
      line: 20,
      text: "Collect a payment card and calculate the checkout total.",
      title: "Collect payment",
      terms: ["collect", "payment", "card", "calculate", "checkout", "total"],
      sequence: 20,
      evidenceMode: "declared"
    }];
    const functional = projection({ id: "functional", title: "Product Capabilities", clusterIds: [app.id], behavioralContracts: contracts });
    const graph: ModuleGraph = { levels: "1", granularity: "system", entrypoints: ["src/app.ts"], clusters: [app], edges: [], projections: [functional], behavioralContracts: contracts };
    const atlas = emitArchitectureAtlasOperations({
      baseFlowId: "flow-main",
      moduleGraph: graph,
      annotations: null,
      projectName: "Demo",
      codebaseHints: [],
      checkedAt: "2026-07-14T00:00:00.000Z",
      expectLensPlans: true,
      lensPlans: [{
        id: "functional",
        nodes: [
          { id: "welcome", title: "Welcome", type: "capability", description: "This capability greets a visitor.", evidenceMembers: ["src/app.ts"] },
          { id: "browse", title: "Browse", type: "capability", description: "This capability presents choices.", evidenceMembers: ["src/app.ts"] },
          { id: "help", title: "Help", type: "capability", description: "This capability answers questions.", evidenceMembers: ["src/app.ts"] }
        ],
        edges: [
          { source: "welcome", target: "browse", label: "leads into browsing" },
          { source: "browse", target: "help", label: "offers contextual help" }
        ]
      }]
    });
    const flow = atlas.operations.find((operation) => operation.kind === "create-flow" && operation.flow.perspective?.kind === "product-capabilities");
    const capabilityNodes = flow?.kind === "create-flow" ? flow.flow.nodes.filter((node) => node.id !== "node-project") : [];
    expect(capabilityNodes.some((node) => node.id.includes("observed-contract"))).toBe(true);
  });
});
