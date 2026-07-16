export type KeyMod = "cmd" | "ctrl" | "shift" | "alt";

export type KeyChord = {
  key: string;
  cmd?: boolean;
  ctrl?: boolean;
  shift?: boolean;
  alt?: boolean;
};

export type ActionId =
  | "canvas.addNode"
  | "canvas.toggleMinimap"
  | "canvas.toggle3d"
  | "canvas.delete"
  | "canvas.copy"
  | "canvas.cut"
  | "canvas.paste"
  | "canvas.duplicate"
  | "canvas.autoLayout"
  | "canvas.undo"
  | "canvas.reload"
  | "project.openPreferences"
  | "project.openHelp"
  | "project.toggleWorkbench"
  | "project.toggleFocusMode"
  | "project.toggleTheme"
  | "project.resetLayout"
  | "project.focusSidebarSearch"
  | "project.toggleRuntimePanel"
  | "project.toggleChat"
  | "project.openProperties"
  | "project.openGitPanel"
  | "project.openPatchReview"
  | "activity.toggle"
  | "activity.tabRuns"
  | "activity.tabTrace"
  | "activity.tabErrors"
  | "activity.tabPlans"
  | "activity.tabDiffs"
  | "activity.tabGit"
  | "activity.tabQuestions"
  | "activity.tabArtifacts"
  | "run.approve"
  | "run.reject"
  | "run.retry"
  | "chat.send"
  | "chat.newline"
  | "chat.newResearchChat";

export type ActionGroup =
  | "Canvas"
  | "Project"
  | "Activity"
  | "Run"
  | "Chat";

export type ActionMeta = {
  id: ActionId;
  group: ActionGroup;
  label: string;
  description: string;
  scope: "canvas" | "app" | "sidebar" | "runs" | "composer";
  reserved?: boolean;
};

const MODIFIER_ALIAS: Record<string, KeyMod> = {
  control: "ctrl",
  ctrl: "ctrl",
  meta: "cmd",
  cmd: "cmd",
  command: "cmd",
  shift: "shift",
  alt: "alt",
  option: "alt"
};

const IS_MAC = typeof navigator !== "undefined" && navigator.platform.toLowerCase().includes("mac");

const MODIFIER_DISPLAY: Record<KeyMod, string> = {
  cmd: IS_MAC ? "Cmd" : "Ctrl",
  ctrl: "Ctrl",
  shift: "Shift",
  alt: "Alt"
};

export function normalizeKey(raw: string): string {
  if (raw === " ") return "space";
  if (raw === "Spacebar") return "space";
  if (raw === "Delete") return "delete";
  if (raw === "Backspace") return "backspace";
  if (raw === "Enter") return "enter";
  if (raw === "Return") return "enter";
  if (raw === "Escape") return "escape";
  if (raw === "Tab") return "tab";
  return raw.length === 1 ? raw.toLowerCase() : raw;
}

export function fromEvent(event: KeyboardEvent): KeyChord {
  return {
    key: normalizeKey(event.key),
    cmd: event.metaKey || false,
    ctrl: event.ctrlKey || false,
    shift: event.shiftKey || false,
    alt: event.altKey || false
  };
}

export function parseChord(parts: string[]): KeyChord {
  const chord: KeyChord = { key: "" };
  for (const part of parts) {
    const mod = MODIFIER_ALIAS[part.toLowerCase()];
    if (mod) {
      chord[mod] = true;
      continue;
    }
    chord.key = normalizeKey(part);
  }
  if (!chord.key) chord.key = "space";
  return chord;
}

export function chordKey(chord: KeyChord): string {
  const mods: KeyMod[] = [];
  if (chord.ctrl) mods.push("ctrl");
  if (chord.cmd) mods.push("cmd");
  if (chord.shift) mods.push("shift");
  if (chord.alt) mods.push("alt");
  return `${mods.join("+")}+${chord.key}`.toLowerCase();
}

export function matches(chord: KeyChord | undefined, event: KeyboardEvent): boolean {
  if (!chord) return false;
  if (Boolean(chord.cmd) !== event.metaKey) return false;
  if (Boolean(chord.ctrl) !== event.ctrlKey) return false;
  if (Boolean(chord.shift) !== event.shiftKey) return false;
  if (Boolean(chord.alt) !== event.altKey) return false;
  return chord.key === normalizeKey(event.key);
}

export function isCommandChord(event: KeyboardEvent): boolean {
  return Boolean(event.metaKey || event.ctrlKey);
}

