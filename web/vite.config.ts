import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";

// In dev, the FastAPI backend (port 8000) serves /api and /video; Vite proxies to it.
// For the demo, `npm run build` and let FastAPI serve web/dist, so it's a single process.
const backend = "http://127.0.0.1:8000";

// `npm run dev` also starts the backend (uvicorn --reload), so one command runs everything.
// Skipped if something already answers on :8000, or with BACKEND=off.
function startBackend(): Plugin {
  return {
    name: "start-backend",
    apply: "serve",
    async configureServer() {
      const g = globalThis as { __backend?: ChildProcess };
      if (process.env.BACKEND === "off" || g.__backend) return;
      try {
        await fetch(`${backend}/api/health`, { signal: AbortSignal.timeout(800) });
        console.log("[api] backend already running on :8000, not starting another");
        return;
      } catch {
        // nothing listening: start it
      }
      const root = fileURLToPath(new URL("..", import.meta.url));
      const win = process.platform === "win32";
      const python = root + (win ? ".venv/Scripts/python.exe" : ".venv/bin/python");
      if (!existsSync(python)) {
        console.warn(`[api] ${python} not found: create the venv (see README), the map will have no data`);
        return;
      }
      const child = spawn(
        python,
        ["-m", "uvicorn", "backend.main:app", "--port", "8000", "--reload", "--reload-dir", "backend"],
        { cwd: root, stdio: "inherit" },
      );
      g.__backend = child;
      const stop = () => {
        if (child.exitCode !== null || !child.pid) return;
        // --reload runs a worker child; on Windows only a tree kill takes both down.
        if (win) spawnSync("taskkill", ["/pid", String(child.pid), "/T", "/F"], { stdio: "ignore" });
        else child.kill();
      };
      process.once("exit", stop);
      for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
        process.once(sig, () => {
          stop();
          process.exit();
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), startBackend()],
  // MapLibre alone is ~1 MB minified (~250 KB gzip) and lives in the lazily loaded public chunk.
  build: { chunkSizeWarningLimit: 1200 },
  server: {
    port: 5173,
    open: true,
    proxy: {
      "/api": backend,
      "/video": backend,
      "/tiles": backend,
    },
  },
});
