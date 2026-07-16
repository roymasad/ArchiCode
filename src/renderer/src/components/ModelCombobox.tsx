import { ChevronDown } from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { IconButton, TextInput } from "./ui";

type ModelOption = {
  value: string;
  label: string;
};

export function ModelCombobox({
  value,
  options,
  placeholder,
  catalogMode = false,
  onValueChange
}: {
  value: string;
  options: ModelOption[];
  placeholder?: string;
  catalogMode?: boolean;
  onValueChange: (value: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [filter, setFilter] = useState("");
  const [activeIndex, setActiveIndex] = useState(-1);
  const rootRef = useRef<HTMLDivElement | null>(null);
  const inputRef = useRef<HTMLInputElement | null>(null);
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
    setActiveIndex(visibleOptions.length ? 0 : -1);
  }, [filter, open, visibleOptions.length]);

  useEffect(() => {
    if (!open || activeIndex < 0) return;
    optionRefs.current[activeIndex]?.scrollIntoView({ block: "nearest" });
  }, [activeIndex, open]);

  const showAllOptions = () => {
    setFilter("");
    setOpen(true);
  };

  const selectModel = (model: string) => {
    onValueChange(model);
    setFilter("");
    setActiveIndex(-1);
    setOpen(false);
  };

  const closeOptions = () => {
    setFilter("");
    setActiveIndex(-1);
    setOpen(false);
  };

  return (
    <div ref={rootRef} className="model-combobox">
      <TextInput
        ref={inputRef}
        className="model-combobox-input"
        role="combobox"
        aria-autocomplete="list"
        aria-controls={listId}
        aria-expanded={open}
        aria-activedescendant={open && activeIndex >= 0 ? `${listId}-option-${activeIndex}` : undefined}
        value={catalogMode && open ? filter : value}
        placeholder={catalogMode && open ? "Search models…" : placeholder}
        onFocus={showAllOptions}
        onChange={(event) => {
          if (!catalogMode) onValueChange(event.target.value);
          setFilter(event.target.value);
          setOpen(true);
        }}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.preventDefault();
            closeOptions();
            return;
          }
          if (event.key === "ArrowDown") {
            event.preventDefault();
            if (!open) showAllOptions();
            else setActiveIndex((current) => Math.min(visibleOptions.length - 1, Math.max(0, current + 1)));
            return;
          }
          if (event.key === "ArrowUp" && open) {
            event.preventDefault();
            setActiveIndex((current) => Math.max(0, current - 1));
            return;
          }
          if (event.key === "Enter" && open && activeIndex >= 0 && visibleOptions[activeIndex]) {
            event.preventDefault();
            selectModel(visibleOptions[activeIndex].value);
          }
        }}
      />
      <IconButton
        className="model-combobox-trigger"
        title="Show model options"
        aria-expanded={open}
        aria-controls={listId}
        onMouseDown={(event) => event.preventDefault()}
        onClick={() => {
          showAllOptions();
          inputRef.current?.focus();
        }}
      >
        <ChevronDown size={16} />
      </IconButton>
      {open ? (
        <div id={listId} className="model-combobox-options" role="listbox" aria-label="Model options">
          {visibleOptions.length ? visibleOptions.map((option, index) => (
            <button
              key={option.value}
              ref={(element) => { optionRefs.current[index] = element; }}
              id={`${listId}-option-${index}`}
              data-option-index={index}
              type="button"
              role="option"
              aria-selected={option.value === value}
              className={index === activeIndex ? "is-active" : option.value === value ? "is-selected" : ""}
              onMouseEnter={() => setActiveIndex(index)}
              onClick={(event) => {
                // Field wraps the combobox in a label. Prevent its default
                // activation from refocusing the input and reopening the list.
                event.preventDefault();
                selectModel(option.value);
              }}
            >
              {option.label}
            </button>
          )) : <small>No matching model suggestions.</small>}
          {filteredOptions.length > visibleOptions.length ? (
            <small className="model-combobox-limit-note">
              Showing {visibleOptions.length} of {filteredOptions.length} matches. Keep typing to narrow the list.
            </small>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
