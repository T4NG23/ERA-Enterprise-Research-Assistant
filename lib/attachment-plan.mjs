const MAX_ATTACHMENTS = 12;
const FIGURE_EXTENSIONS = new Set(["png", "jpg", "jpeg"]);
const PURPOSES = new Set(["figure", "source"]);
const ENTRY_KEYS = new Set([
  "fileName",
  "purpose",
  "order",
  "section",
  "relativePlacement",
  "captionOrNote",
]);

function boundedString(value, field, maximum, allowBlank = true) {
  if (typeof value !== "string") {
    throw new Error(`${field} must be a string.`);
  }
  if (value.length > maximum) {
    throw new Error(`${field} must be ${maximum} characters or less.`);
  }
  const normalized = value.replaceAll(/\r\n?/g, "\n").trim();
  if (!allowBlank && !normalized) {
    throw new Error(`${field} must not be blank.`);
  }
  return normalized;
}

function extension(fileName) {
  const separator = fileName.lastIndexOf(".");
  return separator >= 0 ? fileName.slice(separator + 1).toLowerCase() : "";
}

function canonicalAttachmentNames(attachmentNames) {
  if (!Array.isArray(attachmentNames)) {
    throw new Error("attachmentNames must be an array.");
  }
  if (attachmentNames.length > MAX_ATTACHMENTS) {
    throw new Error(`No more than ${MAX_ATTACHMENTS} attachments can be planned.`);
  }

  const names = [];
  const seen = new Set();
  const seenCaseFolded = new Set();
  for (const [index, value] of attachmentNames.entries()) {
    const name = boundedString(
      value,
      `attachmentNames[${index}]`,
      120,
      false,
    );
    if (name !== value) {
      throw new Error(
        `attachmentNames[${index}] must already be a canonical filename without surrounding whitespace.`,
      );
    }
    const caseFoldedName = name.toLocaleLowerCase("en-US");
    if (seen.has(name) || seenCaseFolded.has(caseFoldedName)) {
      throw new Error(`Duplicate canonical attachment filename: ${name}.`);
    }
    seen.add(name);
    seenCaseFolded.add(caseFoldedName);
    names.push(name);
  }
  return names;
}

/**
 * Validate and normalize the author's complete one-to-one attachment plan.
 * Every canonical uploaded filename must occur exactly once.
 */
export function normalizeAttachmentPlan(value, attachmentNames) {
  if (!Array.isArray(value)) {
    throw new Error("attachmentPlan must be an array.");
  }
  if (value.length > MAX_ATTACHMENTS) {
    throw new Error(`attachmentPlan may contain no more than ${MAX_ATTACHMENTS} entries.`);
  }

  const canonicalNames = canonicalAttachmentNames(attachmentNames);
  const canonicalSet = new Set(canonicalNames);
  const seenNames = new Set();
  const seenOrders = new Set();

  const normalized = value.map((entry, index) => {
    const path = `attachmentPlan[${index}]`;
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) {
      throw new Error(`${path} must be an object.`);
    }
    const unexpected = Object.keys(entry).find((key) => !ENTRY_KEYS.has(key));
    if (unexpected) {
      throw new Error(`${path}.${unexpected} is not an accepted field.`);
    }

    const fileName = boundedString(entry.fileName, `${path}.fileName`, 120, false);
    if (fileName !== entry.fileName || !canonicalSet.has(fileName)) {
      throw new Error(
        `${path}.fileName must exactly match one canonical uploaded filename.`,
      );
    }
    if (seenNames.has(fileName)) {
      throw new Error(`Duplicate attachmentPlan filename: ${fileName}.`);
    }
    seenNames.add(fileName);

    if (typeof entry.purpose !== "string" || !PURPOSES.has(entry.purpose)) {
      throw new Error(`${path}.purpose must be either figure or source.`);
    }
    const purpose = entry.purpose;

    if (
      !Number.isInteger(entry.order) ||
      entry.order < 1 ||
      entry.order > 99
    ) {
      throw new Error(`${path}.order must be an integer from 1 through 99.`);
    }
    if (seenOrders.has(entry.order)) {
      throw new Error(`Duplicate attachmentPlan order: ${entry.order}.`);
    }
    seenOrders.add(entry.order);

    const section = boundedString(entry.section, `${path}.section`, 160);
    const relativePlacement = boundedString(
      entry.relativePlacement,
      `${path}.relativePlacement`,
      500,
    );
    const captionOrNote = boundedString(
      entry.captionOrNote,
      `${path}.captionOrNote`,
      2_000,
    );

    if (purpose === "figure") {
      if (!FIGURE_EXTENSIONS.has(extension(fileName))) {
        throw new Error(
          `${path}.fileName must use PNG, JPG, or JPEG when purpose is figure. WebP and non-image attachments may only be source material.`,
        );
      }
      if (!section) {
        throw new Error(`${path}.section must not be blank for a figure.`);
      }
      if (!captionOrNote) {
        throw new Error(`${path}.captionOrNote must not be blank for a figure.`);
      }
    }

    return {
      fileName,
      purpose,
      order: entry.order,
      section,
      relativePlacement,
      captionOrNote,
    };
  });

  const missing = canonicalNames.filter((name) => !seenNames.has(name));
  if (missing.length || normalized.length !== canonicalNames.length) {
    throw new Error(
      `attachmentPlan must contain exactly one entry for every uploaded attachment${missing.length ? `; missing: ${missing.join(", ")}` : ""}.`,
    );
  }

  return normalized.sort((left, right) => left.order - right.order);
}

