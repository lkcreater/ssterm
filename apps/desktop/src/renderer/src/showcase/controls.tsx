import { SearchIcon, ServerIcon, CheckIcon } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Input } from "@/components/ui/input";
import {
  InputGroup,
  InputGroupAddon,
  InputGroupInput,
} from "@/components/ui/input-group";
import { Textarea } from "@/components/ui/textarea";
import { Checkbox } from "@/components/ui/checkbox";
import { Switch } from "@/components/ui/switch";
import {
  Field,
  FieldDescription,
  FieldError,
  FieldGroup,
  FieldLabel,
  FieldLegend,
  FieldSet,
  FieldTitle,
} from "@/components/ui/field";
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "@/components/ui/select";
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
} from "@/components/ui/combobox";
import { Spinner } from "@/components/ui/spinner";
import { Toggle } from "@/components/ui/toggle";
import { ToggleGroup, ToggleGroupItem } from "@/components/ui/toggle-group";
import { Label } from "@/components/ui/label";
import { StateMatrix, previewState } from "./state-matrix";
import { Section, Example } from "./section";

const buttonVariants = [
  "default",
  "secondary",
  "outline",
  "ghost",
  "destructive",
  "link",
] as const;
const states = [
  "default",
  "hover",
  "active",
  "focus",
  "disabled",
  "loading",
  "error",
];
const groups = [
  { label: "Development", value: "dev" },
  { label: "Staging", value: "stage" },
  { label: "Production", value: "prod" },
];
const hostGroups = [
  "Development",
  "Staging",
  "Production",
  "ระบบงานภาษาไทย · ชื่อกลุ่มยาวสำหรับทดสอบ",
];

