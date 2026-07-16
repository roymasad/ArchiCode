import { BrainCircuit, Check, ChevronDown, Search } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";

export type ChatModelOption = {
  value: string;
  label: string;
};

export function ChatModelPicker({
  value,
  options,
  disabled = false,
  onValueChange
}: {
  value: string;
  options: ChatModelOption[];
  disabled?: boolean;
  onValueChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const searchRef = useRef<HTMLInputElement | null>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const listId = useId();
  const availableOptions = useMemo(() => {
    const seen = new Set<string>();
    return options.filter((option) => {
      if (!option.value || seen.has(option.value)) return false;
      seen.add(option.value);
      return true;
    });
  }, [options]);
  const filteredOptions = useMemo(() => {
    const query = filter.trim().toLocaleLowerCase();
    if (!query) return availableOptions;
    return availableOptions.filter((option) => (
      option.value.toLocaleLowerCase().includes(query) || option.label.toLocaleLowerCase().includes(query)
    ));
  }, [availableOptions, filter]);
  const visibleOptions = useMemo(() => {
    const limit = 200;
    if (filteredOptions.length <= limit) return filteredOptions;
    if (!filter.trim()) {
      const selected = filteredOptions.find((option) => option.value === value);
      if (selected) {
        return [selected, ...filteredOptions.filter((option) => option.value !== value).slice(0, limit - 1)];
      }
    }
    return filteredOptions.slice(0, limit);
  }, [filter, filteredOptions, value]);
  const selectedOption = availableOptions.find((option) => option.value === value);

  useEffect(() => {
    if (!open) return;
    const closeOnOutsidePointer = (event: PointerEvent) => {
      if (event.target instanceof Node && !rootRef.current?.contains(event.target)) setOpen(false);
    };
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    return () => document.removeEventListener("pointerdown", closeOnOutsidePointer);
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const selectedIndex = visibleOptions.findIndex((option) => option.value === value);
    setActiveIndex(selectedIndex >= 0 ? selectedIndex : visibleOptions.length ? 0 : -1);
  }, [filter, open, value, visibleOptions]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  useEffect(() => {
    if (!disabled) return;
    setOpen(false);
    setFilter("");
    setActiveIndex(-1);
  }, [disabled]);

  const close = () => {
    setOpen(false);
    setFilter("");
    setActiveIndex(-1);
  };

  const select = (nextValue: string) => {
    onValueChange(nextValue);
    close();
  };

  return (
    <div ref={rootRef} className="chat-model-picker">
      <button
        type="button"
        className="chat-model-picker-trigger"
        aria-label={`Chat model: ${selectedOption?.label ?? value}`}
        aria-expanded={open}
        aria-controls={listId}
        disabled={disabled}
        title="Choose the model for this chat"
        onClick={() => {
          setOpen((current) => !current);
          if (!open) requestAnimationFrame(() => searchRef.current?.focus());
        }}
      >
        <BrainCircuit className="chat-model-picker-compact-icon" size={14} aria-hidden="true" />
        <span>{selectedOption?.label ?? value}</span>
        <ChevronDown className="chat-model-picker-chevron" size={13} aria-hidden="true" />
      </button>
      {open ? (
        <div className="chat-model-picker-popover">
          <label className="chat-model-picker-search">
            <Search size={14} aria-hidden="true" />
            <input
              ref={searchRef}
              role="combobox"
              value={filter}
              placeholder="Search models…"
              aria-label="Search models"
              aria-expanded="true"
              aria-controls={listId}
              aria-activedescendant={activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined}
              onChange={(event) => setFilter(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  close();
                  return;
                }
                if (event.key === "ArrowDown") {
                  event.preventDefault();
                  setActiveIndex((current) => Math.min(visibleOptions.length - 1, Math.max(0, current + 1)));
                  return;
                }
                if (event.key === "ArrowUp") {
                  event.preventDefault();
                  setActiveIndex((current) => Math.max(0, current - 1));
                  return;
                }
                if (event.key === "Enter" && activeIndex >= 0 && visibleOptions[activeIndex]) {
                  event.preventDefault();
                  select(visibleOptions[activeIndex].value);
                }
              }}
            />
          </label>
          <div id={listId} className="chat-model-picker-options" role="listbox" aria-label="Available chat models">
            {visibleOptions.length ? visibleOptions.map((option, index) => (
              <button
                key={option.value}
                ref={(element) => { optionRefs.current[index] = element; }}
                id={`${listId}-option-${index}`}
                type="button"
                role="option"
                aria-selected={option.value === value}
                className={index === activeIndex ? "is-active" : ""}
                onMouseEnter={() => setActiveIndex(index)}
                onClick={() => select(option.value)}
              >
                <span>{option.label}</span>
                {option.value === value ? <Check size={14} aria-hidden="true" /> : null}
              </button>
            )) : <small>No matching models.</small>}
          </div>
        </div>
      ) : null}
    </div>
  );
}
