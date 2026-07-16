import { describe, expect, it } from "vitest";
import {
  DEFAULT_BINDINGS,
  chordKey,
  findConflicts,
  fromEvent,
  matches,
  parseChord,
  sanitizeStoredBindings
} from "../src/renderer/src/utils/keybindings";

function fakeKey(key: string, mods: { cmd?: boolean; ctrl?: boolean; shift?: boolean; alt?: boolean } = {}): KeyboardEvent {
  return {
    key,
    metaKey: Boolean(mods.cmd),
    ctrlKey: Boolean(mods.ctrl),
    shiftKey: Boolean(mods.shift),
    altKey: Boolean(mods.alt)
  } as KeyboardEvent;
}

describe("keybindings.matches", () => {
  it("matches a chord produced by parseChord with unset modifiers treated as false", () => {
    const chord = parseChord(["cmd", "c"]);
    expect(chord.ctrl).toBeUndefined();
    expect(matches(chord, fakeKey("c", { cmd: true }))).toBe(true);
    expect(matches(chord, fakeKey("c", { cmd: true, ctrl: true }))).toBe(false);
    expect(matches(chord, fakeKey("c"))).toBe(false);
  });

  it("matches a bare-key default binding with no modifiers", () => {
    const chord = parseChord(["delete"]);
    expect(matches(chord, fakeKey("Delete"))).toBe(true);
    expect(matches(chord, fakeKey("Delete", { shift: true }))).toBe(false);
  });

  it("matches default bindings directly (reset path) without sanitization", () => {
    for (const id of Object.keys(DEFAULT_BINDINGS) as Array<keyof typeof DEFAULT_BINDINGS>) {
      const chord = DEFAULT_BINDINGS[id];
      if (!chord || !chord.key) continue;
      const mods = { cmd: chord.cmd, ctrl: chord.ctrl, shift: chord.shift, alt: chord.alt };
      expect(matches(chord, fakeKey(chord.key, mods))).toBe(true);
    }
  });
});

describe("keybindings round-trip", () => {
  it("sanitizeStoredBindings normalizes unset modifiers to false", () => {
    const raw = { "canvas.toggle3d": { key: "0", cmd: true } };
    const { bindings } = sanitizeStoredBindings(raw);
    expect(bindings["canvas.toggle3d"]).toEqual({ key: "0", cmd: true, ctrl: false, shift: false, alt: false });
  });

  it("chordKey is stable for undefined vs false modifiers", () => {
    expect(chordKey(parseChord(["cmd", "c"]))).toBe(chordKey({ key: "c", cmd: true, ctrl: false, shift: false, alt: false }));
  });

  it("findConflicts treats undefined and false modifiers equivalently", () => {
    const a = parseChord(["cmd", "k"]);
    const b = { key: "k", cmd: true, ctrl: false, shift: false, alt: false };
    const bindings = { ...DEFAULT_BINDINGS, "canvas.toggle3d": a, "canvas.autoLayout": b };
    const conflicts = findConflicts(bindings as never);
    const key = chordKey(a);
    expect(conflicts[key]?.length ?? 0).toBeGreaterThanOrEqual(2);
  });
});
