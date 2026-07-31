export type ComplianceStatus = "pass" | "review" | "fail" | "not_applicable";

export interface GeneratedSection {
  heading: string;
  body: string;
}

export interface FigurePlacement {
  fileName: string;
  caption: string;
  placementNote: string;
}

export interface AttachmentPlanEntry {
  fileName: string;
  purpose: "figure" | "source";
  order: number;
  section: string;
  relativePlacement: string;
  captionOrNote: string;
}

export interface ComplianceCheck {
  ruleId: string;
  label: string;
  status: ComplianceStatus;
  evidence: string;
  action: string;
}

export interface LargeCorpusSourceCoverage {
  fileName: string;
  characters: number;
  chunks: number;
  selectedChunks: number;
  selectedCharacters: number;
}

export type LargeCorpusRole =
  | "abstract"
  | "introduction"
  | "background"
  | "related-work"
  | "methods"
  | "data"
  | "experiments"
  | "results"
  | "findings"
  | "synthesis"
  | "discussion"
  | "limitations"
  | "conclusion"
  | "acknowledgments"
  | "references"
  | "unclassified";

export interface LargeCorpusRoleWeight {
  role: LargeCorpusRole;
  weight: number;
  substantive: boolean;
}

export interface LargeCorpusRoleCoverage extends LargeCorpusRoleWeight {
  headingCount: number;
  detectedSources: number;
  selectedSources: number;
  detectedChunks: number;
  selectedChunks: number;
  selectedCharacters: number;
}

export interface LargeCorpusReport {
  enabled: true;
  strategy: "lexical-section-balanced-v2";
  weightingPolicy: "empirical-research-v1" | "review-synthesis-v1";
  selectionPolicy: {
    id: "source-and-substantive-role-seeds-v2";
    scope: "transparent-general-paper-heuristic-not-universal";
    sourceSeed: "best-ranked-chunk-per-nonempty-source";
    roleSeed: "best-ranked-meaningful-chunk-per-detected-substantive-role";
    ranking: "lexical-score-plus-primary-role-weight";
    budgetRule: "deduplicated-seeds-before-global-ranking-when-they-fit";
    renderOrder: "source-index-then-chunk-index";
  };
  roleWeights: LargeCorpusRoleWeight[];
  roleCoverage: LargeCorpusRoleCoverage[];
  mapCharacters: number;
  sourceCount: number;
  totalCharacters: number;
  totalChunks: number;
  selectedChunks: number;
  selectedCharacters: number;
  omittedChunks: number;
  packetCharacters: number;
  sources: LargeCorpusSourceCoverage[];
}

export type VenuePageMode =
  | "minimum_pages"
  | "maximum_pages"
  | "exact_pages"
  | "page_range";

export type VenuePageCountScope =
  | "total_pdf"
  | "content_excluding_references";

export interface VenuePagePolicy {
  id: string;
  mode: VenuePageMode;
  countScope: VenuePageCountScope;
  minPages?: number;
  maxPages?: number;
  exactPages?: number;
  ruleIds: readonly string[];
  sourceBasis: string;
}

export interface VenueGuidelineSource {
  requestedUrl: string;
  finalUrl: string;
  retrievedAt: string;
  title: string;
  contentType: "text/html" | "text/plain" | "application/pdf";
  sha256: string;
}

export interface ConfirmedVenueRule {
  id: string;
  category: string;
  label: string;
  requirement: string;
  strength: "required" | "recommended";
  excerpt: string;
}

export interface ConfirmedVenueContract {
  version: 1;
  contractId: string;
  provenance: "author_confirmed";
  venue: string;
  publisher: string;
  submissionType: string;
  confirmedAt: string;
  source: VenueGuidelineSource;
  extractor: {
    model: string;
    version: "venue-guidelines-v1";
  };
  templateKey:
    | "generic-article"
    | "ieee-conference"
    | "acm-sigconf-review"
    | "acm-sigconf-final"
    | "springer-lncs"
    | "elsevier-article";
  pagePolicy: VenuePagePolicy | null;
  rules: readonly ConfirmedVenueRule[];
  unresolved: readonly string[];
}

export interface GenerationResult {
  metadata: {
    profileId: string;
    profileName: string;
    profileAuthority: "venue" | "publisher";
    profileConfidence: "verified" | "starter";
    profileSources: Array<{ label: string; url: string }>;
    targetVenue: string;
    submissionType: string;
    model: string;
    transport: "chat_completions" | "responses";
    generatedAt: string;
    attachmentPlan: AttachmentPlanEntry[];
    largeCorpus: LargeCorpusReport | null;
    venueContract: {
      contract: ConfirmedVenueContract;
      artifact: string;
    } | null;
  };
  paper: {
    title: string;
    abstract: string;
    keywords: string[];
    sections: GeneratedSection[];
    figurePlacements: FigurePlacement[];
  };
  latex: string;
  compliance: ComplianceCheck[];
  warnings: string[];
  authorChecklist: string[];
}

export interface ApiErrorBody {
  error: string;
  code?: string;
  details?: string[];
  diagnosticId?: string;
}
