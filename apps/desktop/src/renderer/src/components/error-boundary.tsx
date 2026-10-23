import { Component, type ReactNode } from "react";

/**
 * SST-043 review H1: a render error stays inside the component that threw it. The fallback replaces only that part;
 * `reset` tries it again. Nothing about the error is shown (agent text may be part of it).
 */
export class ErrorBoundary extends Component<{ fallback: (reset: () => void) => ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };
  static getDerivedStateFromError() { return { failed: true }; }
  override render() { return this.state.failed ? this.props.fallback(() => this.setState({ failed: false })) : this.props.children; }
}
