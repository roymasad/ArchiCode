import * as DialogPrimitive from "@radix-ui/react-dialog";
import * as DropdownMenuPrimitive from "@radix-ui/react-dropdown-menu";
import * as LabelPrimitive from "@radix-ui/react-label";
import * as PopoverPrimitive from "@radix-ui/react-popover";
import * as ScrollAreaPrimitive from "@radix-ui/react-scroll-area";
import * as SelectPrimitive from "@radix-ui/react-select";
import * as SeparatorPrimitive from "@radix-ui/react-separator";
import * as SwitchPrimitive from "@radix-ui/react-switch";
import * as TabsPrimitive from "@radix-ui/react-tabs";
import * as TooltipPrimitive from "@radix-ui/react-tooltip";
import { Check, ChevronDown, ChevronRight, HelpCircle, X } from "lucide-react";
import { cloneElement, forwardRef, Fragment, isValidElement, useEffect, useRef, useState } from "react";
import type { ButtonHTMLAttributes, ComponentPropsWithoutRef, CSSProperties, InputHTMLAttributes, ReactElement, ReactNode, Ref, UIEventHandler, TextareaHTMLAttributes } from "react";

type ButtonProps = ButtonHTMLAttributes<HTMLButtonElement> & {
  variant?: "primary" | "secondary" | "ghost" | "success" | "danger";
  size?: "sm" | "md";
};
type DialogInteractOutsideEvent = Parameters<NonNullable<ComponentPropsWithoutRef<typeof DialogPrimitive.Content>["onInteractOutside"]>>[0];

function cx(...parts: Array<string | false | null | undefined>): string {
  return parts.filter(Boolean).join(" ");
}

const SELECT_INTERACTION_GRACE_MS = 650;
let openSelectLayerCount = 0;
let lastSelectInteractionAt = Number.NEGATIVE_INFINITY;

function now(): number {
  return typeof performance === "undefined" ? Date.now() : performance.now();
}

function markSelectInteraction(): void {
  lastSelectInteractionAt = now();
}

function isRecentSelectInteraction(): boolean {
  return openSelectLayerCount > 0 || now() - lastSelectInteractionAt < SELECT_INTERACTION_GRACE_MS;
}

