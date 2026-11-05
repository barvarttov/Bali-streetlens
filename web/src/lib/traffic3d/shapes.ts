// Vehicle meshes shared by the public map's vehicle layer and the team tool's 3D twin.
// Uses Three.js, so unlike lanes.ts and sim.ts it is not imported by the Node tests.

import { BoxGeometry, BufferGeometry, Float32BufferAttribute } from "three";
import { mergeGeometries } from "three/addons/utils/BufferGeometryUtils.js";
import type { VehicleClass } from "../schema.ts";

/** A box part: [length (x), height (y), width (z)], its centre, and a shade multiplied into the colour. */
type Part = { size: [number, number, number]; at: [number, number, number]; shade: number };

// Simple, anonymous shapes, built along +x (direction of travel), standing on y = 0.
export const SHAPES: Record<VehicleClass, Part[]> = {
  motorcycle: [
    { size: [1.9, 0.55, 0.5], at: [0, 0.55, 0], shade: 1 },
    { size: [0.5, 0.75, 0.45], at: [-0.15, 1.2, 0], shade: 0.72 }, // rider
  ],
  car: [
    { size: [4.3, 0.8, 1.8], at: [0, 0.6, 0], shade: 1 },
    { size: [2.3, 0.55, 1.6], at: [-0.2, 1.27, 0], shade: 0.72 },
  ],
  bus: [
    { size: [11, 2.6, 2.5], at: [0, 1.6, 0], shade: 1 },
    { size: [11, 0.35, 2.5], at: [0, 3.07, 0], shade: 0.72 },
  ],
  truck: [
    { size: [5.4, 3.0, 2.4], at: [-1.05, 1.8, 0], shade: 1 }, // cargo box
    { size: [2.0, 2.4, 2.4], at: [2.7, 1.5, 0], shade: 0.72 }, // cab
  ],
};

/** One merged geometry per class, with a per-vertex shade in the colour attribute. */
export function shapeGeometry(cls: VehicleClass): BufferGeometry {
  const geos = SHAPES[cls].map((p) => {
    const g = new BoxGeometry(...p.size).toNonIndexed();
    g.translate(...p.at);
    const n = g.getAttribute("position").count;
    g.setAttribute("color", new Float32BufferAttribute(new Array(n * 3).fill(p.shade), 3));
    return g;
  });
  const merged = mergeGeometries(geos) as BufferGeometry;
  for (const g of geos) g.dispose();
  return merged;
}
