import { StrictMode, Suspense, lazy, useEffect } from "react";
import { createRoot } from "react-dom/client";
import "@fontsource-variable/archivo/wdth.css";
import "./styles/tokens.css";
import { LangProvider } from "./i18n.tsx";
import { navigate, usePath } from "./router.ts";

// The public map and the team tools are separate bundles: visitors never download the team tools,
// and the team tools never load MapLibre.
const PublicApp = lazy(() => import("./public/PublicApp.tsx").then((m) => ({ default: m.PublicApp })));
const TeamApp = lazy(() => import("./tools/TeamApp.tsx").then((m) => ({ default: m.TeamApp })));

function Root() {
  const path = usePath();
  // The old separate live page now lives on the map: /langsung opens the map (live cameras are always on
  // it) and /langsung/<id> opens that camera there, so links already shared keep working.
  const legacyLive = path === "/langsung" || path.startsWith("/langsung/");
  useEffect(() => {
    if (!legacyLive) return;
    const id = path.slice("/langsung/".length);
    navigate(`${id ? `/kamera/${id}` : "/"}${window.location.search}`, { replace: true }); // keeps ?api= (tunnel)
  }, [legacyLive, path]);
  return (
    <LangProvider>
      <Suspense fallback={null}>
        {path === "/tim" || path.startsWith("/tim/") ? (
          <TeamApp />
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