function eventTouchesSelectLayer(event: DialogInteractOutsideEvent): boolean {
  const target = event.target;
  const originalEvent = event.detail.originalEvent as Event | undefined;
  const path = originalEvent?.composedPath?.() ?? [];
  const isSelectElement = (item: EventTarget | null): boolean =>
    item instanceof Element &&
    Boolean(item.closest("[data-archicode-select-portal], [data-archicode-select-trigger]"));

  return isSelectElement(target) || path.some(isSelectElement);
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(function Button(
  { className, variant = "secondary", size = "md", ...props },
  ref
) {
  return <button ref={ref} className={cx("ui-button", `ui-button-${variant}`, `ui-button-${size}`, className)} {...props} />;
});

export const IconButton = forwardRef<HTMLButtonElement, ButtonProps>(function IconButton(
  { className, title, children, type = "button", ...props },
  ref
) {
  return (
    <Tooltip content={title ?? "Action"}>
      <button ref={ref} aria-label={title} className={cx("ui-icon-button", className)} type={type} {...props}>
        {children}
      </button>
    </Tooltip>
  );
});

export const Toolbar = forwardRef<HTMLDivElement, ComponentPropsWithoutRef<"div">>(function Toolbar(
  { children, className, ...props },
  ref
) {
  return <div ref={ref} className={cx("ui-toolbar", className)} {...props}>{children}</div>;
});

export function Panel({ children, className }: { children: ReactNode; className?: string }) {
  return <section className={cx("ui-panel", className)}>{children}</section>;
}

export function PanelHeader({ eyebrow, title, action }: { eyebrow?: ReactNode; title?: ReactNode; action?: ReactNode }) {
  return (
    <div className="ui-panel-header">
      <div>
        {eyebrow ? <span className="ui-eyebrow">{eyebrow}</span> : null}
        {title ? <h2>{title}</h2> : null}
      </div>
      {action}
    </div>
  );
}

export function Badge({ children, tone = "neutral", className }: { children: ReactNode; tone?: "neutral" | "accent" | "success" | "warning" | "danger"; className?: string }) {
  return <span className={cx("ui-badge", `ui-badge-${tone}`, className)}>{children}</span>;
}

export function StatusPill({ children, tone = "neutral" }: { children: ReactNode; tone?: "neutral" | "accent" | "success" | "warning" | "danger" }) {
  return <span className={cx("ui-status-pill", `ui-status-${tone}`)}>{children}</span>;
}

export function EmptyState({ icon, title, children, action }: { icon?: ReactNode; title: string; children?: ReactNode; action?: ReactNode }) {
  return (
    <div className="ui-empty-state">
      {icon}
      <h2>{title}</h2>
      {children ? <p>{children}</p> : null}
      {action}
    </div>
  );
}

export function Field({ label, hint, action, children, className }: { label: ReactNode; hint?: ReactNode; action?: ReactNode; children: ReactNode; className?: string }) {
  const labelRow = (
    <span className="ui-field-label-row">
      <span>{label}</span>
      {hint ? (
        <Tooltip content={hint}>
          <span className="ui-field-hint-button" tabIndex={0} aria-label="Field help">
            <HelpCircle size={13} aria-hidden="true" />
          </span>
        </Tooltip>
      ) : null}
    </span>
  );

  if (action) {
    return (
      <div className={cx("ui-field", "ui-field-with-action", className)}>
        <LabelPrimitive.Root className="ui-field-action-label">
          {labelRow}
          {children}
        </LabelPrimitive.Root>
        <span className="ui-field-action-slot">{action}</span>
      </div>
    );
  }

  return (
    <LabelPrimitive.Root className={cx("ui-field", className)}>
      {labelRow}
      {children}
    </LabelPrimitive.Root>
  );
}

export const TextInput = forwardRef<HTMLInputElement, InputHTMLAttributes<HTMLInputElement>>(function TextInput({ className, ...props }, ref) {
  return <input ref={ref} className={cx("ui-input", className)} {...props} />;
});

export const TextArea = forwardRef<HTMLTextAreaElement, TextareaHTMLAttributes<HTMLTextAreaElement>>(function TextArea({ className, ...props }, ref) {
  return <textarea ref={ref} className={cx("ui-textarea", className)} {...props} />;
});

export function Switch({
  checked,
  onCheckedChange,
  label,
  tooltip,
  disabled
}: {
  checked: boolean;
  onCheckedChange: (checked: boolean) => void;
  label: ReactNode;
  tooltip?: ReactNode;
  disabled?: boolean;
}) {
  const row = (
    <label className={cx("ui-switch-row", disabled && "ui-switch-row-disabled")}>
      <SwitchPrimitive.Root className="ui-switch" checked={checked} onCheckedChange={onCheckedChange} disabled={disabled}>
        <SwitchPrimitive.Thumb className="ui-switch-thumb" />
      </SwitchPrimitive.Root>
      <span>{label}</span>
    </label>
  );
  return tooltip ? <Tooltip content={tooltip}>{row}</Tooltip> : row;
}

export function Select({
  value,
  onValueChange,
  options,
  placeholder = "Select",
  disabled = false,
  ariaLabel,
  contentClassName,
  showScrollIndicator = false
}: {
  value: string;
  onValueChange: (value: string) => void;
  options: Array<{ value: string; label: string; hint?: string; tooltip?: ReactNode; disabled?: boolean }>;
  placeholder?: string;
  disabled?: boolean;
  ariaLabel?: string;
  contentClassName?: string;
  showScrollIndicator?: boolean;
}) {
  const [open, setOpen] = useState(false);
  const [scrollIndicator, setScrollIndicator] = useState({ visible: false, thumbHeight: 0, thumbOffset: 0 });
  const viewportRef = useRef<HTMLDivElement | null>(null);

  const updateScrollIndicator = (viewport: HTMLDivElement) => {
    const scrollableHeight = viewport.scrollHeight - viewport.clientHeight;
    if (scrollableHeight <= 1) {
      setScrollIndicator({ visible: false, thumbHeight: 0, thumbOffset: 0 });
      return;
    }
    const thumbHeight = Math.max(36, Math.round((viewport.clientHeight * viewport.clientHeight) / viewport.scrollHeight));
    const thumbOffset = Math.round((viewport.scrollTop / scrollableHeight) * (viewport.clientHeight - thumbHeight));
    setScrollIndicator({ visible: true, thumbHeight, thumbOffset });
  };

  useEffect(() => {
    if (!open) return;
    openSelectLayerCount += 1;
    return () => {
      openSelectLayerCount = Math.max(0, openSelectLayerCount - 1);
      markSelectInteraction();
    };
  }, [open]);

  useEffect(() => {
    if (!open || !showScrollIndicator) return;
    const frame = window.requestAnimationFrame(() => {
      if (viewportRef.current) updateScrollIndicator(viewportRef.current);
    });
    return () => window.cancelAnimationFrame(frame);
  }, [open, showScrollIndicator]);

  return (
    <SelectPrimitive.Root
      value={value}
      onValueChange={onValueChange}
      disabled={disabled}
      open={open}
      onOpenChange={(nextOpen) => {
        markSelectInteraction();
        setOpen(nextOpen);
      }}
    >
      <SelectPrimitive.Trigger
        className="ui-select-trigger"
        aria-label={ariaLabel}
        data-archicode-select-trigger=""
        onPointerDownCapture={markSelectInteraction}
        onKeyDownCapture={markSelectInteraction}
      >
        <SelectPrimitive.Value placeholder={placeholder} />
        <SelectPrimitive.Icon>
          <ChevronDown size={14} />
        </SelectPrimitive.Icon>
      </SelectPrimitive.Trigger>
      <SelectPrimitive.Portal>
        <SelectPrimitive.Content
          className={cx("ui-select-content", contentClassName)}
          position="popper"
          sideOffset={6}
          data-archicode-select-portal=""
          onPointerDownCapture={markSelectInteraction}
          onFocusCapture={markSelectInteraction}
        >
          <SelectPrimitive.Viewport
            ref={showScrollIndicator ? viewportRef : undefined}
            className="ui-select-viewport"
            onScroll={showScrollIndicator ? (event) => updateScrollIndicator(event.currentTarget) : undefined}
          >
            {options.map((option) => {
              const item = (
                <SelectPrimitive.Item value={option.value} disabled={option.disabled} className="ui-select-item">
                <SelectPrimitive.ItemText>{option.label}</SelectPrimitive.ItemText>
                {option.hint ? <span className="ui-select-item-hint">{option.hint}</span> : null}
                <SelectPrimitive.ItemIndicator>
                  <Check size={14} />
                </SelectPrimitive.ItemIndicator>
              </SelectPrimitive.Item>
              );
              return option.tooltip
                ? <Tooltip key={option.value} content={option.tooltip}>{item}</Tooltip>
                : <Fragment key={option.value}>{item}</Fragment>;
            })}
          </SelectPrimitive.Viewport>
          {showScrollIndicator && scrollIndicator.visible ? (
            <span
              aria-hidden="true"
              className="ui-select-scroll-indicator"
              style={{
                "--ui-select-scroll-indicator-height": `${scrollIndicator.thumbHeight}px`,
                "--ui-select-scroll-indicator-offset": `${scrollIndicator.thumbOffset}px`
              } as CSSProperties}
            />
          ) : null}
        </SelectPrimitive.Content>
      </SelectPrimitive.Portal>
    </SelectPrimitive.Root>
  );
}

export const DialogRoot = DialogPrimitive.Root;
export const DialogTrigger = DialogPrimitive.Trigger;
export const DialogClose = DialogPrimitive.Close;

export function DialogContent({
  title,
  description,
  children,
  className,
  hideCloseButton = false,
  draggable = false,
  resizable = false,
  onInteractOutside,
  onEscapeKeyDown
}: {
  title: string;
  description?: string;
  children: ReactNode;
  className?: string;
  hideCloseButton?: boolean;
  draggable?: boolean;
  resizable?: boolean;
  onInteractOutside?: ComponentPropsWithoutRef<typeof DialogPrimitive.Content>["onInteractOutside"];
  onEscapeKeyDown?: ComponentPropsWithoutRef<typeof DialogPrimitive.Content>["onEscapeKeyDown"];
}) {
  const contentRef = useRef<HTMLDivElement | null>(null);
  const [position, setPosition] = useState<{ x: number; y: number } | null>(null);

  const handleInteractOutside: ComponentPropsWithoutRef<typeof DialogPrimitive.Content>["onInteractOutside"] = (event) => {
    if (eventTouchesSelectLayer(event) || isRecentSelectInteraction()) {
      event.preventDefault();
      return;
    }
    onInteractOutside?.(event);
  };

  const startDrag = (event: React.PointerEvent<HTMLDivElement>) => {
    if (!draggable || event.button !== 0) return;
    const target = event.target as HTMLElement;
    if (target.closest("button, a, input, select, textarea, [role='button'], [data-no-dialog-drag]")) return;
    const rect = contentRef.current?.getBoundingClientRect();
    if (!rect) return;
    event.preventDefault();
    const startX = event.clientX;
    const startY = event.clientY;
    const initial = { x: rect.left, y: rect.top };
    setPosition(initial);

    const onMove = (moveEvent: PointerEvent) => {
      const width = contentRef.current?.offsetWidth ?? rect.width;
      const height = contentRef.current?.offsetHeight ?? rect.height;
      setPosition({
        x: Math.min(Math.max(initial.x + moveEvent.clientX - startX, 8), Math.max(8, window.innerWidth - Math.min(96, width))),
        y: Math.min(Math.max(initial.y + moveEvent.clientY - startY, 8), Math.max(8, window.innerHeight - Math.min(96, height)))
      });
    };
    const onUp = () => {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
    };
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
  };

  const dialogStyle: CSSProperties | undefined = position
    ? { left: position.x, top: position.y, transform: "none" }
    : undefined;

  return (
    <DialogPrimitive.Portal>
      <DialogPrimitive.Overlay className="ui-dialog-overlay" />
      <DialogPrimitive.Content
        ref={contentRef}
        className={cx("ui-dialog-content", draggable && "is-draggable", resizable && "is-resizable", className)}
        style={dialogStyle}
        onEscapeKeyDown={onEscapeKeyDown}
        onInteractOutside={handleInteractOutside}
      >
        <div className="ui-dialog-header" onPointerDown={startDrag}>
          <div>
            <DialogPrimitive.Title>{title}</DialogPrimitive.Title>
            {description ? <DialogPrimitive.Description>{description}</DialogPrimitive.Description> : null}
          </div>
          {hideCloseButton ? null : (
            <DialogPrimitive.Close asChild>
              <IconButton title="Close">
                <X size={16} />
              </IconButton>
            </DialogPrimitive.Close>
          )}
        </div>
        {children}
      </DialogPrimitive.Content>
    </DialogPrimitive.Portal>
  );
}

export const MenuRoot = DropdownMenuPrimitive.Root;
export const MenuTrigger = DropdownMenuPrimitive.Trigger;
export const MenuSub = DropdownMenuPrimitive.Sub;

export function MenuContent({ children, align = "end", className }: { children: ReactNode; align?: "start" | "center" | "end"; className?: string }) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.Content className={className ? `ui-menu-content ${className}` : "ui-menu-content"} align={align} sideOffset={8}>
        {children}
      </DropdownMenuPrimitive.Content>
    </DropdownMenuPrimitive.Portal>
  );
}

