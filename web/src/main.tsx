import { StrictMode, Suspense, lazy } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/archivo/wdth.css";
import "./styles/tokens.css";
import { LangProvider } from "./i18n.tsx";
import { usePath } from "./router.ts";

// The public map and the team tools are separate bundles: visitors never download the team tools,
// and the team tools never load MapLibre.
const PublicApp = lazy(() => import("./public/PublicApp.tsx").then((m) => ({ default: m.PublicApp })));
const TeamApp = lazy(() => import("./tools/TeamApp.tsx").then((m) => ({ default: m.TeamApp })));
const LivePage = lazy(() => import("./live/LivePage.tsx").then((m) => ({ default: m.LivePage })));

function Root() {
  const path = usePath();
  return (
    <LangProvider>
      <Suspense fallback={null}>
        {path === "/tim" || path.startsWith("/tim/") ? (
          <TeamApp />
        ) : path === "/langsung" || path.startsWith("/langsung/") ? (
          <LivePage />
        ) : (
          <PublicApp />
        )}
      </Suspense>
    </LangProvider>
  );
}

createRoot(document.getElementById("root")!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
