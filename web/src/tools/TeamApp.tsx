import { useEffect, useState } from "react";
import { StatusBadge } from "../components/StatusBadge.tsx";
import { errorMessage, fetchClips } from "../lib/api.ts";
import type { ClipInfo } from "../lib/schema.ts";
import { matchPath, navigate, usePath } from "../router.ts";
import { CalibrationTool } from "./CalibrationTool.tsx";
import { CountLogger } from "./CountLogger.tsx";
import { ReplayTool } from "./ReplayTool.tsx";
import "./team.css";
import "./calibration.css";

/** Team-only tools at /tim (not linked from the public app). Raw camera video appears only here. */
export function TeamApp() {
  const path = usePath();
  const replay = matchPath("/tim/putar/:clip", path);
  const count = matchPath("/tim/hitung/:clip", path);
  if (replay) return <ReplayTool clipId={replay.clip} />;
  if (count) return <CountLogger clipId={count.clip} />;
  if (path === "/tim/kalibrasi") return <CalibrationTool />;
  return <TeamIndex />;
}

function TeamIndex() {
  const [clips, setClips] = useState<ClipInfo[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  useEffect(() => {
    fetchClips()
      .then(setClips)
      .catch((err) => setError(errorMessage(err)));
  }, []);

  return (
    <div className="team-index">
      <header>
        <h1>Alat tim Bali StreetLens</h1>
        <p>Khusus tim. Video kamera mentah hanya muncul di sini, tidak pernah di aplikasi publik.</p>
      </header>
      <section className="team-tool">
        <div>
          <h2>Kalibrasi kamera</h2>
          <p>
            Pasangkan titik di gambar kamera dengan koordinatnya di Google Maps, lihat galatnya dalam meter, lalu gambar jalan, garis hitung, dan area antrean.
            Hasilnya file config/&lt;kamera&gt;.yaml.
          </p>
        </div>
        <button type="button" className="btn btn-primary" onClick={() => navigate("/tim/kalibrasi")}>
          Buka kalibrasi
        </button>
      </section>
      <h2 className="team-subhead">Klip</h2>
      {error && <p className="pane-warning-inline">{error}</p>}
      {clips && clips.length === 0 && <p>Belum ada klip. Jalankan analisis, atau `npm run fixture` untuk data sintetis.</p>}
      <ul className="clip-list">
        {clips?.map((c) => (
          <li key={c.id}>
            <div className="clip-head">
              <span className="clip-name">{c.id}</span>
              <StatusBadge status={c.status} reason={c.reason} />
            </div>
            <p className="clip-reason">{c.reason}</p>
            <div className="clip-actions">
              <button type="button" className="btn" onClick={() => navigate(`/tim/putar/${c.id}`)} disabled={!c.video_url}>
                Putar analisis
              </button>
              <button type="button" className="btn btn-primary" onClick={() => navigate(`/tim/hitung/${c.id}`)} disabled={!c.video_url}>
                Hitung manual
              </button>
            </div>
          </li>
        ))}
      </ul>
      <p className="team-foot">
        <a href="/">Buka aplikasi publik</a>
      </p>
    </div>
  );
}