export function formatChord(chord: KeyChord): string {
  const parts: string[] = [];
  if (chord.ctrl && chord.cmd) {
    parts.push(MODIFIER_DISPLAY.cmd);
  } else {
    if (chord.cmd) parts.push(MODIFIER_DISPLAY.cmd);
    if (chord.ctrl) parts.push(MODIFIER_DISPLAY.ctrl);
  }
  if (chord.shift) parts.push("Shift");
  if (chord.alt) parts.push("Alt");
  parts.push(displayKey(chord.key));
  return parts.join("+");
}

function displayKey(key: string): string {
  const map: Record<string, string> = {
    space: "Space",
    enter: "Enter",
    tab: "Tab",
    escape: "Esc",
    delete: "Delete",
    backspace: "Backspace",
    arrowup: "Up",
    arrowdown: "Down",
    arrowleft: "Left",
    arrowright: "Right"
  };
  return map[key] ?? (key.length === 1 ? key.toUpperCase() : key);
}

export type ActionDescriptor = ActionMeta & { default: KeyChord };

export const ACTION_DESCRIPTORS: ActionDescriptor[] = [
  {
    id: "canvas.addNode",
    group: "Canvas",
    label: "Add node (quick-add menu)",
    description: "Open the add-node context menu at the last pointer position over empty canvas. Universal shortcut.",
    scope: "canvas",
    reserved: true,
    default: parseChord(["Space"])
  },
  {
    id: "canvas.toggleMinimap",
    group: "Canvas",
    label: "Toggle minimap",
    description: "Show or hide the canvas minimap. Universal shortcut.",
    scope: "canvas",
    reserved: true,
    default: parseChord(["Tab"])
  },
  {
    id: "canvas.toggle3d",
    group: "Canvas",
    label: "Toggle 2D/3D view",
    description: "Switch between the 2D flow editor and the read-only 3D view.",
    scope: "canvas",
    default: parseChord(["cmd", "0"])
  },
  {
    id: "canvas.delete",
    group: "Canvas",
    label: "Delete selection",
    description: "Delete the selected edge, or after confirmation the selected node(s). Universal shortcut.",
    scope: "canvas",
    reserved: true,
    default: parseChord(["delete"])
  },
  {
    id: "canvas.copy",
    group: "Canvas",
    label: "Copy node",
    description: "Copy the selected node(s) to the clipboard. Universal shortcut.",
    scope: "canvas",
    reserved: true,
    default: parseChord(["cmd", "c"])
  },
  {
    id: "canvas.cut",
    group: "Canvas",
    label: "Cut node",
    description: "Cut the selected node(s) to the clipboard. Universal shortcut.",
    scope: "canvas",
    reserved: true,
    default: parseChord(["cmd", "x"])
  },
  {
    id: "canvas.paste",
    group: "Canvas",
    label: "Paste node",
    description: "Paste a node from the clipboard. Universal shortcut.",
    scope: "canvas",
    reserved: true,
    default: parseChord(["cmd", "v"])
  },
  {
    id: "canvas.duplicate",
    group: "Canvas",
    label: "Duplicate node",
    description: "Duplicate the selected node(s). Universal shortcut.",
    scope: "canvas",
    reserved: true,
    default: parseChord(["cmd", "d"])
  },
  {
    id: "canvas.autoLayout",
    group: "Canvas",
    label: "Auto-layout graph",
    description: "Rearrange the visible nodes into a clean layout.",
    scope: "canvas",
    default: parseChord(["cmd", "l"])
  },
  {
    id: "canvas.undo",
    group: "Canvas",
    label: "Undo (notice)",
    description: "Show the direct-undo notice (realtime undo is disabled by design). Universal shortcut.",
    scope: "canvas",
    reserved: true,
    default: parseChord(["cmd", "z"])
  },
  {
    id: "canvas.reload",
    group: "Canvas",
    label: "Reload project JSON",
    description: "Re-read the project model from disk.",
    scope: "canvas",
    default: parseChord(["cmd", "r"])
  },
  {
    id: "project.openPreferences",
    group: "Project",
    label: "Open Preferences",
    description: "Open the app-global Preferences dialog.",
    scope: "app",
    default: parseChord(["cmd", ","])
  },
  {
    id: "project.openHelp",
    group: "Project",
    label: "Open Help",
    description: "Open the help dialog.",
    scope: "app",
    default: parseChord(["F1"])
  },
  {
    id: "project.toggleWorkbench",
    group: "Project",
    label: "Toggle Files/Graph view",
    description: "Switch the workbench between file browser and flow canvas.",
    scope: "app",
    default: parseChord(["cmd", "b"])
  },
  {
    id: "project.toggleFocusMode",
    group: "Project",
    label: "Toggle full screen mode",
    description: "Maximize the window and hide the sidebars plus bottom activity panel until toggled again.",
    scope: "app",
    default: IS_MAC ? parseChord(["cmd", "shift", "m"]) : parseChord(["ctrl", "shift", "m"])
  },
  {
    id: "project.toggleTheme",
    group: "Project",
    label: "Toggle theme",
    description: "Flip between light and dark theme.",
    scope: "app",
    default: parseChord(["cmd", "shift", "t"])
  },
  {
    id: "project.resetLayout",
    group: "Project",
    label: "Reset layout",
    description: "Restore default panel sizes and viewport for the current project.",
    scope: "app",
    default: parseChord(["cmd", "shift", "l"])
  },
  {
    id: "project.focusSidebarSearch",
    group: "Project",
    label: "Focus sidebar scope search",
    description: "Focus and select the left sidebar's current-scope search field.",
    scope: "sidebar",
    default: parseChord(["cmd", "f"])
  },
  {
    id: "project.toggleRuntimePanel",
    group: "Project",
    label: "Toggle Runtime services panel",
    description: "Show or hide the runtime services grid in the right sidebar.",
    scope: "app",
    default: parseChord(["cmd", "shift", "r"])
  },
  {
    id: "project.toggleChat",
    group: "Project",
    label: "Toggle Chat",
    description: "Open or close the research chat panel.",
    scope: "app",
    default: parseChord(["cmd", "shift", "f"])
  },
  {
    id: "project.openProperties",
    group: "Project",
    label: "Open Properties",
    description: "Switch the right sidebar to the Properties tab.",
    scope: "app",
    default: parseChord(["cmd", "shift", "e"])
  },
  {
    id: "project.openGitPanel",
    group: "Project",
    label: "Open Git panel",
    description: "Open the Git status / commit / push / pull dialog.",
    scope: "app",
    default: parseChord(["cmd", "shift", "g"])
  },
  {
    id: "project.openPatchReview",
    group: "Project",
    label: "Open Patch Review",
    description: "Open the patch-proposals review panel.",
    scope: "app",
    default: parseChord(["cmd", "shift", "p"])
  },
  {
    id: "activity.toggle",
    group: "Activity",
    label: "Toggle activity panel",
    description: "Show or hide the bottom activity panel.",
    scope: "app",
    default: parseChord(["cmd", "j"])
  },
  {
    id: "activity.tabRuns",
    group: "Activity",
    label: "Activity: Runs",
    description: "Switch the activity panel to the Runs tab.",
    scope: "app",
    default: parseChord(["cmd", "1"])
  },
  {
    id: "activity.tabTrace",
    group: "Activity",
    label: "Activity: Trace",
    description: "Switch the activity panel to the Trace tab.",
    scope: "app",
    default: parseChord(["cmd", "2"])
  },
  {
    id: "activity.tabErrors",
    group: "Activity",
    label: "Activity: Errors",
    description: "Switch the activity panel to the Errors tab.",
    scope: "app",
    default: parseChord(["cmd", "3"])
  },
  {
    id: "activity.tabPlans",
    group: "Activity",
    label: "Activity: Plan",
    description: "Switch the activity panel to the Plan tab.",
    scope: "app",
    default: parseChord(["cmd", "4"])
  },
  {
    id: "activity.tabDiffs",
    group: "Activity",
    label: "Activity: Source Changes",
    description: "Switch the activity panel to the Source Changes tab.",
    scope: "app",
    default: parseChord(["cmd", "5"])
  },
  {
    id: "activity.tabGit",
    group: "Activity",
    label: "Activity: Git",
    description: "Switch the activity panel to the Git tab.",
    scope: "app",
    default: parseChord(["cmd", "6"])
  },
  {
    id: "activity.tabQuestions",
    group: "Activity",
    label: "Activity: Questions",
    description: "Switch the activity panel to the Questions tab.",
    scope: "app",
    default: parseChord(["cmd", "7"])
  },
  {
    id: "activity.tabArtifacts",
    group: "Activity",
    label: "Activity: Artifacts",
    description: "Switch the activity panel to the Artifacts tab.",
    scope: "app",
    default: parseChord(["cmd", "8"])
  },
  {
    id: "run.approve",
    group: "Run",
    label: "Approve run",
    description: "Approve the selected run in the Runs panel.",
    scope: "runs",
    default: parseChord(["y"])
  },
  {
    id: "run.reject",
    group: "Run",
    label: "Reject run",
    description: "Reject the selected run in the Runs panel.",
    scope: "runs",
    default: parseChord(["n"])
  },
  {
    id: "run.retry",
    group: "Run",
    label: "Retry run",
    description: "Retry the selected failed run in the Runs panel.",
    scope: "runs",
    default: parseChord(["cmd", "enter"])
  },
  {
    id: "chat.send",
    group: "Chat",
    label: "Send chat message",
    description: "Submit the composer message. Adding any modifier inserts a newline instead. Universal shortcut.",
    scope: "composer",
    reserved: true,
    default: parseChord(["enter"])
  },
  {
    id: "chat.newline",
    group: "Chat",
    label: "Newline in message",
    description: "Insert a newline in the focused composer. Universal shortcut.",
    scope: "composer",
    reserved: true,
    default: parseChord(["shift", "enter"])
  },
  {
    id: "chat.newResearchChat",
    group: "Chat",
    label: "New research chat",
    description: "Create a new research chat session for the current scope.",
    scope: "app",
    default: parseChord(["cmd", "shift", "n"])
  }
];

