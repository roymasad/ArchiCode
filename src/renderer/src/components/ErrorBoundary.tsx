import { t } from "@renderer/i18n";
import { Component, type ErrorInfo, type ReactNode } from "react";

type ErrorBoundaryState = {
  error: Error | null;
};

export class ErrorBoundary extends Component<{ children: ReactNode }, ErrorBoundaryState> {
  state: ErrorBoundaryState = {
    error: null
  };

  static getDerivedStateFromError(error: Error): ErrorBoundaryState {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    console.error("ArchiCode renderer error", error, info.componentStack);
  }

  render() {
    if (!this.state.error) return this.props.children;

    return (
      <main className="fatal-screen">
        <section>
          <h1>{t("ArchiCode hit a renderer error")}</h1>
          <p>{this.state.error.message}</p>
          <pre>{this.state.error.stack}</pre>
        </section>
      </main>
    );
  }
}
