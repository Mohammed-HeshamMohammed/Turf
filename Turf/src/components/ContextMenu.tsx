import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
} from "react";

export type MenuItem = { label: string; onSelect: () => void; disabled?: boolean; hint?: string; checked?: boolean; danger?: boolean } | "separator";

type Open = (event: ReactMouseEvent, items: MenuItem[]) => void;

const MenuContext = createContext<Open>(() => undefined);

/**
 * Right-click menus. A part of the screen offers its own with
 * `onContextMenu={event => menu(event, items)}`; anywhere else gets the app's general one.
 */
export const useContextMenu = () => useContext(MenuContext);

export const copyText = (text: string) => void navigator.clipboard.writeText(text).catch(() => undefined);

type Field = HTMLInputElement | HTMLTextAreaElement;
const isField = (target: EventTarget | null): target is Field =>
  target instanceof HTMLTextAreaElement || (target instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit"].includes(target.type));

/** Typing something into a box so that React hears about it, as if it had been typed. */
function insertInto(field: Field, text: string) {
  const start = field.selectionStart ?? field.value.length;
  const end = field.selectionEnd ?? field.value.length;
  const prototype = field instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(field, field.value.slice(0, start) + text + field.value.slice(end));
  field.dispatchEvent(new Event("input", { bubbles: true }));
  field.setSelectionRange(start + text.length, start + text.length);
}

/** Cut, copy, paste and select-all for the box or the selected text under the pointer. Each is offered only when it can do something. */
function textItems(target: EventTarget | null): MenuItem[] {
  if (isField(target)) {
    const selected = target.value.slice(target.selectionStart ?? 0, target.selectionEnd ?? 0);
    const locked = target.readOnly || target.disabled;
    return [
      {
        label: "Cut",
        disabled: !selected || locked,
        onSelect: () => {
          copyText(selected);
          insertInto(target, "");
          target.focus();
        },
      },
      { label: "Copy", disabled: !selected, onSelect: () => copyText(selected) },
      {
        label: "Paste",
        disabled: locked,
        onSelect: () =>
          void navigator.clipboard.readText().then(
            text => {
              target.focus();
              insertInto(target, text);
            },
            () => undefined,
          ),
      },
      {
        label: "Select all",
        disabled: !target.value,
        onSelect: () => {
          target.focus();
          target.select();
        },
      },
    ];
  }
  const selection = window.getSelection()?.toString() ?? "";
  return selection.trim()
    ? [{ label: "Copy", hint: selection.length > 28 ? `${selection.slice(0, 28)}…` : selection, onSelect: () => copyText(selection) }]
    : [];
}

const join = (...groups: MenuItem[][]) => groups.filter(group => group.length).flatMap((group, index) => (index ? ["separator" as const, ...group] : group));

export function ContextMenuProvider({ general, children }: { general: () => MenuItem[]; children: ReactNode }) {
  const [menu, setMenu] = useState<{ x: number; y: number; items: MenuItem[] } | null>(null);
  const panel = useRef<HTMLDivElement>(null);
  const generalItems = useRef(general);
  generalItems.current = general;

  const open = useCallback<Open>((event, items) => {
    event.preventDefault();
    setMenu({ x: event.clientX, y: event.clientY, items: join(textItems(event.target), items) });
  }, []);

  useEffect(() => {
    // The webview's own menu (Back, Reload, Inspect…) never shows. Where no part of the screen offered a menu, the
    // general one opens.
    const onContextMenu = (event: MouseEvent) => {
      if (event.defaultPrevented) return;
      event.preventDefault();
      setMenu({ x: event.clientX, y: event.clientY, items: join(textItems(event.target), generalItems.current()) });
    };
    // The shortcuts that open the webview's developer tools or page source do nothing.
    const onKeyDown = (event: KeyboardEvent) => {
      const key = event.key.toLowerCase();
      if (key === "f12" || (event.ctrlKey && event.shiftKey && ["i", "j", "c"].includes(key)) || (event.ctrlKey && key === "u")) event.preventDefault();
    };
    document.addEventListener("contextmenu", onContextMenu);
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("contextmenu", onContextMenu);
      document.removeEventListener("keydown", onKeyDown, true);
    };
  }, []);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const outside = (event: PointerEvent) => {
      if (!panel.current?.contains(event.target as Node)) close();
    };
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") return close();
      if (event.key !== "ArrowDown" && event.key !== "ArrowUp") return;
      event.preventDefault();
      const buttons = [...(panel.current?.querySelectorAll<HTMLButtonElement>("button:not(:disabled)") ?? [])];
      const at = buttons.indexOf(document.activeElement as HTMLButtonElement);
      buttons[(at + (event.key === "ArrowDown" ? 1 : -1) + buttons.length) % buttons.length]?.focus();
    };
    document.addEventListener("pointerdown", outside);
    document.addEventListener("keydown", keys);
    document.addEventListener("scroll", close, true);
    window.addEventListener("blur", close);
    window.addEventListener("resize", close);
    return () => {
      document.removeEventListener("pointerdown", outside);
      document.removeEventListener("keydown", keys);
      document.removeEventListener("scroll", close, true);
      window.removeEventListener("blur", close);
      window.removeEventListener("resize", close);
    };
  }, [menu]);

  // Kept inside the window: opened near the right or bottom edge, it opens the other way.
  useLayoutEffect(() => {
    const element = panel.current;
    if (!menu || !element) return;
    const { width, height } = element.getBoundingClientRect();
    element.style.left = `${Math.max(8, Math.min(menu.x, window.innerWidth - width - 8))}px`;
    element.style.top = `${Math.max(8, Math.min(menu.y, window.innerHeight - height - 8))}px`;
    element.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus({ preventScroll: true });
  }, [menu]);

  return (
    <MenuContext.Provider value={open}>
      {children}
      {menu && menu.items.length > 0 && (
        <div className="context-menu" role="menu" ref={panel} style={{ left: menu.x, top: menu.y }} onContextMenu={event => event.preventDefault()}>
          {menu.items.map((item, index) =>
            item === "separator" ? (
              <hr key={index} />
            ) : (
              <button
                key={index}
                type="button"
                role="menuitem"
                disabled={item.disabled}
                className={item.danger ? "danger" : undefined}
                onClick={() => {
                  setMenu(null);
                  item.onSelect();
                }}
              >
                <i aria-hidden="true">{item.checked ? "✓" : ""}</i>
                <span>{item.label}</span>
                {item.hint && <small>{item.hint}</small>}
              </button>
            ),
          )}
        </div>
      )}
    </MenuContext.Provider>
  );
}