export const ACTION_ID_LIST: ActionId[] = ACTION_DESCRIPTORS.map((descriptor) => descriptor.id);

export const RESERVED_ACTION_IDS: Set<ActionId> = new Set(
  ACTION_DESCRIPTORS.filter((descriptor) => descriptor.reserved).map((descriptor) => descriptor.id)
);

export function isReservedAction(id: ActionId): boolean {
  return RESERVED_ACTION_IDS.has(id);
}

export const ACTION_DESCRIPTOR_BY_ID: Record<ActionId, ActionDescriptor> = ACTION_DESCRIPTORS.reduce(
  (acc, descriptor) => {
    acc[descriptor.id] = descriptor;
    return acc;
  },
  {} as Record<ActionId, ActionDescriptor>
);

export const DEFAULT_BINDINGS: Record<ActionId, KeyChord> = ACTION_DESCRIPTORS.reduce(
  (acc, descriptor) => {
    acc[descriptor.id] = descriptor.default;
    return acc;
  },
  {} as Record<ActionId, KeyChord>
);

export const ACTION_GROUP_ORDER: ActionGroup[] = ["Canvas", "Project", "Activity", "Run", "Chat"];

const RESERVED_CHORD_KEYS = new Set(["escape", "tab"]);

const RESERVED_3D_CAMERA_KEYS = new Set(["w", "a", "s", "d", "space"]);

