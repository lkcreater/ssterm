import {
  failure,
  isPingRequest,
  isOwner,
  isStorageHealth,
  type BootstrapData,
  type Owner,
  type Result,
  type StorageHealth,
  type WindowStateEvent,
} from "@ssterm/contracts";

export interface FrameIdentity {
  readonly url: string;
}
export interface SenderIdentity {
  readonly id: number;
  readonly mainFrame: FrameIdentity;
  isDestroyed(): boolean;
}
export interface Invocation {
  sender: SenderIdentity;
  senderFrame: FrameIdentity | null;
}
interface Registration {
  sender: SenderIdentity;
  owner: Owner;
  focused: boolean;
  sequence: number;
  send: (event: WindowStateEvent) => void;
}

/** A fragment changes local UI state, not the document authorized to use IPC. */
export function sameDocument(actual: string, expected: string): boolean {
  try {
    const url = new URL(actual);
    url.hash = "";
    return url.href === expected;
  } catch {
    return false;
  }
}

/** Owns only registered application windows; matching a file URL alone grants nothing. */
export class WindowBoundary {
  private readonly windows = new Map<number, Registration>();
  private generation = 0;
  private disposed = false;

  constructor(
    private readonly entryURL: string,
    private readonly app: BootstrapData["app"],
    private readonly getStorageHealth: () => StorageHealth,
    private readonly onOwnerRevoked: (owner: Owner) => void = () => {},
  ) {}

  register(
    sender: SenderIdentity,
    windowId: number,
    focused: boolean,
    send: Registration["send"],
  ): () => void {
    if (this.disposed || this.windows.has(sender.id))
      throw new Error("Window registration unavailable");
    const registration: Registration = {
      sender,
      owner: { windowId, generation: ++this.generation },
      focused,
      sequence: 0,
      send,
    };
    this.windows.set(sender.id, registration);
    return () => {
      if (this.windows.get(sender.id) === registration) {
        this.windows.delete(sender.id);
        this.revokeOwner(registration.owner);
      }
    };
  }

  rotate(sender: SenderIdentity): void {
    const registration = this.windows.get(sender.id);
    if (registration?.sender !== sender) return;
    const previous = registration.owner;
    registration.owner = {
      ...registration.owner,
      generation: ++this.generation,
    };
    registration.sequence = 0;
    this.revokeOwner(previous);
  }

  /** The current owner of a registered window, for main-initiated work such as the close guard. */
  ownerOf(sender: SenderIdentity): Owner | undefined {
    const registration = this.windows.get(sender.id);
    return !this.disposed && registration?.sender === sender ? { ...registration.owner } : undefined;
  }

  focus(sender: SenderIdentity, focused: boolean): void {
    const registration = this.windows.get(sender.id);
    if (
      !registration ||
      registration.sender !== sender ||
      sender.isDestroyed() ||
      registration.focused === focused
    )
      return;
    registration.focused = focused;
    registration.sequence += 1;
    if (!sameDocument(sender.mainFrame.url, this.entryURL)) return;
    registration.send({
      owner: { ...registration.owner },
      sequence: registration.sequence,
      type: "focus-changed",
      focused,
    });
  }

  private authorize(event: Invocation): Result<Registration> {
    if (this.disposed) return failure("unavailable");
    const registration = this.windows.get(event.sender.id);
    if (
      !registration ||
      registration.sender !== event.sender ||
      event.sender.isDestroyed() ||
      !event.senderFrame ||
      event.senderFrame !== event.sender.mainFrame ||
      !sameDocument(event.senderFrame.url, this.entryURL)
    )
      return failure("unauthorized");
    return { ok: true, value: registration };
  }

  authorizeOwner(event: Invocation, owner: unknown): Result<Owner> {
    const authorized = this.authorize(event);
    if (!authorized.ok) return authorized;
    if (!isOwner(owner)) return failure("invalid-request");
    if (owner.windowId !== authorized.value.owner.windowId)
      return failure("unauthorized");
    if (owner.generation !== authorized.value.owner.generation)
      return failure("stale-owner");
    return { ok: true, value: { ...authorized.value.owner } };
  }

  bootstrap(event: Invocation, args: unknown[]): Result<BootstrapData> {
    const authorized = this.authorize(event);
    if (!authorized.ok) return authorized;
    if (args.length !== 0) return failure("invalid-request");
    const storage = this.getStorageHealth();
    if (!isStorageHealth(storage)) return failure("unavailable");
    const window = authorized.value;
    return {
      ok: true,
      value: {
        app: { ...this.app },
        owner: { ...window.owner },
        window: { focused: window.focused, sequence: window.sequence },
        storage: { ...storage },
      },
    };
  }

  ping(
    event: Invocation,
    args: unknown[],
  ): Result<{ requestId: string; ready: true }> {
    const authorized = this.authorize(event);
    if (!authorized.ok) return authorized;
    if (args.length !== 1 || !isPingRequest(args[0]))
      return failure("invalid-request");
    const request = args[0];
    if (request.owner.windowId !== authorized.value.owner.windowId)
      return failure("unauthorized");
    if (request.owner.generation !== authorized.value.owner.generation)
      return failure("stale-owner");
    return { ok: true, value: { requestId: request.requestId, ready: true } };
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    const owners = [...this.windows.values()].map((entry) => entry.owner);
    this.windows.clear();
    for (const owner of owners) this.revokeOwner(owner);
  }

  private revokeOwner(owner: Owner): void {
    try {
      this.onOwnerRevoked({ ...owner });
    } catch {
      // An observer cannot restore an already revoked IPC registration.
    }
  }
}
