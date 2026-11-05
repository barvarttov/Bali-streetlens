// Where the live-camera API lives. On the hosted site (Vercel) there is no AGA, so the page can be pointed at the
// vision machine through a tunnel: open the site once with ?api=https://<name>.trycloudflare.com and it is remembered
// in this browser. Only Cloudflare tunnels and localhost are accepted, so a crafted link cannot send the page elsewhere.

const KEY = "streetlens-live-api";
const ALLOWED = /^https:\/\/[a-z0-9-]+\.trycloudflare\.com$|^http:\/\/(localhost|127\.0\.0\.1):\d+$/;

function clean(value: string | null | undefined): string {
  const v = (value ?? "").trim().replace(/\/+$/, "");
  return ALLOWED.test(v) ? v : "";
}

function stored(): string {
  try {
    return clean(window.localStorage.getItem(KEY));
  } catch {
    return "";
  }
}

export function liveApiBase(): string {
  try {
    const q = new URLSearchParams(window.location.search).get("api");
    if (q === "") window.localStorage.removeItem(KEY); // ?api= (empty) goes back to the site's own API
    const fromLink = clean(q);
    if (fromLink) {
      window.localStorage.setItem(KEY, fromLink);
      return fromLink;
    }
  } catch {
    /* storage blocked: fall through */
  }
  return stored() || clean(import.meta.env.VITE_LIVE_API as string | undefined);
}

export const liveApi = (path: string): string => `${liveApiBase()}${path}`;
