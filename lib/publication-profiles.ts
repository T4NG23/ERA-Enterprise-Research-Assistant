import {
  getPublicationLatexContract,
  getSubmissionLatexContract,
} from "@/compiler/publication-template.mjs";

export type ProfileConfidence = "verified" | "starter";
export type RuleLevel = "required" | "recommended" | "venue-specific";

export interface PublicationLatexContract {
  readonly documentClass:
    | "article"
    | "IEEEtran"
    | "acmart"
    | "llncs"
    | "elsarticle";
  readonly requiredOptions: readonly string[];
  readonly forbiddenOptions: readonly string[];
  readonly wrapper: "maketitle" | "frontmatter";
  readonly classBasis: "publisher-template" | "compiler-fallback";
}

export interface PublicationRule {
  id: string;
  label: string;
  value: string;
  level: RuleLevel;
  detail: string;
}

export interface PublicationProfile {
  id: string;
  authority: "venue" | "publisher";
  status: "active" | "closed";
  publisher: string;
  venue: string;
  shortName: string;
  edition: string;
  confidence: ProfileConfidence;
  description: string;
  sources: Array<{ label: string; url: string }>;
  retrievedAt: string;
  template: {
    family: string;
    layout: string;
    paperSize: string;
    output: string;
    latex: PublicationLatexContract;
  };
  rules: PublicationRule[];
  unresolvedRules: string[];
  caveat: string;
}

function requiredLatexContract(profileId: string): PublicationLatexContract {
  const contract = getPublicationLatexContract(profileId) as
    | PublicationLatexContract
    | undefined;
  if (!contract) {
    throw new Error(`Missing LaTeX contract for publication profile: ${profileId}.`);
  }
  return contract;
}

