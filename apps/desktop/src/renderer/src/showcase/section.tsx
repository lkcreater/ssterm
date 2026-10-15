import type { ReactNode } from "react";
export function Section({
  id,
  title,
  description,
  children,
}: {
  id: string;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section
      id={id}
      className="showcase-section"
      aria-labelledby={`${id}-heading`}
    >
      <div className="flex flex-col gap-2">
        <h2 id={`${id}-heading`}>{title}</h2>
        <p className="fixture-caption">{description}</p>
      </div>
      {children}
    </section>
  );
}
export function Example({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <div className="showcase-example">
      <h3>{title}</h3>
      {children}
    </div>
  );
}
