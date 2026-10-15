import { useId } from "react";
import {
  HostIdentity,
  type HostTarget,
} from "@/components/connection/host-identity";
import { Button } from "@/components/ui/button";
import {
  Field,
  FieldDescription,
  FieldGroup,
  FieldLabel,
} from "@/components/ui/field";
import { Textarea } from "@/components/ui/textarea";

export function SnippetComposer({ target }: { target: HostTarget }) {
  const id = useId();
  return (
    <section className="snippet-composer" aria-label="Snippet composer fixture">
      <div className="flex flex-wrap items-center justify-between gap-3">
        <h3>Snippet composer</h3>
        <HostIdentity target={target} />
      </div>
      <FieldGroup>
        <Field>
          <FieldLabel htmlFor={id}>Pending command · fixture</FieldLabel>
          <Textarea
            id={id}
            defaultValue="uptime"
            spellCheck={false}
            aria-describedby={`${id}-help`}
          />
          <FieldDescription id={`${id}-help`}>
            Paste prepares text for review. Run sends it to the captured target.
            Execution is unavailable in this preview.
          </FieldDescription>
        </Field>
      </FieldGroup>
      <div className="flex gap-2">
        <Button variant="outline" disabled>
          Paste to composer
        </Button>
        <Button disabled>Run on {target.name}</Button>
      </div>
    </section>
  );
}