export const publicationProfiles: PublicationProfile[] = [
  {
    id: "ieee-igarss-2026",
    authority: "venue",
    status: "closed",
    publisher: "IEEE",
    venue: "2026 IEEE International Geoscience and Remote Sensing Symposium",
    shortName: "IEEE IGARSS 2026",
    edition: "2026 symposium",
    confidence: "verified",
    description:
      "An archival, venue-specific IGARSS profile, including the Student Paper Competition workflow. Its 2026 deadlines have passed.",
    sources: [
      {
        label: "Official IGARSS 2026 Paper Kit",
        url: "https://2026.ieeeigarss.org/papers/paper_kit.php",
      },
      {
        label: "IGARSS 2026 paper requirements",
        url: "https://2026.ieeeigarss.org/papers.php",
      },
      {
        label: "IEEE conference AI disclosure policy",
        url: "https://conferences.ieeeauthorcenter.ieee.org/author-ethics/guidelines-and-policies/submission-policies/",
      },
    ],
    retrievedAt: "2026-07-16",
    template: {
      family: "IEEE conference template",
      layout: "Two columns",
      paperSize: "A4 or US Letter",
      output: "PDF for IEEE Xplore",
      latex: requiredLatexContract("ieee-igarss-2026"),
    },
    rules: [
      {
        id: "igarss-layout-01",
        label: "Layout",
        value: "Publish-ready two-column manuscript",
        level: "required",
        detail: "Use the official IEEE conference paper layout without changing template dimensions.",
      },
      {
        id: "igarss-pages-01",
        label: "Technical content",
        value: "800+ words; no more than four content pages",
        level: "required",
        detail:
          "Figures count toward the four content pages; references and bibliography do not. Ordinary full papers need not be exactly four pages.",
      },
      {
        id: "igarss-structure-01",
        label: "Core structure",
        value: "Abstract, index terms, numbered sections, references",
        level: "required",
        detail: "Section names may adapt to the research, but the scientific argument must remain complete and traceable.",
      },
      {
        id: "igarss-spc-01",
        label: "Student Paper Contest",
        value: "Exactly four content pages plus eligibility materials",
        level: "venue-specific",
        detail:
          "Only enforce for SPC: Full Paper, advisor attestation, student-status proof, and advisor contact details were due 2026-01-17.",
      },
      {
        id: "igarss-pdf-01",
        label: "PDF delivery",
        value: "Valid, unprotected PDF; embedded/subset fonts; 5 MB maximum",
        level: "required",
        detail: "The final file must start on page one, use A4 or US Letter, omit page numbers, and keep all content inside the template margins.",
      },
      {
        id: "igarss-authors-01",
        label: "Author metadata",
        value: "PDF author count and order must match the submission form",
        level: "required",
        detail: "Never infer or reorder authors from prose or file metadata.",
      },
      {
        id: "ieee-ai-01",
        label: "Generative AI disclosure",
        value: "Disclose generated text, figures, images, or code",
        level: "required",
        detail: "Name the AI system, identify affected sections, and briefly state the level of use in Acknowledgments. Grammar-only editing is exempt, though disclosure is recommended.",
      },
    ],
    unresolvedRules: [],
    caveat:
      "IGARSS 2026 is closed. Do not roll these dated rules into IGARSS 2027. The app never guarantees acceptance or IEEE Xplore compliance.",
  },
  {
    id: "acm-sigconf",
    authority: "publisher",
    status: "active",
    publisher: "Association for Computing Machinery",
    venue: "ACM proceedings using the SIGCONF format",
    shortName: "ACM SIGCONF",
    edition: "General proceedings profile",
    confidence: "starter",
    description:
      "A reusable ACM proceedings baseline. The exact conference call for papers controls length, anonymity, and review format.",
    sources: [
      {
        label: "ACM LaTeX article preparation",
        url: "https://authors.acm.org/proceedings/production-information/preparing-your-article-with-latex",
      },
      {
        label: "ACM TAPS production workflow",
        url: "https://authors.acm.org/proceedings/production-information/taps-production-workflow",
      },
      {
        label: "ACM authorship and AI policy",
        url: "https://www.acm.org/publications/policies/new-acm-policy-on-authorship",
      },
    ],
    retrievedAt: "2026-07-16",
    template: {
      family: "acmart / sigconf",
      layout: "Two-column proceedings format for final output",
      paperSize: "Template controlled",
      output: "PDF plus validated source package",
      latex: requiredLatexContract("acm-sigconf"),
    },
    rules: [
      {
        id: "acm-template-01",
        label: "Template",
        value: "Current acmart template; do not alter its geometry",
        level: "required",
        detail: "Initial-review class options remain controlled by the exact venue. This SIGCONF starter requires sigconf only for the camera-ready workflow.",
      },
      {
        id: "acm-pages-01",
        label: "Page limit",
        value: "Set by the exact conference and track",
        level: "venue-specific",
        detail: "Do not infer a universal ACM page limit.",
      },
      {
        id: "acm-review-01",
        label: "Review mode",
        value: "Anonymity and one- or two-column review layout vary",
        level: "venue-specific",
        detail: "The conference call for papers overrides the generic proceedings baseline.",
      },
      {
        id: "acm-accessibility-01",
        label: "Figure accessibility",
        value: "Every figure needs a Description alt-text command",
        level: "required",
        detail: "Use the acmart Description command and preserve legibility in one- or two-column placement.",
      },
      {
        id: "acm-metadata-01",
        label: "Publication metadata",
        value: "Verified authors, affiliations, emails, keywords, and CCS concepts",
        level: "recommended",
        detail: "CCS concepts and keywords are required for articles of three or more pages. Never invent classifications or author details.",
      },
      {
        id: "acm-ai-01",
        label: "Generative AI disclosure",
        value: "Disclose content-generating AI; verify the exact venue policy",
        level: "venue-specific",
        detail: "AI cannot be an author. Some venue rules may be newer or stricter than the publisher baseline.",
      },
    ],
    unresolvedRules: [
      "Exact page or word limit",
      "Review anonymity",
      "Review layout and submission file format",
      "Conference-specific AI policy",
    ],
    caveat:
      "This is not a conference-specific rule set. Paste the exact call-for-papers rules into the custom-guidance field before treating any limit as enforced.",
  },
  {
    id: "springer-lncs",
    authority: "publisher",
    status: "active",
    publisher: "Springer Nature",
    venue: "Lecture Notes in Computer Science proceedings",
    shortName: "Springer LNCS",
    edition: "General proceedings profile",
    confidence: "starter",
    description:
      "A Springer LNCS authoring baseline for conference proceedings; conference chairs determine the actual page allowance.",
    sources: [
      {
        label: "LNCS information for authors and editors",
        url: "https://link.springer.com/series/558/information-for-authors-and-editors",
      },
      {
        label: "Springer Nature book and proceedings AI policy",
        url: "https://www.springernature.com/in/policies/book-publishing-policies",
      },
    ],
    retrievedAt: "2026-07-16",
    template: {
      family: "Springer llncs",
      layout: "Single-column LNCS format",
      paperSize: "Template controlled",
      output: "PDF plus source files",
      latex: requiredLatexContract("springer-lncs"),
    },
    rules: [
      {
        id: "lncs-template-01",
        label: "Template",
        value: "Use the current LNCS author template",
        level: "required",
        detail: "Preserve the supplied document class, styles, and front-matter structure.",
      },
      {
        id: "lncs-pages-01",
        label: "Page limit",
        value: "Set by the conference",
        level: "venue-specific",
        detail: "LNCS does not define one universal paper length for every proceedings volume.",
      },
      {
        id: "lncs-author-01",
        label: "Corresponding author",
        value: "Exactly one clearly marked corresponding author with email",
        level: "required",
        detail: "Author names and order are final at delivery. Do not fabricate ORCID, affiliation, or contact data.",
      },
      {
        id: "lncs-accessibility-01",
        label: "Non-text content",
        value: "Alt text required; tables and equations must remain editable",
        level: "required",
        detail: "Do not paste tables or equations as images. Number and cross-reference all figures and tables.",
      },
      {
        id: "lncs-layout-01",
        label: "Production layout",
        value: "No page numbers or running heads; only first two heading levels numbered",
        level: "required",
        detail: "Use the template heading hierarchy; do not create a section zero.",
      },
      {
        id: "lncs-disclosure-01",
        label: "Declarations",
        value: "Disclosure of Interests required; disclose substantive generative AI",
        level: "required",
        detail: "AI cannot be an author. Generative figures are generally not accepted without a stated exception.",
      },
    ],
    unresolvedRules: [
      "Conference page limit and paper type",
      "Review anonymity and submission format",
      "Conference deadline",
    ],
    caveat:
      "Conference-specific author instructions and editor messages take priority over this general LNCS profile.",
  },
  {
    id: "elsevier-research-article",
    authority: "publisher",
    status: "active",
    publisher: "Elsevier",
    venue: "Elsevier journal research article",
    shortName: "Elsevier journal",
    edition: "Generic journal profile",
    confidence: "starter",
    description:
      "A deliberately conservative journal baseline. Elsevier journals differ widely in length, sections, artwork, and reference style.",
    sources: [
      {
        label: "Editorial Manager file preparation",
        url: "https://www.elsevier.support/publishing/answer/how-do-i-prepare-my-files-for-submission-in-editorial-manager",
      },
      {
        label: "Elsevier submission checklist",
        url: "https://www.elsevier.support/publishing/answer/is-there-a-submission-checklist-i-can-use",
      },
      {
        label: "Elsevier LaTeX instructions",
        url: "https://www.elsevier.com/en-gb/researcher/author/policies-and-guidelines/latex-instructions",
      },
      {
        label: "Elsevier generative AI policy for journals",
        url: "https://www.elsevier.com/about/policies-and-standards/generative-ai-policies-for-journals",
      },
    ],
    retrievedAt: "2026-07-16",
    template: {
      family: "Journal-specific or elsarticle",
      layout: "Journal dependent",
      paperSize: "Journal dependent",
      output: "Editable manuscript, figures, and submission metadata",
      latex: requiredLatexContract("elsevier-research-article"),
    },
    rules: [
      {
        id: "elsevier-guide-01",
        label: "Guide for Authors",
        value: "The selected journal is authoritative",
        level: "required",
        detail: "No generic Elsevier rule may override the journal's Guide for Authors.",
      },
      {
        id: "elsevier-pages-01",
        label: "Length",
        value: "Journal and article-type specific",
        level: "venue-specific",
        detail: "Do not impose a universal page or word limit.",
      },
      {
        id: "elsevier-files-01",
        label: "Submission files",
        value: "Unique standard filenames, no special characters, 80 characters maximum",
        level: "required",
        detail: "Remove personal identifiers for double-anonymous review. The review model is journal-specific.",
      },
      {
        id: "elsevier-correspondence-01",
        label: "Corresponding author",
        value: "One designated corresponding author with email and affiliation address",
        level: "required",
        detail: "Include current postal address when it differs. Never infer missing identity details.",
      },
      {
        id: "elsevier-artwork-01",
        label: "Artwork",
        value: "Separate, captioned, numbered, cited, and rights-cleared figures",
        level: "recommended",
        detail: "Preferred formats and resolution remain subject to the exact journal guidance.",
      },
      {
        id: "elsevier-ai-01",
        label: "Generative AI declaration",
        value: "Dedicated declaration immediately before references",
        level: "required",
        detail: "Name the tool and purpose, confirm human review and responsibility, and never list AI as an author. Grammar-only editing is exempt.",
      },
    ],
    unresolvedRules: [
      "Page or word limit",
      "Column count and typography",
      "Abstract length and required sections",
      "Reference style, anonymity, highlights, and graphical abstract",
    ],
    caveat:
      "Select the exact journal and paste its current Guide for Authors before using this profile for a real submission.",
  },
];

export const CUSTOM_PROFILE_ID = "custom-publication";

export function getPublicationLatexContractForProfile(
  profileId: string,
  submissionType?: string,
) {
  if (!submissionType) return requiredLatexContract(profileId);
  const contract = getSubmissionLatexContract(profileId, submissionType) as
    | PublicationLatexContract
    | undefined;
  if (!contract) {
    throw new Error(
      `Missing LaTeX contract for publication workflow: ${profileId} / ${submissionType}.`,
    );
  }
  return contract;
}

export function getPublicationProfile(id: string) {
  return publicationProfiles.find((profile) => profile.id === id);
}
