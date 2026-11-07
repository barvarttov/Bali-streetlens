import { Component } from "react";
import type { ErrorInfo, ReactNode } from "react";

// Never a white page. After a deploy, a tab opened earlier asks for scripts that no longer exist: the page
// then reloads itself once (sessionStorage guards against a loop). Any other crash shows what went wrong
// and a reload button, so a visitor can recover and a teammate can report the message.

const RELOAD_KEY = "streetlens-reloaded-after-deploy";

function reloadOnce(): boolean {
  try {
    if (sessionStorage.getItem(RELOAD_KEY)) return false;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {
    return false; // storage blocked: show the message instead of risking a loop
  }
  window.location.reload();
  return true;
}

/** Vite fires this when a lazily loaded script fails to load (an old build hash after a deploy). */
export function installStaleBuildReload(): void {
  window.addEventListener("vite:preloadError", (event) => {
    if (reloadOnce()) event.preventDefault();
  });
  // A page that rendered fine clears the guard, so the next deploy can reload again.
  window.setTimeout(() => {
    try {
      sessionStorage.removeItem(RELOAD_KEY);
    } catch {
      /* ignore */
    }
  }, 10_000);
}

const isChunkError = (err: Error) =>
  /dynamically imported module|Importing a module script failed|Failed to fetch|MIME type|preload/i.test(err.message);

export class AppErrorBoundary extends Component<{ children: ReactNode }, { error: Error | null }> {
  state = { error: null as Error | null };

  static getDerivedStateFromError(error: Error) {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    if (isChunkError(error) && reloadOnce()) return;
    console.error("StreetLens crashed", error, info.componentStack);
  }

  render() {
    const { error } = this.state;
    if (!error) return this.props.children;
    const id = (document.documentElement.lang || "id").startsWith("id");
    return (
      <main
        role="alert"
        style={{
          minHeight: "100dvh",
          display: "grid",
          placeContent: "center",
          gap: 12,
          padding: 24,
          maxWidth: 520,
          margin: "0 auto",
          fontFamily: "var(--font, system-ui, sans-serif)",
          color: "var(--text, #15181B)",
          background: "var(--paper, #FFFFFF)",
        }}
      >
        <h1 style={{ margin: 0, fontSize: 22 }}>{id ? "Halaman gagal dimuat" : "The page failed to load"}</h1>
        <p style={{ margin: 0, lineHeight: 1.5 }}>
          {id
            ? "Biasanya karena situs baru saja diperbarui. Muat ulang halaman ini."
            : "Usually because the site was just updated. Reload this page."}
        </p>
        <button
          type="button"
          onClick={() => window.location.reload()}
          style={{
            justifySelf: "start",
            minHeight: 44,
            padding: "0 18px",
            border: "1px solid var(--ink, #606C38)",
            background: "var(--ink, #606C38)",
            color: "#FFFFFF",
            font: "700 15px/1 var(--font, system-ui, sans-serif)",
            cursor: "pointer",
          }}
        >
          {id ? "Muat ulang" : "Reload"}
        </button>
        <p style={{ margin: 0, fontSize: 13, color: "var(--ink-2, #4E555B)", overflowWrap: "anywhere" }}>
          {id ? "Detail untuk tim:" : "Detail for the team:"} {error.message}
        </p>
      </main>
    );
  }
}
