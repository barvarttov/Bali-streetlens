import { useMemo } from "react";
import { useClock } from "../hooks/useClock.ts";
import { VEHICLE_CLASSES } from "../lib/schema.ts";
import type { VehicleClass } from "../lib/schema.ts";
import type { ObservationIndex } from "../lib/observations.ts";
import { CLASS_LETTER } from "./overlay.ts";

const CLASS_NAMES: Record<VehicleClass, string> = { motorcycle: "Motor", car: "Mobil", bus: "Bus", truck: "Truk" };

function emptyCounts(): Record<VehicleClass, number> {
  return { motorcycle: 0, car: 0, bus: 0, truck: 0 };
}

export function MetricsPanel({ index }: { index: ObservationIndex | null }) {
  const { frame } = useClock();

  const inView = emptyCounts();
  for (const obj of index?.byFrame[frame] ?? []) inView[obj.cls]++;

  const trackIds = useMemo(() => {
    const counts = emptyCounts();
    for (const points of index?.tracks.values() ?? []) counts[points[0].obj.cls]++;
    return counts;
  }, [index]);

  const list = (counts: Record<VehicleClass, number>) => (
    <ul className="class-list">
      {VEHICLE_CLASSES.map((cls) => (
        <li key={cls}>
          <span className="class-letter" aria-hidden="true">
            {CLASS_LETTER[cls]}
          </span>
          <span className="cls">{CLASS_NAMES[cls]}</span>
          <span className="num">{counts[cls]}</span>
        </li>
      ))}
    </ul>
  );

  return (
    <div className="metrics">
      <h2 className="panel-title">Terlihat sekarang</h2>
      {list(inView)}
      <h2 className="panel-title">ID lacak dalam klip</h2>
      {list(trackIds)}
      <p className="note">
        Bukan jumlah kendaraan: ID yang berganti di pelacak menggelembungkan angka ini. Hitungan lintas garis dan label antrean datang dari
        metrics.ts.
      </p>
      {index && index.droppedObjects > 0 && <p className="note">{index.droppedObjects} objek bukan kendaraan diabaikan.</p>}
    </div>
  );
}
