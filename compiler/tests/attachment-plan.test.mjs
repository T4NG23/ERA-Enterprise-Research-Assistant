import assert from "node:assert/strict";
import test from "node:test";

import {
  applyAttachmentPlanToFigurePlacements,
  assertPlannedFigureFileNameOrder,
  normalizeAttachmentPlan,
} from "../../lib/attachment-plan.mjs";

function entry(fileName, overrides = {}) {
  return {
    fileName,
    purpose: "source",
    order: 1,
    section: "",
    relativePlacement: "",
    captionOrNote: "",
    ...overrides,
  };
}

test("normalizes every attachment exactly once and sorts without mutation", () => {
  const value = [
    entry("notes.pdf", {
      order: 3,
      section: "  Methods  ",
      captionOrNote: "  Supporting source  ",
    }),
    entry("coast.PNG", {
      purpose: "figure",
      order: 1,
      section: "  Results\r\n  ",
      relativePlacement: " After the first comparison. ",
      captionOrNote: " Synthetic coastal classes. ",
    }),
    entry("preview.webp", {
      order: 2,
      captionOrNote: "Inspect visually as source material.",
    }),
  ];
  const original = structuredClone(value);

  const normalized = normalizeAttachmentPlan(value, [
    "coast.PNG",
    "preview.webp",
    "notes.pdf",
  ]);

  assert.deepEqual(
    normalized.map((item) => item.fileName),
    ["coast.PNG", "preview.webp", "notes.pdf"],
  );
  assert.equal(normalized[0].section, "Results");
  assert.equal(normalized[0].relativePlacement, "After the first comparison.");
  assert.equal(normalized[0].captionOrNote, "Synthetic coastal classes.");
  assert.deepEqual(value, original);
});

test("accepts an empty one-to-one plan when there are no attachments", () => {
  assert.deepEqual(normalizeAttachmentPlan([], []), []);
});

test("enforces the twelve-entry maximum", () => {
  const names = Array.from({ length: 12 }, (_, index) => `source-${index}.txt`);
  const plan = names.map((name, index) => entry(name, { order: index + 1 }));
  assert.equal(normalizeAttachmentPlan(plan, names).length, 12);

  const thirteenNames = [...names, "source-12.txt"];
  const thirteenEntries = [
    ...plan,
    entry("source-12.txt", { order: 13 }),
  ];
  assert.throws(
    () => normalizeAttachmentPlan(thirteenEntries, thirteenNames),
    /no more than 12 entries/i,
  );
  assert.throws(
    () => normalizeAttachmentPlan([], thirteenNames),
    /No more than 12 attachments/i,
  );
});

test("requires exact one-to-one canonical filenames", () => {
  assert.throws(
    () => normalizeAttachmentPlan([entry("unknown.pdf")], ["known.pdf"]),
    /exactly match one canonical uploaded filename/,
  );
  assert.throws(
    () => normalizeAttachmentPlan([entry("Known.pdf")], ["known.pdf"]),
    /exactly match one canonical uploaded filename/,
  );
  assert.throws(
    () =>
      normalizeAttachmentPlan(
        [entry("one.pdf"), entry("one.pdf", { order: 2 })],
        ["one.pdf", "two.pdf"],
      ),
    /Duplicate attachmentPlan filename/,
  );
  assert.throws(
    () => normalizeAttachmentPlan([entry("one.pdf")], ["one.pdf", "two.pdf"]),
    /missing: two\.pdf/,
  );
  assert.throws(
    () => normalizeAttachmentPlan([], ["duplicate.pdf", "duplicate.pdf"]),
    /Duplicate canonical attachment filename/,
  );
  assert.throws(
    () => normalizeAttachmentPlan([], ["Figure.PNG", "figure.png"]),
    /Duplicate canonical attachment filename/,
  );
  assert.throws(
    () => normalizeAttachmentPlan([entry(" file.pdf ")], ["file.pdf"]),
    /exactly match one canonical uploaded filename/,
  );
});

