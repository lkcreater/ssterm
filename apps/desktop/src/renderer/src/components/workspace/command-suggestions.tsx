import { useId, useLayoutEffect, useRef, useState, type KeyboardEvent } from "react";
import { HistoryIcon, Trash2Icon } from "lucide-react";
import { Button } from "@/components/ui/button";

const MODIFIERS = new Set(["Shift", "Meta", "Control", "Alt", "CapsLock", "Fn"]);

/**
 * ⌘; suggestions (SST-034): a transient listbox over the terminal frame, so it never resizes the PTY. While it is
 * mounted the workspace chord guard suspends shortcuts. ↑/↓ select, Return inserts (never Enter), Esc closes and
 * ⇧⌫ forgets; any other key closes without reaching the shell. Keyboard closes return focus to the terminal; a click
 * elsewhere closes it and leaves focus where the user clicked.
 */
export function CommandSuggestions({
  label,
  items,
  onAccept,
  onForget,
  onClose,
}: {
  label: string;
  items: readonly string[];
  onAccept(item: string): void;
  onForget(item: string): void;
  onClose(restoreFocus?: boolean): void;
}) {
  const id = useId();
  const list = useRef<HTMLUListElement>(null);
  const [active, setActive] = useState(0);
  const selected = Math.min(active, items.length - 1);
  useLayoutEffect(() => list.current?.focus(), []);
  const onKeyDown = (event: KeyboardEvent<HTMLUListElement>) => {
    if (MODIFIERS.has(event.key) || event.nativeEvent.isComposing) return;
    event.preventDefault();
    event.stopPropagation();
    if (event.key === "ArrowDown") setActive((selected + 1) % items.length);
    else if (event.key === "ArrowUp") setActive((selected - 1 + items.length) % items.length);
    else if (event.key === "Home") setActive(0);
    else if (event.key === "End") setActive(items.length - 1);
    else if (event.key === "Enter" && !event.shiftKey && !event.metaKey && !event.altKey && !event.ctrlKey) onAccept(items[selected]!);
    else if ((event.key === "Backspace" || event.key === "Delete") && event.shiftKey) onForget(items[selected]!);
    else onClose();
  };
  return (
    <div
      className="command-suggestions"
      data-testid="command-suggestions"
      onBlur={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) onClose(false); }}
    >
      <ul
        ref={list}
        id={id}
        role="listbox"
        tabIndex={0}
        aria-label={`Command history for ${label}`}
        aria-activedescendant={`${id}-${selected}`}
        className="command-suggestion-list"
        onKeyDown={onKeyDown}
      >
        {items.map((item, index) => (
          <li
            key={item}
            id={`${id}-${index}`}
            role="option"
            aria-selected={index === selected}
            className="command-suggestion"
            onMouseDown={(event) => event.preventDefault()}
            onMouseEnter={() => setActive(index)}
            onClick={() => onAccept(item)}
          >
            {item}
          </li>
        ))}
      </ul>
      <div className="command-suggestion-footer">
        <HistoryIcon className="size-3.5 shrink-0" aria-hidden="true" />
        <span className="type-caption min-w-0 flex-1">Reported by the shell; check before running. ↩ inserts without running.</span>
        <Button
          size="xs"
          variant="ghost"
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => onForget(items[selected]!)}
          title="Forget the selected command (⇧⌫)"
        >
          <Trash2Icon data-icon="inline-start" aria-hidden="true" />
          Forget
        </Button>
      </div>
    </div>
  );
}
