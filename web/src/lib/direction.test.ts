import assert from "node:assert/strict";
import { test } from "node:test";
import { COMPASS_LETTER, COMPASS_WORD, compassDirection, compassOrder } from "./direction.ts";

test("bearings map to the eight compass words", () => {
  assert.equal(compassDirection(0), "utara");
  assert.equal(compassDirection(355), "utara");
  assert.equal(compassDirection(45), "timur laut");
  assert.equal(compassDirection(86), "timur");
  assert.equal(compassDirection(183), "selatan");
  assert.equal(compassDirection(-90), "barat");
  assert.equal(compassDirection(263), "barat");
  assert.equal(compassDirection(312), "barat laut");
  assert.equal(compassDirection(140), "tenggara");
  assert.equal(compassDirection(220), "barat daya");
});

test("every compass word has a word and a letter in both languages", () => {
  for (const lang of ["id", "en"] as const) {
    for (const b of [0, 45, 90, 135, 180, 225, 270, 315]) {
      const c = compassDirection(b);
      assert.ok(COMPASS_WORD[lang][c]);
      assert.ok(COMPASS_LETTER[lang][c]);
    }
  }
  assert.equal(COMPASS_LETTER.id.selatan, "S");
  assert.equal(COMPASS_LETTER.en["timur laut"], "NE");
});

test("compass order runs clockwise from north", () => {
  const bearings = [263, 86, 355, 180, 10];
  assert.deepEqual(
    [...bearings].sort((a, b) => compassOrder(a) - compassOrder(b)),
    [10, 86, 180, 263, 355],
  );
});