test("requires strict entry fields, purposes, and bounded integer orders", () => {
  assert.throws(
    () => normalizeAttachmentPlan("not an array", []),
    /attachmentPlan must be an array/,
  );
  assert.throws(
    () => normalizeAttachmentPlan([null], ["one.pdf"]),
    /must be an object/,
  );
  assert.throws(
    () =>
      normalizeAttachmentPlan(
        [{ ...entry("one.pdf"), unexpected: true }],
        ["one.pdf"],
      ),
    /unexpected is not an accepted field/,
  );
  assert.throws(
    () => normalizeAttachmentPlan([entry("one.pdf", { purpose: "table" })], ["one.pdf"]),
    /purpose must be either figure or source/,
  );

  for (const order of [0, 100, 1.5, "1"]) {
    assert.throws(
      () => normalizeAttachmentPlan([entry("one.pdf", { order })], ["one.pdf"]),
      /order must be an integer from 1 through 99/,
    );
  }
  assert.throws(
    () =>
      normalizeAttachmentPlan(
        [entry("one.pdf"), entry("two.pdf")],
        ["one.pdf", "two.pdf"],
      ),
    /Duplicate attachmentPlan order/,
  );
});

test("enforces every string bound", async (t) => {
  const cases = [
    {
      name: "canonical filename",
      attachmentName: `${"a".repeat(117)}.pdf`,
      override: {},
      pattern: /attachmentNames\[0\] must be 120 characters or less/,
    },
    {
      name: "section",
      attachmentName: "one.pdf",
      override: { section: "s".repeat(161) },
      pattern: /section must be 160 characters or less/,
    },
    {
      name: "relative placement",
      attachmentName: "one.pdf",
      override: { relativePlacement: "p".repeat(501) },
      pattern: /relativePlacement must be 500 characters or less/,
    },
    {
      name: "caption or note",
      attachmentName: "one.pdf",
      override: { captionOrNote: "c".repeat(2_001) },
      pattern: /captionOrNote must be 2000 characters or less/,
    },
  ];

  for (const item of cases) {
    await t.test(item.name, () => {
      assert.throws(
        () =>
          normalizeAttachmentPlan(
            [entry(item.attachmentName, item.override)],
            [item.attachmentName],
          ),
        item.pattern,
      );
    });
  }
});

test("allows only compiler-compatible PNG or JPEG files to be figures", () => {
  for (const fileName of ["figure.png", "figure.JPG", "figure.jpeg"]) {
    assert.equal(
      normalizeAttachmentPlan(
        [
          entry(fileName, {
            purpose: "figure",
            section: "Results",
            captionOrNote: "A verified caption.",
          }),
        ],
        [fileName],
      )[0].purpose,
      "figure",
    );
  }
  for (const fileName of ["figure.webp", "figure.pdf", "figure.csv"]) {
    assert.throws(
      () =>
        normalizeAttachmentPlan(
          [
            entry(fileName, {
              purpose: "figure",
              section: "Results",
              captionOrNote: "A caption.",
            }),
          ],
          [fileName],
        ),
      /may only be source material/,
    );
  }
  assert.equal(
    normalizeAttachmentPlan([entry("figure.webp")], ["figure.webp"])[0].purpose,
    "source",
  );
});

test("requires a nonblank section and caption for figures but not sources", () => {
  assert.throws(
    () =>
      normalizeAttachmentPlan(
        [entry("figure.png", { purpose: "figure", captionOrNote: "Caption" })],
        ["figure.png"],
      ),
    /section must not be blank for a figure/,
  );
  assert.throws(
    () =>
      normalizeAttachmentPlan(
        [entry("figure.png", { purpose: "figure", section: "Results" })],
        ["figure.png"],
      ),
    /captionOrNote must not be blank for a figure/,
  );
  assert.deepEqual(
    normalizeAttachmentPlan([entry("source.txt")], ["source.txt"])[0],
    entry("source.txt"),
  );
});

