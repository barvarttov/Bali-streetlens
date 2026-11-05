import { test } from "node:test";
import assert from "node:assert/strict";
import { COLORS, hex, stateFill, vehicleColor } from "./palette.ts";

test("state fills follow the label", () => {
  assert.equal(stateFill("macet"), COLORS.macet);
  assert.equal(stateFill("lancar"), COLORS.lancar);
  assert.equal(stateFill("unknown"), COLORS.unknown);
});

/** WCAG contrast of two #RRGGBB colours. */
function contrast(a: string, b: string): number {
  const lum = (c: string) => {
    const [r, g, bl] = [1, 3, 5].map((i) => {
      const v = Number.parseInt(c.slice(i, i + 2), 16) / 255;
      return v <= 0.03928 ? v / 12.92 : ((v + 0.055) / 1.055) ** 2.4;
    });
    return 0.2126 * r + 0.7152 * g + 0.0722 * bl;
  };
  const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
  return (x + 0.05) / (y + 0.05);
}

test("state words and secondary ink pass AA on paper", () => {
  for (const c of [COLORS.ink, COLORS.ink2, COLORS.lancarText, COLORS.padatText, COLORS.macetText]) {
    assert.ok(contrast(c, COLORS.paper) >= 4.5, `${c} on paper is ${contrast(c, COLORS.paper).toFixed(2)}:1`);
  }
});

test("vehicle colour: moving is neutral, a stopped queue takes its state, stale is muted", () => {
  assert.equal(vehicleColor(false, "macet", false), hex(COLORS.vehicleMoving));
  assert.equal(vehicleColor(true, "macet", false), hex(COLORS.macet));
  assert.equal(vehicleColor(true, "padat", false), hex(COLORS.padat));
  assert.equal(vehicleColor(true, "lancar", false), hex(COLORS.vehicleMoving));
  assert.equal(vehicleColor(true, "macet", true), hex(COLORS.vehicleStale));
});
