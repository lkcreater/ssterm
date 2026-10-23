import { lazy, StrictMode, Suspense } from "react";
import { createRoot } from "react-dom/client";
import { AppShell } from "@/components/app-shell";
import { AppLockGate } from "@/components/app-lock/app-lock-gate";
import { TooltipProvider } from "@/components/ui/tooltip";
import { Toaster } from "@/components/ui/toast";
import { Spinner } from "@/components/ui/spinner";
import { Button } from "@/components/ui/button";
import { ErrorBoundary } from "@/components/error-boundary";
import "@/styles/globals.css";

// Vite removes the import and fixture catalog from production bundles.
const Showcase = import.meta.env.DEV ? lazy(() => import("@/showcase")) : null;
const showCatalog =
  import.meta.env.DEV && location.hash === "#showcase" && Showcase;
const root = document.getElementById("root");
if (!root) throw new Error("Application root is unavailable.");
createRoot(root).render(
  <StrictMode>
    <TooltipProvider delay={300}>
      <Toaster>
        {showCatalog ? (
          <Suspense
            fallback={
              <div className="flex h-full items-center justify-center gap-2">
                <Spinner /> Opening component showcase
              </div>
            }
          >
            <Showcase />
          </Suspense>
        ) : (
          // SST-043 review H1: no single render error leaves an empty window.
          <ErrorBoundary fallback={(reset) => (
            <div role="alert" className="flex h-full flex-col items-center justify-center gap-3 p-6 text-center" data-testid="app-error">
              <p className="type-label">Something went wrong while showing this window.</p>
              <p className="max-w-md type-caption text-muted-foreground">Try showing it again.</p>
              <Button size="sm" onClick={reset}>Try again</Button>
            </div>
          )}>
            <AppLockGate>
              <AppShell />
            </AppLockGate>
          </ErrorBoundary>
        )}
      </Toaster>
    </TooltipProvider>
  </StrictMode>,
);
