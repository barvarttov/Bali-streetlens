import type { ClipStatus } from "../lib/schema.ts";

// Clip status (team tools). Monochrome on purpose: red and yellow are reserved for traffic state.
const LABELS: Record<ClipStatus, string> = {
  analyzed: "Rekaman dianalisis",
  synthetic: "Data sintetis",
  stale: "Analisis usang",
  unavailable: "Tidak tersedia",
};

export function StatusBadge({ status, reason }: { status: ClipStatus; reason: string }) {
  return (
    <span className={`clip-badge is-${status}`} title={reason} role="status">
      <span className="clip-badge-dot" aria-hidden="true" />
      {LABELS[status]}
    </span>
  );
}