export function isReservedChord(chord: KeyChord): boolean {
  if (!chord.key) return true;
  if (RESERVED_CHORD_KEYS.has(chord.key)) {
    const cmd = Boolean(chord.cmd || chord.ctrl);
    if (chord.key === "escape") return !cmd;
    if (chord.key === "tab") return !chord.shift && !cmd;
  }
  return false;
}

export function isReservedFor3dCamera(chord: KeyChord): boolean {
  if (chord.cmd || chord.ctrl || chord.alt) return false;
  return RESERVED_3D_CAMERA_KEYS.has(chord.key);
}

export type CleanupBindingResult = {
  cleaned: Record<ActionId, KeyChord>;
  changes: Array<{ id: ActionId; from: string; to: string }>;
};

export function sanitizeStoredBindings(stored: Record<string, unknown> | null | undefined): {
  bindings: Record<ActionId, KeyChord>;
} {
  const bindings: Record<ActionId, KeyChord> = { ...DEFAULT_BINDINGS };
  if (!stored || typeof stored !== "object") return { bindings };
  for (const id of ACTION_ID_LIST) {
    if (RESERVED_ACTION_IDS.has(id)) continue;
    const raw = (stored as Record<string, unknown>)[id];
    if (!raw || typeof raw !== "object") continue;
    const partial = raw as Partial<KeyChord>;
    const key = typeof partial.key === "string" ? partial.key : DEFAULT_BINDINGS[id].key;
    const chord: KeyChord = {
      key,
      cmd: Boolean(partial.cmd),
      ctrl: Boolean(partial.ctrl),
      shift: Boolean(partial.shift),
      alt: Boolean(partial.alt)
    };
    bindings[id] = chord;
  }
  return { bindings };
}

export function findConflicts(bindings: Record<ActionId, KeyChord>): Record<string, ActionId[]> {
  const byChord = new globalThis.Map<string, ActionId[]>();
  for (const id of ACTION_ID_LIST) {
    if (RESERVED_ACTION_IDS.has(id)) continue;
    const chord = bindings[id];
    if (!chord) continue;
    const key = chordKey(chord);
    const list = byChord.get(key) ?? [];
    list.push(id);
    byChord.set(key, list);
  }
  const conflicts: Record<string, ActionId[]> = {};
  for (const [key, list] of byChord) {
    if (list.length > 1) conflicts[key] = list;
  }
  return conflicts;
}
