import assert from "node:assert/strict";
import test from "node:test";

import {
  syntheticTestFixtureOrder,
  syntheticTestFixtures,
} from "../../lib/synthetic-test-fixtures.ts";

function wordCount(value) {
  return value.trim() ? value.trim().split(/\s+/).length : 0;
}

test("keeps every synthetic UI fixture within form limits", () => {
  assert.deepEqual(
    new Set(syntheticTestFixtureOrder),
    new Set(Object.keys(syntheticTestFixtures)),
  );

  for (const fixture of Object.values(syntheticTestFixtures)) {
    assert.ok(fixture.title.length > 0 && fixture.title.length <= 300, fixture.id);
    assert.ok(
      fixture.authorMetadata.length > 0 &&
        fixture.authorMetadata.length <= 12_000,
      fixture.id,
    );
    assert.ok(
      fixture.manuscript.length > 0 && fixture.manuscript.length <= 160_000,
      fixture.id,
    );
    assert.match(fixture.manuscript, /TEST STATUS:/, fixture.id);
  }
});

test("provides a dedicated extended IEEE full-paper fixture", () => {
  const fullPaper = syntheticTestFixtures["ieee-full"].manuscript;
  const studentContest = syntheticTestFixtures["igarss-spc"].manuscript;

  assert.ok(wordCount(fullPaper) >= 2_200);
  assert.ok(wordCount(fullPaper) <= 3_000);
  assert.notEqual(fullPaper, studentContest);

  for (const requiredSection of [
    "Abstract:",
    "Index terms:",
    "2. Synthetic Dataset:",
    "3. Dual-Scale Toy Model:",
    "4. Evaluation Protocol:",
    "5. Fabricated Results:",
    "7. Limitations and Reproducibility Status:",
    "8. Conclusion:",
    "Data and code availability:",
    "Generative AI disclosure for the test:",
  ]) {
    assert.ok(fullPaper.includes(requiredSection), requiredSection);
  }

  assert.match(
    fullPaper,
    /approximately three-page IEEE two-column draft/,
  );
  assert.match(fullPaper, /0\.781 plus or minus 0\.006/);
  assert.match(fullPaper, /not research/);
});

test("does not present the shorter SPC fixture as a three-page sample", () => {
  const studentContest = syntheticTestFixtures["igarss-spc"].manuscript;

  assert.ok(wordCount(studentContest) < 800);
  assert.doesNotMatch(studentContest, /approximately three-page/);
  assert.match(studentContest, /exact SPC length/);
});
