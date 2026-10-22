import { useEffect, useId, useRef, useState, type ComponentProps, type ReactNode } from "react";
import { Dialog as DialogPrimitive } from "@base-ui/react/dialog";
import { XIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  Sheet,
  SheetDescription,
  SheetOverlay,
  SheetPortal,
  SheetTitle,
} from "@/components/ui/sheet";
import { cn } from "@/lib/utils";

/**
 * Close policy shared by every drawer: Esc, the scrim, × and Cancel all call `request`. Busy ignores it; dirty
 * shows the discard step inside the same drawer (Esc there keeps editing); clean closes with the exit motion.
 */
export function useDrawerClose({ dirty = false, busy = false }: { dirty?: boolean; busy?: boolean } = {}) {
  // Mounted closed and opened on the next commit: Base UI animates only an open transition, not an initial open.
  const [open, setOpen] = useState(false);
  useEffect(() => setOpen(true), []);
  const [discarding, setDiscarding] = useState(false);
  const resume = useRef<HTMLElement | null>(null);
  return {
    open,
    discarding,
    /** Where focus returns when the discard step is dismissed. */
    resume,
    request() {
      if (busy) return;
      if (discarding) return setDiscarding(false);
      if (!dirty) return setOpen(false);
      resume.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
      setDiscarding(true);
    },
    keep: () => setDiscarding(false),
    discard: () => setOpen(false),
  };
}
export type DrawerClose = ReturnType<typeof useDrawerClose>;

const tabbable =
  ":is(input, button, select, textarea, a[href], [tabindex]):not([disabled], [tabindex='-1'], [aria-hidden='true'])";

/**
 * The right-edge drawer (UI v2 drawer contract): full height below the titlebar (`--titlebar-height`), fixed header
 * and footer, scrolling body, scrim, focus trapped and returned to the opener. Keys typed here stay here (focus never
 * leaves), so nothing reaches a terminal. `onClose` runs once the exit motion has finished; a caller that can reopen
 * the same kind should key each open so a closing instance is never reused. `alert` is for confirmation-only
 * drawers: role alertdialog and no dismissal by the scrim.
 */
export function Drawer({
  close,
  onClose,
  title,
  target,
  description,
  footer,
  discardText = "Your changes will be lost.",
  alert = false,
  className,
  children,
  ...props
}: Omit<ComponentProps<typeof DialogPrimitive.Popup>, "title" | "children"> & {
  close: DrawerClose;
  onClose(): void;
  title: ReactNode;
  /** What the drawer acts on (name, address, PROD badge); shown under the title. */
  target?: ReactNode;
  description?: ReactNode;
  /** Cancel and the primary action for the current step. */
  footer: ReactNode;
  discardText?: string;
  alert?: boolean;
  children: ReactNode;
}) {
  const keep = useRef<HTMLButtonElement>(null);
  const heading = useId();
  const body = useRef<HTMLDivElement>(null);
  const wasDiscarding = useRef(false);
  useEffect(() => {
    if (close.discarding) keep.current?.focus();
    else if (wasDiscarding.current) {
      const saved = close.resume.current;
      // The saved field can be gone (a step changed meanwhile): fall back to the first control in the body.
      const target = saved?.isConnected && body.current?.contains(saved) ? saved : body.current?.querySelector<HTMLElement>(tabbable);
      target?.focus();
    }
    wasDiscarding.current = close.discarding;
  }, [close.discarding, close.resume]);
  return (
    <Sheet
      open={close.open}
      disablePointerDismissal={alert}
      onOpenChange={(open) => {
        if (!open) close.request();
      }}
      onOpenChangeComplete={(open) => {
        if (!open) onClose();
      }}
    >
      <SheetPortal>
        <SheetOverlay className="bg-black/40 duration-200 supports-backdrop-filter:backdrop-blur-none" />
        <DialogPrimitive.Popup
          data-slot="drawer"
          {...(alert ? { role: "alertdialog" } : {})}
          className={cn(
            "fixed top-(--titlebar-height) right-0 bottom-0 z-50 flex w-full max-w-[520px] flex-col border-l bg-card text-sm text-card-foreground shadow-lg outline-none [overflow-wrap:anywhere]",
            "transition-[translate,opacity] duration-200 ease-out data-ending-style:translate-x-full data-ending-style:opacity-0 data-starting-style:translate-x-full data-starting-style:opacity-0 motion-reduce:transition-none",
            className,
          )}
          {...props}
        >
          <div className="grid gap-1 border-b py-4 pr-12 pl-5">
            <SheetTitle className="text-base">{title}</SheetTitle>
            {target ? (
              <div className="flex min-w-0 flex-wrap items-center gap-2 text-muted-foreground">{target}</div>
            ) : null}
            {description ? <SheetDescription>{description}</SheetDescription> : null}
          </div>
          <div ref={body} className="grid min-h-0 flex-1 content-start gap-4 overflow-y-auto px-5 py-4">
            {close.discarding ? (
              <div role="alert" aria-labelledby={heading} className="grid gap-1">
                <h3 id={heading} className="font-medium text-foreground">
                  Discard unsaved changes?
                </h3>
                <p className="text-muted-foreground">{discardText}</p>
              </div>
            ) : null}
            {/* Hidden, not unmounted: the draft and scroll position survive Keep editing. */}
            <div className={cn("grid min-w-0 gap-4", close.discarding && "hidden")}>
              {children}
            </div>
          </div>
          <div className="flex flex-wrap justify-end gap-2 border-t px-5 py-4">
            {close.discarding ? (
              <>
                <Button ref={keep} variant="outline" onClick={close.keep}>
                  Keep editing
                </Button>
                <Button variant="destructive" onClick={close.discard}>
                  Discard
                </Button>
              </>
            ) : (
              footer
            )}
          </div>
          {/* Last in tab order, so focus enters at the first field. */}
          <DialogPrimitive.Close
            render={<Button variant="ghost" size="icon-sm" className="absolute top-3.5 right-3" />}
          >
            <XIcon />
            <span className="sr-only">Close</span>
          </DialogPrimitive.Close>
        </DialogPrimitive.Popup>
      </SheetPortal>
    </Sheet>
  );
}
