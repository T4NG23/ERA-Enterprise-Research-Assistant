import { isRuleApplicableToSubmission } from "./submission-types.mjs";

const VENUE_VERIFICATION_ACTION =
  "Confirm this venue-specific rule's wording, track, and effective date against the current official source before treating it as passed.";

function boundedAction(action, suffix, limit) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 8_000;
  const normalizedAction = typeof action === "string" ? action.trim() : "";
  const suffixIndex = normalizedAction
    .toLowerCase()
    .indexOf(suffix.toLowerCase());
  if (suffixIndex >= 0 && normalizedAction.length <= safeLimit) {
    return normalizedAction;
  }
  if (suffix.length >= safeLimit) return suffix.slice(0, safeLimit);
  const actionWithoutSuffix =
    suffixIndex >= 0
      ? normalizedAction.slice(0, suffixIndex).trimEnd()
      : normalizedAction;
  const prefix = actionWithoutSuffix
    .slice(0, Math.max(0, safeLimit - suffix.length - 1))
    .trimEnd();
  return prefix ? `${prefix} ${suffix}` : suffix;
}

export function applyProfileCompliancePolicy(
  items,
  profile,
  actionLimit = 8_000,
) {
  const rules = new Map(
    Array.isArray(profile?.rules)
      ? profile.rules.map((rule) => [rule.id, rule])
      : [],
  );
  const downgradedRuleIds = [];
  const normalizedItems = (Array.isArray(items) ? items : []).map((item) => {
    const rule = rules.get(item.ruleId);
    if (
      profile?.confidence !== "starter" ||
      rule?.level !== "venue-specific" ||
      item.status !== "pass"
    ) {
      return { ...item };
    }
    downgradedRuleIds.push(item.ruleId);
    return {
      ...item,
      status: "review",
      action: boundedAction(
        item.action,
        VENUE_VERIFICATION_ACTION,
        actionLimit,
      ),
    };
  });
  return {
    items: normalizedItems,
    downgradedRuleIds: Object.freeze(downgradedRuleIds),
  };
}

export function applySubmissionApplicabilityPolicy(
  items,
  profile,
  submissionType,
) {
  const notApplicableRuleIds = [];
  const normalizedItems = (Array.isArray(items) ? items : []).map((item) => {
    if (
      isRuleApplicableToSubmission(
        profile?.id,
        item.ruleId,
        submissionType,
      )
    ) {
      return { ...item };
    }
    notApplicableRuleIds.push(item.ruleId);
    return {
      ...item,
      status: "not_applicable",
      evidence: `This rule does not apply to the selected ${submissionType} workflow.`,
      action: "",
    };
  });
  return {
    items: normalizedItems,
    notApplicableRuleIds: Object.freeze(notApplicableRuleIds),
  };
}

export function deterministicProfileWarnings(profile, downgradedRuleIds = []) {
  const warnings = [];
  if (profile?.confidence === "starter") {
    warnings.push(
      "Venue-specific checks in this starter profile remain review until the exact current venue rules and source provenance are confirmed.",
    );
  }
  if (Array.isArray(downgradedRuleIds) && downgradedRuleIds.length) {
    warnings.push(
      `Scholar Flow kept ${downgradedRuleIds.length} model-reported venue-specific ${downgradedRuleIds.length === 1 ? "check" : "checks"} at review because the selected profile is not a verified venue profile.`,
    );
  }
  if (profile?.status === "closed") {
    warnings.push(
      `This is a closed archival profile. Results apply only to the dated ${profile.edition || "publication"} rules and do not establish eligibility for a current or future submission.`,
    );
  }
  if (profile?.template?.latex?.classBasis === "compiler-fallback") {
    warnings.push(
      `The ${profile.template.latex.documentClass} document class is a compiler fallback, not a verified template for the exact publication. Confirm the current author instructions before submission.`,
    );
  }
  return warnings;
}

function normalizeWarning(value, itemLimit) {
  if (typeof value !== "string") return "";
  return value.replaceAll(/\s+/g, " ").trim().slice(0, itemLimit).trim();
}

export function mergeWarnings(
  applicationWarnings,
  modelWarnings,
  limit = 100,
  itemLimit = 5_000,
) {
  const safeLimit = Number.isInteger(limit) && limit > 0 ? limit : 100;
  const safeItemLimit =
    Number.isInteger(itemLimit) && itemLimit > 0 ? itemLimit : 5_000;
  const merged = [];
  const seen = new Set();
  for (const warning of [
    ...(Array.isArray(applicationWarnings) ? applicationWarnings : []),
    ...(Array.isArray(modelWarnings) ? modelWarnings : []),
  ]) {
    if (merged.length >= safeLimit) break;
    const normalized = normalizeWarning(warning, safeItemLimit);
    if (!normalized) continue;
    const canonical = normalized.toLowerCase();
    if (seen.has(canonical)) continue;
    seen.add(canonical);
    merged.push(normalized);
  }
  return merged;
}

export const PROFILE_VENUE_VERIFICATION_ACTION = VENUE_VERIFICATION_ACTION;