export function MenuItem({
  children,
  onSelect,
  disabled,
  tooltip
}: {
  children: ReactNode;
  onSelect?: ComponentPropsWithoutRef<typeof DropdownMenuPrimitive.Item>["onSelect"];
  disabled?: boolean;
  tooltip?: ReactNode;
}) {
  const item = (
    <DropdownMenuPrimitive.Item className="ui-menu-item" onSelect={onSelect} disabled={disabled}>
      {children}
    </DropdownMenuPrimitive.Item>
  );
  if (!tooltip) return item;
  return (
    <TooltipPrimitive.Root>
      <TooltipPrimitive.Trigger asChild>{item}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content className="ui-tooltip" side="left" sideOffset={8}>
          {tooltip}
          <TooltipPrimitive.Arrow className="ui-tooltip-arrow" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export function MenuSubTrigger({ children, disabled }: { children: ReactNode; disabled?: boolean }) {
  return (
    <DropdownMenuPrimitive.SubTrigger className="ui-menu-item ui-menu-sub-trigger" disabled={disabled}>
      {children}
      <ChevronRight className="ui-menu-sub-chevron" size={14} />
    </DropdownMenuPrimitive.SubTrigger>
  );
}

export function MenuSubContent({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <DropdownMenuPrimitive.Portal>
      <DropdownMenuPrimitive.SubContent
        className={className ? `ui-menu-content ${className}` : "ui-menu-content"}
        sideOffset={6}
        alignOffset={-5}
      >
        {children}
      </DropdownMenuPrimitive.SubContent>
    </DropdownMenuPrimitive.Portal>
  );
}

export function MenuLabel({ children }: { children: ReactNode }) {
  return <DropdownMenuPrimitive.Label className="ui-menu-label">{children}</DropdownMenuPrimitive.Label>;
}

export function MenuSeparator() {
  return <DropdownMenuPrimitive.Separator className="ui-menu-separator" />;
}

export const TabsRoot = TabsPrimitive.Root;
export const TabsList = TabsPrimitive.List;
export const TabsTrigger = TabsPrimitive.Trigger;
export const TabsContent = TabsPrimitive.Content;

export function TooltipProvider({ children }: { children: ReactNode }) {
  return <TooltipPrimitive.Provider delayDuration={240}>{children}</TooltipPrimitive.Provider>;
}

export function Tooltip({
  content,
  children,
  open,
  onOpenChange
}: {
  content: ReactNode;
  children: ReactNode;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}) {
  const trigger = isValidElement(children)
    ? cloneElement(children as ReactElement<{ title?: string }>, { title: undefined })
    : children;
  return (
    <TooltipPrimitive.Root open={open} onOpenChange={onOpenChange}>
      <TooltipPrimitive.Trigger asChild>{trigger}</TooltipPrimitive.Trigger>
      <TooltipPrimitive.Portal>
        <TooltipPrimitive.Content className="ui-tooltip" sideOffset={6}>
          {content}
          <TooltipPrimitive.Arrow className="ui-tooltip-arrow" />
        </TooltipPrimitive.Content>
      </TooltipPrimitive.Portal>
    </TooltipPrimitive.Root>
  );
}

export function ScrollArea({
  children,
  className,
  viewportRef,
  onScroll
}: {
  children: ReactNode;
  className?: string;
  viewportRef?: Ref<HTMLDivElement>;
  onScroll?: UIEventHandler<HTMLDivElement>;
}) {
  return (
    <ScrollAreaPrimitive.Root className={cx("ui-scroll-area", className)}>
      <ScrollAreaPrimitive.Viewport ref={viewportRef} className="ui-scroll-viewport" onScroll={onScroll}>
        {children}
      </ScrollAreaPrimitive.Viewport>
      <ScrollAreaPrimitive.Scrollbar className="ui-scrollbar" orientation="vertical">
        <ScrollAreaPrimitive.Thumb className="ui-scroll-thumb" />
      </ScrollAreaPrimitive.Scrollbar>
      <ScrollAreaPrimitive.Corner />
    </ScrollAreaPrimitive.Root>
  );
}

export function Separator() {
  return <SeparatorPrimitive.Root className="ui-separator" />;
}

export const PopoverRoot = PopoverPrimitive.Root;
export const PopoverTrigger = PopoverPrimitive.Trigger;
export const PopoverContent = PopoverPrimitive.Content;

export function CommandGroup({ title, children }: { title?: ReactNode; children: ReactNode }) {
  return (
    <div className="ui-command-group">
      {title ? <span>{title}</span> : null}
      {children}
    </div>
  );
}
