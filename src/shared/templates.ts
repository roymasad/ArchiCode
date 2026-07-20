import type { ArchicodeNode, Flow, Project, RunTargetProfile } from "./schema";
import { createSeedProject } from "./fixtures";

export type ProjectTemplateId = "blank" | "website" | "flutter-calculator" | "c4-todo-app";

export type ProjectTemplate = {
  id: ProjectTemplateId;
  name: string;
  description: string;
};

export const projectTemplates: ProjectTemplate[] = [
  {
    id: "blank",
    name: "Blank",
    description: "Empty starter with one editable project goal node."
  },
  {
    id: "website",
    name: "Website",
    description: "Small Vue/Vite website starter with product, architecture, landing, and about page nodes."
  },
  {
    id: "flutter-calculator",
    name: "Flutter Calculator App",
    description: "Flutter starter for a polished calculator with UI, arithmetic logic, and verification nodes."
  },
  {
    id: "c4-todo-app",
    name: "C4 Todo App",
    description: "Nested C4-style starter for a React, Express, SQLite, and Prisma todo application."
  }
];

export function createWebRunTargetProfile(runCommand = "npm run dev"): RunTargetProfile {
  return {
    id: "web-local-browser",
    label: "Local Browser",
    kind: "web",
    cwd: "",
    description: "Start the local web dev server and treat localhost output as the ready target.",
    inferred: true,
    targetRequired: false,
    diagnosticCommands: [],
    recoveryCommands: [],
    retryAfterRecovery: true,
    runCommand,
    readyPattern: "localhost|127\\.0\\.0\\.1|Local:",
    timeoutSeconds: 120
  };
}

export const flutterRunTargetProfiles: RunTargetProfile[] = [
  {
    id: "flutter-android-emulator",
    label: "Android Emulator",
    kind: "flutter",
    cwd: "",
    description: "Discover Flutter Android emulators, launch one if needed, wait for device attachment, then run on it.",
    discoverCommand: "flutter emulators",
    targetPattern: "^\\s*(?<id>\\S+)\\s+\\u2022\\s+(?<label>[^\\u2022]+)\\s+\\u2022\\s+[^\\u2022]+\\s+\\u2022\\s+android\\s*$",
    targetPreferencePattern: "pixel|phone",
    targetRequired: true,
    launchCommand: "flutter emulators --launch {targetId}",
    targetStopCommand: "adb -s {runTargetId} emu kill",
    waitCommand: "flutter devices --device-timeout 5",
    readyPattern: "\\u2022\\s+emulator-\\d+\\s+\\u2022\\s+android",
    notReadyPattern: "is offline|No supported devices connected|No devices found yet",
    readyTargetPattern: "^.*?\\u2022\\s*(?<id>emulator-\\d+)\\s*\\u2022\\s*android",
    diagnosticCommands: [
      "adb devices",
      "flutter devices",
      "flutter emulators"
    ],
    recoveryCommands: [
      "adb kill-server",
      "adb start-server"
    ],
    retryAfterRecovery: true,
    runCommand: "flutter run -d {runTargetId}",
    timeoutSeconds: 120
  },
  {
    id: "flutter-ios-simulator",
    label: "iOS Simulator",
    kind: "flutter",
    cwd: "",
    description: "Launch the iOS simulator target and run the Flutter app on it.",
    discoverCommand: "flutter emulators",
    targetPattern: "^\\s*(?<id>\\S+)\\s+\\u2022\\s+(?<label>[^\\u2022]+)\\s+\\u2022\\s+[^\\u2022]+\\s+\\u2022\\s+ios\\s*$",
    defaultTargetId: "apple_ios_simulator",
    targetRequired: true,
    launchCommand: "flutter emulators --launch {targetId}",
    targetStopCommand: "xcrun simctl shutdown {runTargetId}",
    waitCommand: "flutter devices --device-timeout 5",
    readyPattern: "\\bios\\b|iOS Simulator",
    notReadyPattern: "No supported devices connected|No devices found yet",
    readyTargetPattern: "^.*?\\u2022\\s*(?<id>[^\\u2022]+?)\\s*\\u2022\\s*ios\\b",
    diagnosticCommands: [
      "flutter devices",
      "flutter emulators"
    ],
    recoveryCommands: [],
    retryAfterRecovery: true,
    runCommand: "flutter run -d {runTargetId}",
    timeoutSeconds: 120
  }
];

