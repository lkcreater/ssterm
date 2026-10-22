import type { ReactNode, Ref } from "react";
import { cn } from "@/lib/utils";

/**
 * The v2 page header: title and subtitle on the left, the page's primary actions on the right
 * (wrapping below on a narrow window). `children` adds a row under it, such as the terminal tabs.
 * The heading is focusable so a page can land focus on it after removing the focused control.
 */
export function PageHeader({
  title,
  subtitle,
  actions,
  headingRef,
  className,
  children,
}: {
  title: ReactNode;
  subtitle: ReactNode;
  actions?: ReactNode;
  headingRef?: Ref<HTMLHeadingElement>;
  className?: string;
  children?: ReactNode;
}) {
  return (
    <div className={cn("page-header", className)}>
      <div className="page-header-row">
        <div className="page-header-text">
          <h2 ref={headingRef} tabIndex={-1} className="type-title min-w-0 break-words">{title}</h2>
          <p className="page-subtitle">{subtitle}</p>
        </div>
        {actions ? <div className="page-header-actions">{actions}</div> : null}
      </div>
      {children}
    </div>
  );
}
