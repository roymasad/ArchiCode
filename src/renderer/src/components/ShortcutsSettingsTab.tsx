import { t } from "@renderer/i18n";
import { Keyboard, RotateCcw, Search, X } from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { useArchicodeStore } from "../store/useArchicodeStore";
import {
  ACTION_DESCRIPTORS,
  ACTION_GROUP_ORDER,
  chordKey,
  findConflicts,
  formatChord,
  fromEvent,
  isReservedChord,
  isReservedFor3dCamera,
  type ActionDescriptor,
  type ActionId,
  type ActionMeta,
  type KeyChord,
  DEFAULT_BINDINGS
} from "../utils/keybindings";
import { Button, IconButton, TabsContent, Tooltip } from "./ui";

type DraftState = { id: ActionId; chord: KeyChord | null };

function actionById(id: string): ActionDescriptor | null {
  return ACTION_DESCRIPTORS.find((descriptor) => descriptor.id === id) ?? null;
}

export function ShortcutsSettingsTab() {
  const keybindings = useArchicodeStore((state) => state.keybindings);
  const setKeybinding = useArchicodeStore((state) => state.setKeybinding);
  const resetKeybinding = useArchicodeStore((state) => state.resetKeybinding);
  const resetAllKeybindings = useArchicodeStore((state) => state.resetAllKeybindings);
  const keybindingsBusy = useArchicodeStore((state) => state.keybindingsBusy);

  const [filter, setFilter] = useState("");
  const [draft, setDraft] = useState<DraftState | null>(null);
  const captureRef = useRef<HTMLButtonElement | null>(null);

  const conflicts = useMemo(() => findConflicts(keybindings), [keybindings]);

  const filteredDescriptors = useMemo(() => {
    const query = filter.trim().toLowerCase();
    if (!query) return ACTION_DESCRIPTORS;
    return ACTION_DESCRIPTORS.filter((descriptor) => {
      const haystack = `${descriptor.label} ${descriptor.description} ${descriptor.group}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [filter]);

  const groupedDescriptors = useMemo(() => {
    const groups = new globalThis.Map<string, ActionDescriptor[]>();
    for (const descriptor of filteredDescriptors) {
      const list = groups.get(descriptor.group) ?? [];
      list.push(descriptor);
      groups.set(descriptor.group, list);
    }
    return ACTION_GROUP_ORDER.map((group) => ({ group, items: groups.get(group) ?? [] })).filter((entry) => entry.items.length > 0);
  }, [filteredDescriptors]);

  useEffect(() => {
    if (!draft) return;
    const handleKeyDown = (event: KeyboardEvent) => {
      event.preventDefault();
      event.stopPropagation();
      if (event.key === "Escape") {
        setDraft(null);
        return;
      }
      const onlyModifier = ["Shift", "Control", "Alt", "Meta"].includes(event.key);
      if (onlyModifier) return;
      const chord = fromEvent(event);
      setDraft({ id: draft.id, chord });
    };
    window.addEventListener("keydown", handleKeyDown, true);
    return () => window.removeEventListener("keydown", handleKeyDown, true);
  }, [draft]);

  useEffect(() => {
    if (!draft || !draft.chord) return;
    captureRef.current?.focus();
  }, [draft]);

  const applyDraft = async () => {
    if (!draft || !draft.chord) return;
    await setKeybinding(draft.id, draft.chord);
    setDraft(null);
  };

  const cancelDraft = () => setDraft(null);

  const resetOne = async (id: ActionId) => {
    await resetKeybinding(id);
  };

  const resetAll = async () => {
    const confirmed = window.confirm("Reset all keyboard shortcuts to their defaults?");
    if (!confirmed) return;
    await resetAllKeybindings();
    setDraft(null);
  };

  const renderRow = (descriptor: ActionMeta) => {
    const binding = keybindings[descriptor.id as ActionId];
    if (descriptor.reserved) {
      return (
        <li key={descriptor.id} className="preferences-row is-reserved" aria-label={t("{{label}}(universal shortcut, not rebindable)", { label: descriptor.label })}>
          <div className="preferences-row-copy">
            <strong>{descriptor.label}</strong>
            <span className="preferences-row-description">{descriptor.description}</span>
          </div>
          <div className="preferences-row-binding">
            <span className="preferences-reserved-chord" aria-disabled="true">
              <Keyboard size={14} />
              <span>{formatChord(binding)}</span>
            </span>
            <span className="preferences-reserved-badge" title={t("Universal shortcut — not rebindable")}>{t("Locked")}</span>
          </div>
        </li>
      );
    }
    const isNew = draft?.id === descriptor.id;
    const draftChord = isNew ? draft?.chord : null;
    if (draftChord) {
      const reservedReasonReserved = isReservedChord(draftChord);
      const reservedReason3d = isReservedFor3dCamera(draftChord);
      const conflictingEntry = conflicts[chordKey(draftChord)];
      const hasConflict = Boolean(conflictingEntry && conflictingEntry.length > 1);
      return (
        <li key={descriptor.id} className="preferences-row is-drafting">
          <div className="preferences-row-copy">
            <strong>{descriptor.label}</strong>
            <span className="preferences-row-description">{descriptor.description}</span>
          </div>
          <div className="preferences-row-binding">
            <Tooltip content={t("Captured chord")}>
              <Button ref={captureRef} type="button" size="sm" variant="primary" onClick={() => setDraft({ id: descriptor.id as ActionId, chord: null })}>
                <Keyboard size={14} />
                <span>{formatChord(draftChord)}</span>
              </Button>
            </Tooltip>
            <div className="preferences-row-actions">
              <Button type="button" size="sm" variant="success" onClick={applyDraft} disabled={reservedReasonReserved || reservedReason3d}>
                {t("Apply")}{" "}</Button>
              <Button type="button" size="sm" variant="ghost" onClick={cancelDraft}>
                {t("Cancel")}{" "}</Button>
            </div>
          </div>
          {reservedReasonReserved ? (
            <span className="preferences-row-warning is-danger">{t("Reserved by the browser or window manager. Choose a different chord.")}</span>
          ) : reservedReason3d ? (
            <span className="preferences-row-warning is-danger">{t("WASD-style keys are reserved for 3D canvas camera navigation. Choose a different chord.")}</span>
          ) : hasConflict ? (
            <span className="preferences-row-warning">{t("Already bound to: {{value1}}. Applying will override.", { value1: conflictingEntry!.filter((id) => id !== descriptor.id).map((id) => actionById(id)?.label ?? id).join(", ") })}</span>
          ) : null}
        </li>
      );
    }
    const conflictingEntry = conflicts[chordKey(binding)] ?? [];
    const conflictCount = conflictingEntry.length - 1;
    return (
      <li key={descriptor.id} className="preferences-row">
        <div className="preferences-row-copy">
          <strong>{descriptor.label}</strong>
          <span className="preferences-row-description">{descriptor.description}</span>
        </div>
        <div className="preferences-row-binding">
          <Button
            type="button"
            size="sm"
            variant={isNew ? "primary" : "secondary"}
            aria-pressed={isNew}
            onClick={() => {
              setDraft({ id: descriptor.id as ActionId, chord: null });
              captureRef.current?.focus();
            }}
          >
            <Keyboard size={14} />
            <span>{formatChord(binding)}</span>
          </Button>
          <div className="preferences-row-actions">
            <Button
              type="button"
              size="sm"
              variant="ghost"
              onClick={() => resetOne(descriptor.id as ActionId)}
              disabled={binding && DEFAULT_BINDINGS[descriptor.id as ActionId] && chordKey(binding) === chordKey(DEFAULT_BINDINGS[descriptor.id as ActionId])}
              title={t("Reset this binding to its default")}
            >
              <RotateCcw size={13} />
              <span>{t("Reset")}</span>
            </Button>
          </div>
        </div>
        {conflictCount > 0 ? (
          <span className="preferences-row-warning">{t("Conflicts with {{value1}}.", { value1: conflictingEntry.filter((id) => id !== descriptor.id).map((id) => actionById(id)?.label ?? id).join(", ") })}</span>
        ) : null}
      </li>
    );
  };

  return (
    <TabsContent value="shortcuts" className="preferences-tab-content">
      <div className="preferences-filter-row">
        <Search size={14} />
        <input
          className="ui-input preferences-filter-input"
          placeholder={t("Filter actions...")}
          value={filter}
          onChange={(event) => setFilter(event.target.value)}
        />
        {filter ? (
          <IconButton aria-label={t("Clear filter")} title={t("Clear filter")} onClick={() => setFilter("")}>
            <X size={14} />
          </IconButton>
        ) : null}
        <Button type="button" size="sm" variant="ghost" onClick={resetAll} disabled={keybindingsBusy}>
          <RotateCcw size={13} />
          <span>{t("Reset all to defaults")}</span>
        </Button>
      </div>
      <div className="preferences-groups">
        {groupedDescriptors.map((entry) => (
          <section key={entry.group} className="preferences-group">
            <h3>{entry.group}</h3>
            <ul className="preferences-rows">
              {entry.items.map((descriptor) => renderRow(descriptor))}
            </ul>
          </section>
        ))}
        {groupedDescriptors.length === 0 ? (
          <p className="preferences-empty">{t("No actions match \" {{filter}} \".", { filter: filter })}</p>
        ) : null}
      </div>
    </TabsContent>
  );
}