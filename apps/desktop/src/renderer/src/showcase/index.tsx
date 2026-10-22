import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Separator } from "@/components/ui/separator";
import { Foundations } from "./foundations";
import { Controls } from "./controls";
import { Navigation } from "./navigation";
import { Feedback } from "./feedback";
import { Recipes } from "./recipes";
const sections = [
  "foundations",
  "actions",
  "inputs",
  "navigation",
  "feedback",
  "recipes",
];
export default function Showcase() {
  return (
    <main className="showcase">
      <div className="showcase-inner">
        <header className="showcase-header">
          <div className="flex items-center gap-3">
            <Badge variant="fixture">Development only</Badge>
            <span className="type-caption text-muted-foreground">
              Charcoal v2 · Base UI / nova / Lucide
            </span>
          </div>
          <h1 className="type-title">ssterm component showcase</h1>
          <p className="fixture-caption">
            Foundations, components and recipes for review. Every host,
            credential, terminal and transfer is a deterministic fixture; no
            live connection or stored secret exists.
          </p>
          <nav className="flex flex-wrap gap-2" aria-label="Showcase sections">
            {sections.map((section) => (
              <Button
                key={section}
                variant="outline"
                nativeButton={false}
                render={
                  <a
                    href={`#${section}`}
                    onClick={(event) => {
                      event.preventDefault();
                      document
                        .getElementById(section)
                        ?.scrollIntoView({ behavior: "instant" });
                    }}
                  />
                }
              >
                {section}
              </Button>
            ))}
          </nav>
        </header>
        <Separator />
        <Foundations />
        <Controls />
        <Navigation />
        <Feedback />
        <Recipes />
        <footer className="fixture-caption">
          Connected with clarity. · Dark theme only · Font licenses bundled in
          /licenses. This showcase does not replace service or packaged-app
          acceptance.
        </footer>
      </div>
    </main>
  );
}