export function createProjectFromTemplate(rootPath: string, templateId: ProjectTemplateId): { project: Project; flow: Flow } {
  const seed = createSeedProject(rootPath, { includeProviderTemplates: false });
  const now = new Date().toISOString();
  const baseProject: Project = {
    ...seed.project,
    id: `project-${templateId}`,
    name: templateId === "flutter-calculator"
      ? "New Flutter Calculator"
      : templateId === "website"
        ? "New Website"
        : templateId === "c4-todo-app"
          ? "New C4 Todo App"
          : "New Blank Project",
    description: templateId === "flutter-calculator"
      ? "A visual architecture workspace for a Flutter calculator app."
      : templateId === "website"
        ? "A visual architecture workspace for a small website."
        : templateId === "c4-todo-app"
          ? "A nested C4-style workspace for a full-stack todo app."
          : "A blank visual architecture workspace.",
    rootPath,
    createdAt: now,
    updatedAt: now
  };

  if (templateId === "blank") {
    const blankProject: Project = {
      ...baseProject,
      settings: {
        ...baseProject.settings,
        defaultBuildCommand: "",
        defaultRunCommand: "",
        runTargetProfiles: [],
        stackAssumptions: []
      }
    };
    const projectNode = node(
      "node-project",
      "project",
      "Project Goal",
      "Describe what you want to build. Add nodes for features, components, tasks, settings, artifacts, and notes as the project takes shape.",
      "planned",
      80,
      120
    );
    projectNode.acceptanceCriteria = [
      "Project goal is defined",
      "Next implementation nodes are added as needed"
    ];
    return {
      project: blankProject,
      flow: makeFlow("flow-main", "Blank Plan", "A blank flow for starting from scratch.", [
        projectNode
      ], [])
    };
  }

  if (templateId === "website") {
    const websiteProject: Project = {
      ...baseProject,
      settings: {
        ...baseProject.settings,
        defaultBuildCommand: "npm run build",
        defaultRunCommand: "npm run dev",
        runTargetProfiles: [createWebRunTargetProfile("npm run dev")],
        stackAssumptions: ["Vue 3", "Vite", "Vue Router", "TypeScript", "Static website"]
      }
    };
    const productNode = node(
      "node-project",
      "project",
      "Product Goal",
      "Create a simple two-page marketing website for a small product or service. The site should have a landing page at / with a clear hero, value proposition, call to action, and short feature/benefit sections, plus an About page at /about that explains the purpose, audience, and credibility story. Keep the first version static and client-rendered unless the user asks for backend/data work.",
      "planned",
      80,
      120
    );
    const architectureNode = node(
      "node-architecture",
      "setting",
      "Vue/Vite Architecture",
      "Use Vue 3 with Vite as the frontend stack. Prefer a small component structure under src with route-level views for Landing and About, shared layout/navigation components, scoped or global CSS that is responsive, and package scripts for dev/build/preview. Do not add backend services, authentication, databases, or heavy state management for this starter unless the user explicitly asks.",
      "planned",
      380,
      120
    );
    const landingNode = node(
      "node-landing-page",
      "feature",
      "Landing Page",
      "Build the home route as the primary sales/intro page. Include a strong headline, supporting copy, one primary action, a concise benefits section, and a polished responsive layout that works on mobile and desktop. Use realistic placeholder content that the user can later edit, not lorem ipsum.",
      "planned",
      680,
      120
    );
    const aboutNode = node(
      "node-about-page",
      "task",
      "About Page",
      "Build an /about route linked from the site navigation. Explain who the site is for, why the product or service exists, and what makes it trustworthy. Reuse the same visual system as the landing page, include a clear page heading, and keep the content concise enough for a first production-ready draft.",
      "planned",
      380,
      360
    );
    productNode.techStack = ["Vue 3", "Vite", "Static website"];
    productNode.acceptanceCriteria = [
      "Website has a landing page at / and an about page at /about",
      "Navigation lets users move between the two pages",
      "The first version is static and easy to edit"
    ];
    architectureNode.techStack = ["Vue 3", "Vite", "Vue Router", "CSS"];
    architectureNode.acceptanceCriteria = [
      "Project uses Vite with Vue 3",
      "Routes are organized as landing and about views",
      "No backend or database is introduced for the starter"
    ];
    landingNode.techStack = ["Vue single-file components", "Responsive CSS"];
    landingNode.acceptanceCriteria = [
      "Landing page has hero, value proposition, CTA, and benefit sections",
      "Layout is responsive across mobile and desktop",
      "Copy is concrete enough for the LLM to scaffold without extra questions"
    ];
    aboutNode.techStack = ["Vue Router", "Shared layout"];
    aboutNode.acceptanceCriteria = [
      "About page is reachable at /about",
      "Navigation links landing and about pages",
      "Visual style matches the landing page"
    ];
    return {
      project: websiteProject,
      flow: makeFlow("flow-main", "Website Plan", "A compact first flow for shaping a new website.", [
        productNode,
        architectureNode,
        landingNode,
        aboutNode
      ], [
        { id: "edge-goal-architecture", source: "node-project", target: "node-architecture", label: "constrains" },
        { id: "edge-architecture-landing", source: "node-architecture", target: "node-landing-page", label: "guides" },
        { id: "edge-landing-about", source: "node-landing-page", target: "node-about-page", label: "shares nav/style" }
      ])
    };
  }

  if (templateId === "flutter-calculator") {
    const flutterProject: Project = {
      ...baseProject,
      settings: {
        ...baseProject.settings,
        defaultBuildCommand: "flutter build apk",
        defaultRunCommand: "flutter run",
        runTargetProfiles: flutterRunTargetProfiles,
        stackAssumptions: ["Flutter", "Dart", "Material", "Widget tests"]
      }
    };
    const productNode = node(
      "node-project",
      "project",
      "Calculator Goal",
      "Create a small Flutter calculator app with a clean keypad, readable display, and reliable arithmetic behavior. The first version should support addition, subtraction, multiplication, division, clear, decimal entry, sign changes, and repeated calculations without crashes.",
      "planned",
      80,
      120
    );
    const architectureNode = node(
      "node-flutter-architecture",
      "setting",
      "Flutter Architecture",
      "Use a simple Flutter app structure with a MaterialApp entry point, a calculator screen widget, isolated calculation/state logic, and tests around expression behavior. Keep dependencies minimal unless a package is clearly useful.",
      "planned",
      380,
      120
    );
    const uiNode = node(
      "node-calculator-ui",
      "feature",
      "Calculator UI",
      "Build a polished calculator interface with a display area, digit buttons, operator buttons, clear/delete controls, decimal input, and responsive spacing that works on common phone sizes and desktop preview.",
      "planned",
      680,
      120
    );
    const logicNode = node(
      "node-calculator-logic",
      "component",
      "Calculation Logic",
      "Implement calculator state transitions and arithmetic safely, including chained operations, divide-by-zero handling, decimal precision display, clear/reset behavior, and sign toggling.",
      "planned",
      380,
      360
    );
    const qualityNode = node(
      "node-quality",
      "task",
      "Verification",
      "Add widget or unit tests for core calculator behavior and document the commands to run, build, and test the Flutter app.",
      "planned",
      680,
      360
    );
    productNode.techStack = ["Flutter", "Dart", "Material"];
    productNode.acceptanceCriteria = [
      "App opens to a calculator screen",
      "Users can perform basic arithmetic operations",
      "The display remains readable and does not overflow on common phone sizes"
    ];
    architectureNode.techStack = ["Flutter", "Dart", "MaterialApp", "Widget tests"];
    architectureNode.acceptanceCriteria = [
      "Calculator UI and logic are organized in small, understandable files",
      "Business logic can be tested without relying only on manual tapping",
      "No unnecessary backend, network, or database dependencies are introduced"
    ];
    uiNode.techStack = ["Flutter widgets", "Material styling", "Responsive layout"];
    uiNode.acceptanceCriteria = [
      "Buttons are easy to tap and visually grouped by function",
      "Display supports long values without breaking the layout",
      "Light/dark system rendering remains legible"
    ];
    logicNode.techStack = ["Dart", "Unit tests"];
    logicNode.acceptanceCriteria = [
      "Addition, subtraction, multiplication, and division work",
      "Divide by zero is handled gracefully",
      "Clear, decimal, sign toggle, and repeated equals behavior are predictable"
    ];
    qualityNode.techStack = ["flutter test", "flutter build apk", "flutter run"];
    qualityNode.acceptanceCriteria = [
      "Core calculator behavior has automated tests",
      "The app can be launched with flutter run",
      "A build command is documented and runnable when Flutter tooling is available"
    ];
    return {
      project: flutterProject,
      flow: makeFlow("flow-main", "Flutter Calculator Plan", "Starter flow for a small Flutter calculator app.", [
        productNode,
        architectureNode,
        uiNode,
        logicNode,
        qualityNode
      ], [
        { id: "edge-goal-architecture", source: "node-project", target: "node-flutter-architecture", label: "constrains" },
        { id: "edge-architecture-ui", source: "node-flutter-architecture", target: "node-calculator-ui", label: "guides" },
        { id: "edge-architecture-logic", source: "node-flutter-architecture", target: "node-calculator-logic", label: "guides" },
        { id: "edge-logic-ui", source: "node-calculator-logic", target: "node-calculator-ui", label: "drives" },
        { id: "edge-ui-quality", source: "node-calculator-ui", target: "node-quality", label: "verifies" },
        { id: "edge-logic-quality", source: "node-calculator-logic", target: "node-quality", label: "verifies" }
      ])
    };
  }

  if (templateId === "c4-todo-app") {
    const todoProject: Project = {
      ...baseProject,
      settings: {
        ...baseProject.settings,
        defaultBuildCommand: "npm run build",
        defaultRunCommand: "npm run dev",
        runTargetProfiles: [createWebRunTargetProfile("npm run dev")],
        stackAssumptions: ["React", "Vite", "TypeScript", "Express", "SQLite", "Prisma"]
      }
    };

    const personNode = node("node-person-user", "project", "Todo User", "A person who wants a fast, reliable place to capture, review, complete, and clean up personal todo items from a browser.", "planned", 80, 120);
    const systemNode = node("node-system-todo", "project", "Todo App System", "A small full-stack todo application that lets users manage tasks with persistent local data. The first release is single-user, runs locally, and keeps the architecture simple enough to extend later.", "planned", 390, 120);
    const externalNode = node("node-external-browser", "setting", "Web Browser", "The user accesses the app through a modern browser. No native app, auth provider, or third-party integration is required for the first version.", "planned", 710, 120);

    personNode.techStack = ["Browser user"];
    personNode.acceptanceCriteria = [
      "User can create, edit, complete, reopen, filter, and delete todos",
      "User can understand app state without reading technical details"
    ];
    systemNode.techStack = ["React", "Express", "SQLite", "Prisma", "TypeScript"];
    systemNode.acceptanceCriteria = [
      "App runs locally with a documented dev command",
      "Todos persist in SQLite across page refreshes",
      "Frontend and API boundaries are clear enough for future features"
    ];
    externalNode.techStack = ["HTML", "CSS", "HTTP"];
    externalNode.acceptanceCriteria = [
      "App works in a current desktop browser",
      "UI remains responsive on common mobile widths"
    ];

    const webContainerNode = node("node-container-web", "component", "React Web App", "Vite-powered React frontend responsible for the todo UI, local interaction state, API calls, filtering controls, and accessible feedback.", "planned", 80, 120);
    const apiContainerNode = node("node-container-api", "component", "Express API", "Node/Express backend that exposes todo endpoints, validates input, coordinates persistence, and returns predictable JSON responses.", "planned", 390, 120);
    const dbContainerNode = node("node-container-db", "artifact", "SQLite Database", "Local SQLite database storing todos with stable ids, title, completion status, timestamps, and optional notes or priority fields if needed later.", "planned", 710, 120);
    const qualityContainerNode = node("node-container-quality", "task", "Verification", "Automated and manual verification for the C4 starter: frontend behavior, API contract, database persistence, and build/run commands.", "planned", 390, 360);

    webContainerNode.subflowId = "subflow-containers";
    webContainerNode.techStack = ["React", "Vite", "TypeScript", "CSS"];
    webContainerNode.acceptanceCriteria = [
      "UI renders todo list, create form, filters, and edit/delete controls",
      "API loading and error states are visible without clutter",
      "Keyboard and screen-reader basics are respected"
    ];
    apiContainerNode.subflowId = "subflow-containers";
    apiContainerNode.techStack = ["Node.js", "Express", "TypeScript", "Zod"];
    apiContainerNode.acceptanceCriteria = [
      "API exposes CRUD operations for todos",
      "Input validation rejects empty titles and invalid ids",
      "Errors return useful status codes and compact JSON"
    ];
    dbContainerNode.subflowId = "subflow-containers";
    dbContainerNode.techStack = ["SQLite", "Prisma"];
    dbContainerNode.acceptanceCriteria = [
      "Todo records persist in a SQLite file",
      "Schema supports title, completed state, and timestamps",
      "Database setup is documented and repeatable"
    ];
    qualityContainerNode.subflowId = "subflow-containers";
    qualityContainerNode.techStack = ["Vitest", "Testing Library", "Supertest", "Prisma migrations"];
    qualityContainerNode.acceptanceCriteria = [
      "Build command validates TypeScript and production output",
      "API behavior has tests around create/update/delete/list",
      "Frontend has tests for core todo interactions"
    ];

    const appShellNode = node("node-component-app-shell", "component", "App Shell", "Top-level React composition for layout, heading, status messaging, and wiring todo data into presentational components.", "planned", 80, 120);
    const todoListNode = node("node-component-todo-list", "feature", "Todo List UI", "Displays active/completed todos, empty states, completion toggles, edit/delete actions, and readable timestamps or metadata when useful.", "planned", 390, 120);
    const todoFormNode = node("node-component-todo-form", "feature", "Todo Form", "Accessible create/edit form with validation feedback, submit state, and small interactions that keep repeated entry fast.", "planned", 710, 120);
    const apiClientNode = node("node-component-api-client", "component", "API Client", "Small typed client for calling the Express todo endpoints, normalizing errors, and keeping fetch details out of UI components.", "planned", 390, 360);

    for (const item of [appShellNode, todoListNode, todoFormNode, apiClientNode]) item.subflowId = "subflow-web-components";
    appShellNode.techStack = ["React", "TypeScript"];
    todoListNode.techStack = ["React components", "Accessible buttons"];
    todoFormNode.techStack = ["React forms", "Client validation"];
    apiClientNode.techStack = ["fetch", "TypeScript DTOs"];
    appShellNode.acceptanceCriteria = ["App has a clear title and main landmark", "Loading, empty, and error states are handled"];
    todoListNode.acceptanceCriteria = ["Todos can be completed/reopened", "Completed and active states are visually distinct", "Delete action requires deliberate interaction"];
    todoFormNode.acceptanceCriteria = ["Empty todo titles are rejected", "Editing does not lose existing todo text", "Submitting gives immediate feedback"];
    apiClientNode.acceptanceCriteria = ["All API responses are typed", "Network/API errors become user-friendly messages"];

    const routesNode = node("node-component-routes", "component", "Todo Routes", "Express route handlers for listing, creating, updating, completing, reopening, and deleting todos.", "planned", 80, 120);
    const serviceNode = node("node-component-service", "component", "Todo Service", "Application logic layer that validates transitions, trims titles, applies defaults, and keeps route handlers thin.", "planned", 390, 120);
    const repositoryNode = node("node-component-repository", "component", "Todo Repository", "Persistence adapter around Prisma so API logic does not depend directly on database query details.", "planned", 710, 120);
    const schemaNode = node("node-component-schema", "setting", "Validation Schema", "Shared server-side validation for todo payloads and route params, with clear error messages for invalid input.", "planned", 390, 360);

    for (const item of [routesNode, serviceNode, repositoryNode, schemaNode]) item.subflowId = "subflow-api-components";
    routesNode.techStack = ["Express Router", "Supertest"];
    serviceNode.techStack = ["TypeScript", "Domain logic"];
    repositoryNode.techStack = ["Prisma Client", "SQLite"];
    schemaNode.techStack = ["Zod"];
    routesNode.acceptanceCriteria = ["Routes map cleanly to todo operations", "Handlers return compact JSON", "Unexpected errors do not leak stack traces"];
    serviceNode.acceptanceCriteria = ["Titles are normalized", "Completion updates are idempotent", "Missing todos return not found"];
    repositoryNode.acceptanceCriteria = ["Repository supports list/create/update/delete", "Database calls are isolated behind typed functions"];
    schemaNode.acceptanceCriteria = ["Invalid ids and empty titles are rejected", "Validation errors are testable"];

    const flow = makeFlow("flow-main", "C4 Todo App Plan", "Nested C4-style flow for a React, Express, SQLite, and Prisma todo app.", [
      personNode,
      systemNode,
      externalNode,
      webContainerNode,
      apiContainerNode,
      dbContainerNode,
      qualityContainerNode,
      appShellNode,
      todoListNode,
      todoFormNode,
      apiClientNode,
      routesNode,
      serviceNode,
      repositoryNode,
      schemaNode
    ], [
      { id: "edge-user-system", source: "node-person-user", target: "node-system-todo", label: "uses" },
      { id: "edge-browser-system", source: "node-external-browser", target: "node-system-todo", label: "hosts UI" },
      { id: "edge-web-api", source: "node-container-web", target: "node-container-api", label: "calls JSON API" },
      { id: "edge-api-db", source: "node-container-api", target: "node-container-db", label: "reads/writes" },
      { id: "edge-quality-web", source: "node-container-quality", target: "node-container-web", label: "verifies" },
      { id: "edge-quality-api", source: "node-container-quality", target: "node-container-api", label: "verifies" },
      { id: "edge-shell-list", source: "node-component-app-shell", target: "node-component-todo-list", label: "renders" },
      { id: "edge-shell-form", source: "node-component-app-shell", target: "node-component-todo-form", label: "renders" },
      { id: "edge-ui-client", source: "node-component-todo-list", target: "node-component-api-client", label: "uses" },
      { id: "edge-form-client", source: "node-component-todo-form", target: "node-component-api-client", label: "uses" },
      { id: "edge-routes-service", source: "node-component-routes", target: "node-component-service", label: "delegates" },
      { id: "edge-service-repo", source: "node-component-service", target: "node-component-repository", label: "persists" },
      { id: "edge-routes-schema", source: "node-component-routes", target: "node-component-schema", label: "validates" }
    ]);
    flow.subflows = [
      { id: "subflow-containers", name: "Container View", ignored: false, parentNodeId: "node-system-todo" },
      { id: "subflow-web-components", name: "React Components", ignored: false, parentNodeId: "node-container-web", parentSubflowId: "subflow-containers" },
      { id: "subflow-api-components", name: "API Components", ignored: false, parentNodeId: "node-container-api", parentSubflowId: "subflow-containers" }
    ];
    return { project: todoProject, flow };
  }

  throw new Error(`Unknown project template: ${templateId}`);
}

function makeFlow(id: string, name: string, description: string, nodes: ArchicodeNode[], edges: Flow["edges"]): Flow {
  return {
    id,
    name,
    description,
    ignored: false,
    nodes,
    edges,
    subflows: [],
    groups: [],
    updatedAt: new Date().toISOString()
  };
}

function node(
  id: string,
  type: ArchicodeNode["type"],
  title: string,
  description: string,
  stage: ArchicodeNode["stage"],
  x: number,
  y: number
): ArchicodeNode {
  return {
    id,
    type,
    title,
    description,
    stage,
    ignored: false,
    flags: ["changed"],
    locked: false,
    visual: {},
    position: { x, y },
    customProperties: {},
    techStack: [],
    acceptanceCriteria: [],
    acceptanceChecks: [],
    attachments: [],
    todos: [],
    updatedAt: new Date().toISOString()
  };
}