test("reorders model placements by plan and forces planned caption and placement prose", () => {
  const plan = normalizeAttachmentPlan(
    [
      entry("second.jpg", {
        purpose: "figure",
        order: 8,
        section: "Discussion",
        relativePlacement: "Near the limitations paragraph.",
        captionOrNote: "Second planned caption.",
      }),
      entry("first.png", {
        purpose: "figure",
        order: 2,
        section: "Results",
        relativePlacement: "After Table 1.",
        captionOrNote: "First planned caption.",
      }),
      entry("notes.txt", { order: 1 }),
    ],
    ["first.png", "second.jpg", "notes.txt"],
  );
  const placements = [
    {
      fileName: "second.jpg",
      caption: "Model caption must be discarded.",
      placementNote: "Model placement must be discarded.",
    },
    {
      fileName: "first.png",
      caption: "Another discarded caption.",
      placementNote: "Another discarded placement.",
    },
  ];
  const originalPlacements = structuredClone(placements);
  const originalPlan = structuredClone(plan);

  assert.deepEqual(applyAttachmentPlanToFigurePlacements(placements, plan), [
    {
      fileName: "first.png",
      caption: "First planned caption.",
      placementNote: "Section: Results — After Table 1.",
    },
    {
      fileName: "second.jpg",
      caption: "Second planned caption.",
      placementNote: "Section: Discussion — Near the limitations paragraph.",
    },
  ]);
  assert.deepEqual(placements, originalPlacements);
  assert.deepEqual(plan, originalPlan);
});

test("rejects unknown, source-only, duplicate, and omitted model figure filenames", () => {
  const plan = normalizeAttachmentPlan(
    [
      entry("figure.png", {
        purpose: "figure",
        section: "Results",
        captionOrNote: "Caption.",
      }),
      entry("source.pdf", { order: 2 }),
    ],
    ["figure.png", "source.pdf"],
  );

  assert.throws(
    () =>
      applyAttachmentPlanToFigurePlacements(
        [{ fileName: "unknown.png" }],
        plan,
      ),
    /does not match a planned figure/,
  );
  assert.throws(
    () =>
      applyAttachmentPlanToFigurePlacements(
        [{ fileName: "source.pdf" }],
        plan,
      ),
    /does not match a planned figure/,
  );
  assert.throws(
    () =>
      applyAttachmentPlanToFigurePlacements(
        [{ fileName: "figure.png" }, { fileName: "figure.png" }],
        plan,
      ),
    /Duplicate model figure placement filename/,
  );
  assert.throws(
    () => applyAttachmentPlanToFigurePlacements([], plan),
    /omitted planned figure figure\.png/,
  );
});

test("requires no model placements when the plan contains no figures", () => {
  const plan = normalizeAttachmentPlan([entry("source.webp")], ["source.webp"]);
  assert.deepEqual(applyAttachmentPlanToFigurePlacements([], plan), []);
  assert.throws(
    () =>
      applyAttachmentPlanToFigurePlacements(
        [{ fileName: "source.webp" }],
        plan,
      ),
    /does not match a planned figure/,
  );
});

test("rejects malformed placement and plan containers", () => {
  assert.throws(
    () => applyAttachmentPlanToFigurePlacements(null, []),
    /figurePlacements must be an array/,
  );
  assert.throws(
    () => applyAttachmentPlanToFigurePlacements([], null),
    /attachmentPlan must be an array/,
  );
  assert.throws(
    () => applyAttachmentPlanToFigurePlacements([null], []),
    /must be an object/,
  );
  assert.throws(
    () =>
      applyAttachmentPlanToFigurePlacements([], [
        { purpose: "figure", fileName: "same.png", order: 1 },
        { purpose: "figure", fileName: "same.png", order: 2 },
      ]),
    /invalid or duplicate planned figure filename/,
  );
});

test("requires LaTeX figure filenames exactly once and in planned order", () => {
  const plan = normalizeAttachmentPlan(
    [
      entry("second.jpg", {
        purpose: "figure",
        order: 9,
        section: "Discussion",
        captionOrNote: "Second.",
      }),
      entry("source.pdf", { order: 2 }),
      entry("first.png", {
        purpose: "figure",
        order: 4,
        section: "Results",
        captionOrNote: "First.",
      }),
    ],
    ["first.png", "second.jpg", "source.pdf"],
  );

  assert.doesNotThrow(() =>
    assertPlannedFigureFileNameOrder(["first.png", "second.jpg"], plan),
  );
  for (const filenames of [
    ["second.jpg", "first.png"],
    ["first.png"],
    ["first.png", "first.png", "second.jpg"],
    ["first.png", "source.pdf", "second.jpg"],
  ]) {
    assert.throws(
      () => assertPlannedFigureFileNameOrder(filenames, plan),
      /exactly once and in the requested order/,
    );
  }
  assert.throws(
    () => assertPlannedFigureFileNameOrder(null, plan),
    /filenames must be an array/,
  );
});