function plannedPlacementNote(entry) {
  return `Section: ${entry.section}${entry.relativePlacement ? ` — ${entry.relativePlacement}` : ""}`;
}

/**
 * Reconcile model figure placements with the validated plan. Model captions and
 * placement prose are deliberately replaced by the author/model attachment plan.
 */
export function applyAttachmentPlanToFigurePlacements(placements, plan) {
  if (!Array.isArray(placements)) {
    throw new Error("figurePlacements must be an array.");
  }
  if (!Array.isArray(plan)) {
    throw new Error("attachmentPlan must be an array.");
  }

  const plannedFigures = plan
    .filter((entry) => entry?.purpose === "figure")
    .slice()
    .sort((left, right) => left.order - right.order);
  const figureByName = new Map();
  for (const entry of plannedFigures) {
    if (typeof entry.fileName !== "string" || figureByName.has(entry.fileName)) {
      throw new Error("attachmentPlan contains an invalid or duplicate planned figure filename.");
    }
    figureByName.set(entry.fileName, entry);
  }

  const placementByName = new Map();
  for (const [index, placement] of placements.entries()) {
    if (!placement || typeof placement !== "object" || Array.isArray(placement)) {
      throw new Error(`figurePlacements[${index}] must be an object.`);
    }
    const fileName = placement.fileName;
    if (typeof fileName !== "string" || !figureByName.has(fileName)) {
      throw new Error(
        `figurePlacements[${index}].fileName does not match a planned figure.`,
      );
    }
    if (placementByName.has(fileName)) {
      throw new Error(`Duplicate model figure placement filename: ${fileName}.`);
    }
    placementByName.set(fileName, placement);
  }

  const missing = plannedFigures.filter(
    (entry) => !placementByName.has(entry.fileName),
  );
  if (missing.length) {
    throw new Error(
      `The model omitted planned figure ${missing.map((entry) => entry.fileName).join(", ")}.`,
    );
  }

  return plannedFigures.map((entry) => ({
    fileName: entry.fileName,
    caption: entry.captionOrNote,
    placementNote: plannedPlacementNote(entry),
  }));
}

export function assertPlannedFigureFileNameOrder(fileNames, plan) {
  if (!Array.isArray(fileNames)) {
    throw new Error("LaTeX figure filenames must be an array.");
  }
  if (!Array.isArray(plan)) {
    throw new Error("attachmentPlan must be an array.");
  }
  const expected = plan
    .filter((entry) => entry?.purpose === "figure")
    .slice()
    .sort((left, right) => left.order - right.order)
    .map((entry) => entry.fileName);
  if (
    fileNames.some((fileName) => typeof fileName !== "string") ||
    fileNames.length !== expected.length ||
    fileNames.some((fileName, index) => fileName !== expected[index])
  ) {
    throw new Error(
      "The model did not use every planned figure filename exactly once and in the requested order. Please retry the generation.",
    );
  }
}