export function Controls() {
  return (
    <>
      <Section
        id="actions"
        title="Actions & state matrices"
        description="Pinned hover, pressed and focus use the same variants as real interactions. Loading controls stay disabled. Examples only change local fixture state."
      >
        <StateMatrix
          rows={buttonVariants}
          states={states}
          render={(variant, state) => (
            <Button
              variant={variant}
              {...previewState(state)}
              disabled={state === "disabled" || state === "loading"}
              aria-invalid={state === "error" || undefined}
            >
              {state === "loading" ? (
                <Spinner data-icon="inline-start" />
              ) : null}
              Save host
            </Button>
          )}
        />
        <div className="showcase-grid">
          <Example title="Sizes & icons">
            <div className="flex flex-wrap items-center gap-2">
              <Button size="xs">Save host</Button>
              <Button size="sm">Save host</Button>
              <Button>Save host</Button>
              <Button size="lg">Save host</Button>
            </div>
            <div className="flex gap-2">
              <Button>
                <ServerIcon data-icon="inline-start" /> Add host
              </Button>
              <Button variant="outline">
                Continue
                <CheckIcon data-icon="inline-end" />
              </Button>
              <Button size="icon" variant="outline" aria-label="Search fixture">
                <SearchIcon />
              </Button>
            </div>
          </Example>
          <Example title="Badges & long text">
            <div className="flex flex-wrap gap-2">
              <Badge>Selected</Badge>
              <Badge variant="secondary">SSH key</Badge>
              <Badge variant="outline">Local</Badge>
              <Badge variant="production">PROD</Badge>
              <Badge variant="destructive">Failed</Badge>
              <Badge variant="fixture">Fixture</Badge>
            </div>
            <p className="type-caption break-all">
              ระบบสำรองข้อมูลในศูนย์ข้อมูล-production-ap-southeast-1
            </p>
          </Example>
        </div>
        <Example title="Toggle & grouped options">
          <div className="flex flex-wrap items-center gap-4">
            <Toggle variant="outline" aria-label="Pin fixture host">
              <ServerIcon /> Pin host
            </Toggle>
            <ToggleGroup
              defaultValue={["terminal"]}
              variant="outline"
              aria-label="Fixture workspace view"
            >
              <ToggleGroupItem value="terminal">Terminal</ToggleGroupItem>
              <ToggleGroupItem value="files">Files</ToggleGroupItem>
            </ToggleGroup>
          </div>
        </Example>
      </Section>
      <Section
        id="inputs"
        title="Inputs & validation"
        description="Fields have persistent labels, accessible descriptions and explicit error text. No example stores or contains real secrets."
      >
        <StateMatrix
          rows={["input"] as const}
          states={["default", "hover", "active", "focus", "disabled", "error"]}
          render={(_, state) => (
            <Input
              aria-label={`Hostname ${state} fixture`}
              defaultValue="lab.ssterm.invalid"
              {...previewState(state)}
              aria-invalid={state === "error" || undefined}
            />
          )}
        />
        <div className="showcase-grid">
          <Example title="Host fields & Thai input">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="thai-host-name">
                  Host display name
                </FieldLabel>
                <Input
                  id="thai-host-name"
                  placeholder="เช่น ระบบทดสอบกรุงเทพฯ"
                  autoComplete="off"
                />
                <FieldDescription>
                  Thai and long labels use the offline fallback font.
                </FieldDescription>
              </Field>
              <Field>
                <FieldLabel htmlFor="fixture-search">Search hosts</FieldLabel>
                <InputGroup>
                  <InputGroupAddon>
                    <SearchIcon aria-hidden="true" />
                  </InputGroupAddon>
                  <InputGroupInput
                    id="fixture-search"
                    placeholder="Name, group or tag"
                  />
                </InputGroup>
              </Field>
              <Field data-invalid>
                <FieldLabel htmlFor="invalid-port">Port</FieldLabel>
                <Input
                  id="invalid-port"
                  defaultValue="70000"
                  aria-invalid
                  aria-describedby="port-error"
                />
                <FieldError id="port-error">
                  Use a port from 1 to 65535.
                </FieldError>
              </Field>
              <Field data-disabled>
                <FieldLabel htmlFor="disabled-secret">Password</FieldLabel>
                <Input
                  id="disabled-secret"
                  type="password"
                  placeholder="Hidden"
                  disabled
                  autoComplete="off"
                />
                <FieldDescription>
                  Secret entry is unavailable.
                </FieldDescription>
              </Field>
            </FieldGroup>
          </Example>
          <Example title="Select, combobox & notes">
            <FieldGroup>
              <Field>
                <FieldLabel htmlFor="fixture-environment">
                  Environment
                </FieldLabel>
                <Select items={groups} defaultValue="dev">
                  <SelectTrigger id="fixture-environment" className="w-full">
                    <SelectValue />
                  </SelectTrigger>
                  <SelectContent alignItemWithTrigger={false}>
                    <SelectGroup>
                      {groups.map((group) => (
                        <SelectItem key={group.value} value={group.value}>
                          {group.label}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  </SelectContent>
                </Select>
              </Field>
              <Field>
                <FieldLabel htmlFor="fixture-group">Host group</FieldLabel>
                <Combobox items={hostGroups}>
                  <ComboboxInput
                    id="fixture-group"
                    placeholder="Find a group"
                    showClear
                  />
                  <ComboboxContent>
                    <ComboboxEmpty>No matching groups.</ComboboxEmpty>
                    <ComboboxList>
                      {(item: string) => (
                        <ComboboxItem key={item} value={item}>
                          {item}
                        </ComboboxItem>
                      )}
                    </ComboboxList>
                  </ComboboxContent>
                </Combobox>
              </Field>
              <Field>
                <FieldLabel htmlFor="fixture-notes">Notes</FieldLabel>
                <Textarea
                  id="fixture-notes"
                  defaultValue="Project-owned lab only.\nชื่อเซิร์ฟเวอร์ยาวยังอ่านได้"
                />
              </Field>
            </FieldGroup>
          </Example>
          <Example title="Checkboxes & switches">
            <FieldSet>
              <FieldLegend variant="label">Fixture preferences</FieldLegend>
              <FieldDescription>
                These settings only affect the specimen.
              </FieldDescription>
              <FieldGroup>
                <Field orientation="horizontal">
                  <Checkbox id="fixture-notify" defaultChecked />
                  <FieldLabel htmlFor="fixture-notify">
                    Show connection notices
                  </FieldLabel>
                </Field>
                <Field orientation="horizontal">
                  <Switch id="fixture-loopback" defaultChecked />
                  <FieldLabel htmlFor="fixture-loopback">
                    Bind to loopback
                  </FieldLabel>
                </Field>
                <Field orientation="horizontal" data-disabled>
                  <Switch id="fixture-sync" disabled />
                  <FieldLabel htmlFor="fixture-sync">
                    Team sync unavailable
                  </FieldLabel>
                </Field>
              </FieldGroup>
            </FieldSet>
            <Label htmlFor="fixture-label">Standalone label specimen</Label>
            <Input id="fixture-label" placeholder="Lab identity" />
          </Example>
        </div>
        <StateMatrix
          rows={["checkbox", "switch", "toggle"] as const}
          states={["default", "hover", "active", "focus", "disabled", "error"]}
          render={(row, state) =>
            row === "checkbox" ? (
              <Checkbox
                aria-label={`Checkbox ${state} fixture`}
                {...previewState(state)}
                aria-invalid={state === "error" || undefined}
              />
            ) : row === "switch" ? (
              <Switch
                aria-label={`Switch ${state} fixture`}
                {...previewState(state)}
                aria-invalid={state === "error" || undefined}
              />
            ) : (
              <Toggle
                variant="outline"
                aria-label={`Toggle ${state} fixture`}
                {...previewState(state)}
                aria-invalid={state === "error" || undefined}
              >
                Pin host
              </Toggle>
            )
          }
        />
        <Example title="Textarea states">
          <StateMatrix
            rows={["textarea"] as const}
            states={["default", "focus", "disabled", "error"]}
            render={(_, state) => (
              <Textarea
                aria-label={`Notes ${state} fixture`}
                defaultValue="Lab notes"
                {...previewState(state)}
                aria-invalid={state === "error" || undefined}
              />
            )}
          />
        </Example>
        <Example title="Selection is distinct from keyboard focus">
          <FieldGroup>
            <Field>
              <FieldTitle>Do</FieldTitle>
              <div className="flex items-center gap-3">
                <Button variant="secondary" data-preview="focus">
                  Selected host
                </Button>
                <span className="fixture-caption">
                  Selection fill plus a separate solid outline.
                </span>
              </div>
            </Field>
            <Field>
              <FieldTitle className="text-destructive">Avoid</FieldTitle>
              <p className="fixture-caption">
                Do not use a blue fill alone to claim keyboard focus or
                connectivity.
              </p>
            </Field>
          </FieldGroup>
        </Example>
      </Section>
    </>
  );
}
