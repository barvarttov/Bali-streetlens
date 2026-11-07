import assert from "node:assert/strict";
import { test } from "node:test";
import { glideDuration, glideFraction, lerp, MAX_GLIDE_MS, MIN_GLIDE_MS } from "./glide.ts";

test("a vehicle glides for as long as the updates are apart, so it keeps moving until the next one", () => {
  assert.equal(glideDuration(1500), 1500);
  assert.equal(glideDuration(9800), 9800);
});

test("the glide time is clamped: never a snap, never a crawl that outlives a stale feed", () => {
  assert.equal(glideDuration(50), MIN_GLIDE_MS);
  assert.equal(glideDuration(60_000), MAX_GLIDE_MS);
  assert.equal(glideDuration(Number.NaN), MIN_GLIDE_MS);
});

test("the fraction runs 0 to 1 over the glide and stays inside that range", () => {
  assert.equal(glideFraction(1000, 2000, 1000), 0);
  assert.equal(glideFraction(1000, 2000, 2000), 0.5);
  assert.equal(glideFraction(1000, 2000, 3000), 1);
  assert.equal(glideFraction(1000, 2000, 9000), 1);
  assert.equal(glideFraction(1000, 2000, 500), 0);
});

test("lerp moves at constant speed between two positions", () => {
  assert.equal(lerp(10, 20, 0), 10);
  assert.equal(lerp(10, 20, 0.25), 12.5);
  assert.equal(lerp(10, 20, 1), 20);
});
