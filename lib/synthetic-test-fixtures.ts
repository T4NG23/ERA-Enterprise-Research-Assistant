export type SyntheticTestFixtureId =
  | "ieee-full"
  | "igarss-spc"
  | "acm-sigconf"
  | "acm-camera-ready"
  | "springer-lncs"
  | "elsevier-article"
  | "custom-review";

export interface SyntheticTestFixture {
  id: SyntheticTestFixtureId;
  label: string;
  description: string;
  profileId: string;
  submissionType: string;
  targetVenue: string;
  customPublisher: string;
  customSourceUrl: string;
  customGuidance: string;
  title: string;
  authorMetadata: string;
  manuscript: string;
}

const ieeeFullManuscript = `TEST STATUS: Entirely synthetic. All names, affiliations, imagery, experiments, procedures, and numerical values are fictional. This extended fixture contains enough distinct material to exercise an approximately three-page IEEE two-column draft. It is software-test data, not research, and must never be submitted or cited as scientific evidence.

Abstract:
This fictional study evaluates a dual-scale semantic-segmentation model on an invented coastal-imagery dataset. The synthetic dataset contains 240 five-band image tiles with pixel labels for water, vegetation, sand, and built surface. Fine-resolution features preserve narrow shoreline boundaries, while a coarse contextual branch represents larger land-cover regions. A gated fusion block combines both branches before prediction. In fabricated results averaged over three deterministic toy runs, the proposed model achieved a mean intersection-over-union of 0.781 plus or minus 0.006, compared with 0.724 plus or minus 0.008 for a fictional single-scale baseline. The proposed model also produced a fabricated macro F1 score of 0.866 and boundary F1 score of 0.710. These values exist solely to test whether Scholar Flow can preserve detailed methods, distinguish supplied facts from missing evidence, format quantitative comparisons, and generate longer venue-aware LaTeX without inventing claims.

Index terms:
Synthetic remote sensing, semantic segmentation, multiscale features, coastal imagery, software testing.

1. Introduction:
Pixel-level coastal mapping is used here only as a compact mock problem for exercising a remote-sensing publication workflow. Coastal scenes contain broad water and vegetation regions as well as narrow boundaries around beaches, channels, and constructed surfaces. That mixture creates a plausible reason to compare local and contextual feature representations without requiring any genuine satellite observations. The fixture therefore supplies enough internally consistent detail for a model to organize an abstract, numbered technical sections, equations, tables, limitations, and a conclusion.

The fictional problem is deliberately bounded. Each sample is a procedurally generated tile rather than an observation from a satellite, aircraft, drone, or field instrument. No geographic coordinates, acquisition dates, people, protected locations, commercial data, or sensor calibration records exist. The four class labels were produced directly by the same toy generator that created the pixels, so there was no human annotation process and no inter-annotator agreement study. The numerical outcomes below were written as predictable test inputs and were not computed by executable training code.

The synthetic study asks two test questions. First, can a fine-resolution branch and a coarse contextual branch be described as one coherent segmentation architecture while preserving all supplied dimensions and training settings? Second, can the resulting draft compare the invented model with a toy baseline and four ablations without overstating the fabricated evidence? The intended contributions are limited to the fixture itself: a defined synthetic dataset, a fully specified toy architecture, a deterministic evaluation protocol, and a collection of table-ready fictional results. There is no claim of novelty, practical performance, or superiority on real coastal imagery.

2. Synthetic Dataset:
The invented dataset contains 240 tiles, each measuring 192 by 192 pixels with five synthetic bands. The bands imitate blue, green, red, near-infrared, and a unitless texture channel, but their values do not correspond to any physical radiance or reflectance scale. Every band is normalized to the interval from zero to one. The dataset is divided once into 160 training tiles, 40 validation tiles, and 40 test tiles. The split is fixed before any fictional optimization, and no tile appears in more than one partition.

Each tile begins with a unit-square canvas. A shoreline curve is formed from two low-frequency sinusoidal components with independently sampled phase offsets. Pixels on one side of that curve become water, and pixels within a variable-width strip on the other side become sand. Two to five elliptical vegetation regions and zero to three rectangular built regions are then placed subject to a minimum simulated separation of four pixels. If two foreground regions overlap, built surface has priority over vegetation, vegetation has priority over sand, and sand has priority over water. This priority rule makes every target mask deterministic.

Band values are assigned from class-specific fictional centers and then perturbed with spatially correlated toy noise. Water receives low near-infrared values, vegetation receives high near-infrared values, sand receives relatively high visible-band values, and built surface receives moderate values in all five channels. A three-by-three smoothing kernel creates local correlation, after which independent zero-mean noise with a standard deviation of 0.02 is added. The texture channel is the normalized magnitude of a synthetic horizontal and vertical gradient. Values are clipped to the interval from zero to one.

The class distribution across the fabricated test split is 41.2 percent water, 27.6 percent vegetation, 18.9 percent sand, and 12.3 percent built surface. These proportions are provided so a generated paper can discuss imbalance without inventing it. No missing pixels, unlabeled regions, clouds, shadows, atmospheric effects, tidal metadata, or seasonal variation are simulated. The dataset has no license because no data artifact exists. A real submission would require an actual repository, persistent identifier, access statement, and rights review.

3. Dual-Scale Toy Model:
The fictional baseline is a single-scale encoder-decoder with three resolution stages. Its encoder uses channel widths of 32, 64, and 128, and each stage contains two three-by-three convolutions followed by a rectified linear unit. Downsampling is performed with a stride of two. The decoder bilinearly upsamples the deepest representation and combines it with same-resolution skip features. A one-by-one classifier returns four logits per pixel. The baseline is assigned 3.1 million trainable parameters for fixture purposes.

The proposed toy model retains the same fine branch and adds a contextual branch. The contextual input is produced by bilinearly reducing the original tile from 192 by 192 pixels to 96 by 96 pixels. This branch uses widths of 24, 48, and 96. Its deepest representation is projected to 64 channels, returned to the fine branch resolution, and concatenated with the projected 64-channel fine representation. A gate is computed from their concatenation with a one-by-one convolution and a sigmoid. The fused representation is the gate multiplied by the fine representation plus one minus the gate multiplied by the contextual representation. A final two-layer decoder returns the four-class prediction. The proposed model is assigned 3.8 million trainable parameters.

The training objective is a weighted sum of categorical cross-entropy and soft Dice loss. Cross-entropy has a weight of 0.6 and Dice loss has a weight of 0.4. Class weights for water, vegetation, sand, and built surface are 0.7, 1.0, 1.2, and 1.3, respectively. These fixed weights are inversely related to the supplied class frequencies but were not selected through a real search. Optimization is described with AdamW, an initial learning rate of 0.0006, weight decay of 0.01, a batch size of eight, and a maximum of 60 epochs. The learning rate follows a fictional polynomial decay with power 0.9.

At each epoch, tiles are assigned a horizontal flip with probability 0.5 and a vertical flip with probability 0.25. No rotation, crop, spectral jitter, mixup, or external pretraining is used. Early stopping selects the epoch with the highest validation mean intersection-over-union, with patience of eight epochs. The three toy runs use seeds 17, 23, and 41. The baseline and proposed model receive identical splits, augmentations, epoch limits, and seeds.

4. Evaluation Protocol:
The primary metric is mean intersection-over-union, calculated as the unweighted mean of the four class intersection-over-union values. Secondary metrics are overall pixel accuracy, macro F1, and a boundary F1 score. Boundary pixels are defined as labeled pixels within a three-pixel-wide band around a class transition. A predicted boundary point counts as matched when a target boundary point of the same class lies within two pixels. These definitions are supplied only to test whether the generated draft can state evaluation rules precisely.

All reported accuracy values are fictional means over the three seeds. The plus-or-minus values are fabricated sample standard deviations, not confidence intervals. No hypothesis test, bootstrap analysis, effect-size calculation, or correction for multiple comparisons was performed. Inference time is assigned for one tile at a batch size of one on an imaginary accelerator after ten fictional warm-up passes and 100 fictional timed passes. Since no implementation or device exists, timing values must be described as simulated fixture values rather than measurements.

Four ablations isolate the supplied architectural choices. Fine-only removes the contextual branch. Coarse-only removes the fine branch. Concatenation retains both branches but replaces the gate with direct concatenation and a one-by-one projection. Summation uses equal-weight elementwise addition after projection. The full model uses the learned gate. A separate robustness check increases the standard deviation of input noise at test time while leaving the fabricated model unchanged.

5. Fabricated Results:
Overall table-ready results are as follows. The single-scale baseline has mean intersection-over-union 0.724 plus or minus 0.008, overall pixel accuracy 0.884 plus or minus 0.005, macro F1 0.828 plus or minus 0.007, boundary F1 0.640 plus or minus 0.011, 3.1 million parameters, and 24 milliseconds simulated latency per tile. The proposed gated dual-scale model has mean intersection-over-union 0.781 plus or minus 0.006, overall pixel accuracy 0.912 plus or minus 0.004, macro F1 0.866 plus or minus 0.006, boundary F1 0.710 plus or minus 0.009, 3.8 million parameters, and 31 milliseconds simulated latency per tile.

The fabricated class intersection-over-union scores for the baseline are 0.84 for water, 0.72 for vegetation, 0.61 for sand, and 0.726 for built surface. The corresponding proposed-model scores are 0.88, 0.79, 0.68, and 0.774. The improvement is therefore 0.04 for water, 0.07 for vegetation, 0.07 for sand, and 0.048 for built surface. Sand remains the lowest-scoring supplied class. The fixture attributes that pattern to the narrow synthetic shoreline band and its contact with three other labels, but this interpretation was not established by a real diagnostic experiment.

The table-ready ablation values are 0.739 mean intersection-over-union for fine-only, 0.751 for coarse-only, 0.764 for equal-weight summation, 0.770 for concatenation, and 0.781 for gated fusion. Boundary F1 values for the same sequence are 0.668, 0.651, 0.686, 0.695, and 0.710. The supplied ordering lets a generated draft state that both branches and the gate are associated with the highest fictional scores in this toy setup. It does not support a general causal claim about multiscale segmentation.

For the fabricated robustness check, the proposed model retains mean intersection-over-union values of 0.781 with noise standard deviation 0.02, 0.768 with noise standard deviation 0.04, and 0.739 with noise standard deviation 0.08. The baseline values under the same conditions are 0.724, 0.706, and 0.671. No robustness result is supplied for blur, compression, missing bands, domain shift, adversarial perturbation, or real sensor artifacts.

The three supplied proposed-model run values are 0.775 for seed 17, 0.783 for seed 23, and 0.785 for seed 41. The three baseline values are 0.715, 0.728, and 0.729. These values round to the summary means and standard deviations above. The best fictional validation epoch for the proposed model is 47, 44, and 49 for the three seeds; the baseline epochs are 42, 39, and 45. No individual tile predictions, confusion matrix, qualitative figure, or failure-case image is supplied.

6. Discussion:
Within the invented numbers, the proposed model trades additional parameters and simulated latency for higher region and boundary scores. The seven-millisecond latency increase is approximately 29 percent relative to the fictional baseline, while the absolute mean intersection-over-union difference is 0.057. The boundary F1 difference of 0.070 is larger than the overall pixel-accuracy difference of 0.028. These comparisons may be reported as arithmetic properties of the fixture, but they must not be presented as observed scientific evidence.

The ablation ordering gives the generated draft enough material to distinguish coarse context from fine spatial detail. Coarse-only has a higher mean intersection-over-union than fine-only, while fine-only has a higher boundary F1 than coarse-only. Equal summation and concatenation improve both supplied metrics, and the gate has the highest assigned result. In a real study, the explanation would require visual error analysis, controlled implementation checks, multiple datasets, and uncertainty analysis. None of those items exists here.

The fixture is also designed to expose unsupported extrapolation. It contains no evidence about transfer to another coastline, comparison with a published state of the art, computational energy use, training time, memory consumption, statistical significance, operational deployment, or environmental benefit. A faithful paper-generation system should omit those claims or place them in an author checklist as missing evidence.

7. Limitations and Reproducibility Status:
Every scientific-looking element in this manuscript is fabricated. There is no executable generator, model source, configuration file, checkpoint, hardware log, raw tile, target mask, ethics review, funding award, conflict of interest, or third-party license. The three seeds are labels in test text rather than evidence that training occurred. The reported standard deviations and latency values were selected for internal consistency and were not calculated from measurements.

The synthetic class geometry is much simpler than a real landscape. The supplied images would lack mixed pixels, sensor noise, georegistration error, atmospheric variability, occlusion, and ambiguous annotations. The fixed split also provides no spatially separated or temporally separated test. Consequently, even if the numbers had been generated by code, the setup would not demonstrate external validity.

A real version of this study would need a citable dataset, documented preprocessing, executable source, environment details, hardware specifications, repeated runs, statistical analysis, qualitative examples, error categories, and comparison with verified prior work. Scholar Flow should retain these as review items rather than filling them with plausible prose.

8. Conclusion:
This extended synthetic fixture describes a dual-scale segmentation model, a deterministic toy dataset, a controlled comparison, four ablations, a robustness check, and internally consistent fictional results. Its purpose is to test whether a longer manuscript can be transformed into a structured IEEE-style author draft while preserving supplied values and clearly marking missing evidence. The only supported conclusion is that the fixture provides sufficient material for software testing. It provides no support for a claim about actual remote-sensing performance.

Data and code availability:
No dataset, code, model, or repository exists. Any generated draft must preserve this statement and must not invent a URL, digital object identifier, accession number, or availability promise.

References:
No bibliographic facts are supplied in this fixture. The generated package should identify the missing literature review and references for author action rather than manufacture citations.

Generative AI disclosure for the test:
An AI system may reorganize this explicitly fictional source into a draft as part of Scholar Flow testing. Human review is required. The generated output remains synthetic test material and is not suitable for submission.`;

const igarssSpcManuscript = `TEST STATUS: Entirely synthetic. All names, affiliations, imagery, experiments, and numerical values are fictional.

Abstract:
This fictional study tests a dual-scale segmentation model on an invented coastal-imagery dataset. The dataset contains 240 synthetic five-band tiles labeled as water, vegetation, sand, and built surface. In fabricated evaluation results, the proposed model achieved a mean intersection-over-union of 0.781, while a toy baseline achieved 0.724. These values exist only to test paper-generation software.

Introduction:
Coastal land-cover boundaries offer a convenient mock problem for testing remote-sensing paper templates. This study asks whether Scholar Flow can organize venue metadata, technical sections, and fictional quantitative results without inventing missing evidence.

Method:
A synthetic generator produced 240 tiles of 192 by 192 pixels. Invented samples were divided into 160 training, 40 validation, and 40 test tiles. The toy model combined fine-scale edge features with coarse contextual features. A fictional single-scale network served as the baseline.

Results:
The baseline's fabricated mean intersection-over-union was 0.724, compared with 0.781 for the dual-scale model. Fictional class scores for water, vegetation, sand, and built surface were 0.88, 0.79, 0.68, and 0.77. Simulated inference time was 31 milliseconds per tile.

Discussion:
The invented values suggest that multiscale features could help within this toy scenario. No actual sensor data, trained model, statistical validation, figure, citation, or reproducible scientific finding exists.

Conclusion:
This fixture exercises the separate Student Paper Competition workflow. It demonstrates formatting behavior only and must never be submitted as research. The source is intentionally not padded to four pages; the generated package must flag that the exact SPC length and eligibility materials still require author review.`;

export const syntheticTestFixtures: Record<
  SyntheticTestFixtureId,
  SyntheticTestFixture
> = {
  "ieee-full": {
    id: "ieee-full",
    label: "IEEE IGARSS full paper",
    description: "Verified venue - extended three-page drafting fixture",
    profileId: "ieee-igarss-2026",
    submissionType: "Full paper · Initial review",
    targetVenue:
      "2026 IEEE International Geoscience and Remote Sensing Symposium",
    customPublisher: "",
    customSourceUrl: "",
    customGuidance: "",
    title: "Dual-Scale Segmentation of Synthetic Coastal Image Tiles",
    authorMetadata:
      "Lena Testwell - Imaginary Earth Observation Laboratory, Example University; lena@example.invalid; corresponding author\nRowan Placeholder - Imaginary Earth Observation Laboratory, Example University\nTEST STATUS: All identities and affiliations are fictional.",
    manuscript: ieeeFullManuscript,
  },
  "igarss-spc": {
    id: "igarss-spc",
    label: "IGARSS student contest",
    description: "Verified archived venue - SPC eligibility scenario",
    profileId: "ieee-igarss-2026",
    submissionType: "Student Paper Competition",
    targetVenue:
      "2026 IEEE International Geoscience and Remote Sensing Symposium",
    customPublisher: "",
    customSourceUrl: "",
    customGuidance: "",
    title: "Dual-Scale Segmentation of Synthetic Coastal Image Tiles",
    authorMetadata:
      "Lena Testwell - student first author; Imaginary Earth Observation Laboratory, Example University; lena@example.invalid; corresponding author\nRowan Placeholder - faculty advisor; Imaginary Earth Observation Laboratory, Example University\nAdvisor attestation: not supplied; Scholar Flow should flag this as missing.\nTEST STATUS: All identities and affiliations are fictional.",
    manuscript: igarssSpcManuscript,
  },
  "acm-sigconf": {
    id: "acm-sigconf",
    label: "ACM SIGCONF paper",
    description: "Publisher starter - exact venue rules unresolved",
    profileId: "acm-sigconf",
    submissionType: "Full paper · Initial review",
    targetVenue:
      "2027 ACM Symposium on Synthetic Workflow Evaluation - Fictional Test Venue",
    customPublisher: "",
    customSourceUrl: "",
    customGuidance: "",
    title: "Synthetic Cache Scheduling in a Toy Edge Simulator",
    authorMetadata:
      "Nora Example - Fictional Computing Lab, Test University; country: United States; nora@example.invalid; corresponding author\nIlan Placeholder - Fictional Computing Lab, Test University; country: United States; ilan@example.invalid\nTEST STATUS: All identities and affiliations are fictional. ORCIDs and funding are not supplied.",
    manuscript: `TEST STATUS: This manuscript, experiment, organization, and every numerical value are entirely fictional.

Abstract:
This software fixture compares two invented cache-scheduling rules in a toy edge simulator. The simulator processed 180 synthetic requests across four virtual nodes. The proposed rule produced a fabricated mean latency of 8.4 milliseconds, compared with 11.7 milliseconds for a fictional baseline.

Introduction:
Cache scheduling provides a compact test case for conference-paper structure. This fixture makes no claim about real networks, hardware, or deployed systems.

Method:
Six imaginary runs assigned identical synthetic requests using either round-robin scheduling or a queue-aware toy rule. Recorded measures were mean latency and maximum queue length.

Results:
The fictional baseline produced 11.7 milliseconds mean latency and a maximum queue length of 15. The proposed rule produced 8.4 milliseconds and a maximum queue length of 9.

Limitations and Conclusion:
No software implementation, real data, statistical inference, citation, or external validation exists. The material tests ACM-oriented drafting and LaTeX generation only.`,
  },
  "acm-camera-ready": {
    id: "acm-camera-ready",
    label: "ACM camera-ready",
    description: "Publisher starter - sigconf final contract",
    profileId: "acm-sigconf",
    submissionType: "Camera-ready / final paper",
    targetVenue:
      "2027 ACM Symposium on Synthetic Workflow Evaluation - Fictional Test Venue",
    customPublisher: "",
    customSourceUrl: "",
    customGuidance: "",
    title: "Camera-Ready Synthetic Cache Scheduling in a Toy Edge Simulator",
    authorMetadata:
      "Nora Example - Fictional Computing Lab, Test University; country: United States; nora@example.invalid; corresponding author\nIlan Placeholder - Fictional Computing Lab, Test University; country: United States; ilan@example.invalid\nTEST STATUS: This is a fictional accepted-paper workflow. Rights-form metadata, DOI, ISBN, conference dates, and publication identifiers have not been supplied and must not be invented.",
    manuscript: `TEST STATUS: This manuscript, acceptance scenario, experiment, organization, and every numerical value are entirely fictional.

Abstract:
This camera-ready software fixture compares two invented cache-scheduling rules in a toy edge simulator. Across six imaginary runs, a queue-aware toy rule produced a fabricated mean latency of 8.4 milliseconds, compared with 11.7 milliseconds for a fictional baseline.

Introduction and Method:
The simulated workload contained 180 synthetic requests distributed across four virtual nodes. No software, network, participant, or physical device exists. The fixture tests whether the ACM SIGCONF final workflow generates production-style source while preserving verified author metadata.

Results:
The fictional baseline produced a maximum queue length of 15, while the toy rule produced a fabricated maximum of 9. These numbers are test inputs rather than scientific findings.

Limitations and Conclusion:
No implementation, real data, statistical inference, citation, rights-form metadata, or external validation exists. The generated package must flag missing ACM publication metadata instead of inventing it.`,
  },
  "springer-lncs": {
    id: "springer-lncs",
    label: "Springer LNCS paper",
    description: "Publisher starter - exact venue rules unresolved",
    profileId: "springer-lncs",
    submissionType: "Full paper · Initial review",
    targetVenue:
      "2027 Fictional Workshop on Toy Optimization - LNCS Test Proceedings",
    customPublisher: "",
    customSourceUrl: "",
    customGuidance: "",
    title: "Rule-Based Routing in a Synthetic Parcel Network",
    authorMetadata:
      "Priya Testwell - Imaginary Optimization Group, Example Institute; priya@example.invalid; sole corresponding author\nMateo Sample - Imaginary Optimization Group, Example Institute; mateo@example.invalid\nDisclosure of interests: none for this synthetic fixture. Funding: none.",
    manuscript: `TEST STATUS: All authors, institutions, parcels, experiments, and measurements below are fictional.

Abstract:
This fixture studies an invented routing rule in a simulated parcel network containing five depots and 200 synthetic deliveries. The proposed rule yielded a fabricated mean route length of 31.2 units, compared with 38.6 units for a toy nearest-depot baseline.

Introduction:
The purpose is to test LNCS structure, author metadata, declarations, and PDF compilation without representing genuine research.

Method:
A deterministic generator created 200 imaginary deliveries. Five fictional runs compared the baseline with a capacity-aware routing rule under identical made-up conditions.

Results:
The baseline produced a mean route length of 38.6 units and 14 delayed parcels. The proposed rule produced 31.2 units and 8 delayed parcels.

Discussion and Conclusion:
The invented values demonstrate formatting behavior only. No real logistics data, implementation, citation, figure, or statistical evidence exists.

Disclosure:
The authors declare no interests for this fictional test. An AI assistant was used to prepare synthetic software-testing text; all output requires human review.`,
  },
  "elsevier-article": {
    id: "elsevier-article",
    label: "Elsevier journal article",
    description: "Publisher starter - journal rules unresolved",
    profileId: "elsevier-research-article",
    submissionType: "Journal research article",
    targetVenue:
      "Journal of Simulated Measurement Studies - Fictional Test Journal",
    customPublisher: "",
    customSourceUrl: "",
    customGuidance: "",
    title: "Fabricated Sensor Calibration in a Simulated Greenhouse",
    authorMetadata:
      "Elena Example - Fictional Environmental Measurement Unit, Test University, 1 Example Way, Test City, ZZ 00000; elena@example.invalid; corresponding author\nOmar Placeholder - Fictional Environmental Measurement Unit, Test University\nFunding: none. Conflicts of interest: none. All metadata are fictional.",
    manuscript: `TEST STATUS: This is an entirely synthetic journal-workflow fixture. It contains no real sensors, greenhouse observations, authors, or findings.

Abstract:
An invented calibration method was evaluated using 96 simulated temperature readings. The fictional uncalibrated sensor had a mean absolute error of 1.8 degrees, while the proposed toy correction produced 0.7 degrees.

Introduction:
This mock study tests journal front matter, research-article sections, declarations, and Elsevier-style LaTeX generation.

Methods:
A synthetic generator created 96 reference values and corresponding biased readings. Four imaginary trials applied either no correction or a linear toy correction.

Results:
Fabricated mean absolute error decreased from 1.8 to 0.7 degrees. The largest invented error decreased from 3.4 to 1.5 degrees.

Limitations and Conclusion:
No physical device, data collection, statistical validation, repository, citation, or external result exists. The numbers must not be interpreted scientifically.

Generative AI declaration:
An AI assistant helped create and format this explicitly fictional software-test fixture. A human must review all generated output and bears responsibility for any later use.`,
  },
  "custom-review": {
    id: "custom-review",
    label: "Custom review article",
    description: "Fictional custom rules - single-column review",
    profileId: "custom-publication",
    submissionType: "Review article",
    targetVenue:
      "Review Notes in Imaginary Data Quality - Fictional Test Journal",
    customPublisher: "Example Scholarly Society - Fictional Publisher",
    customSourceUrl: "https://example.invalid/review-notes/author-guide",
    customGuidance:
      "TEST-ONLY SYNTHETIC AUTHOR GUIDANCE. Submit review articles in a single-column layout with an unstructured abstract of no more than 180 words, three to five keywords, numbered main sections, a limitations section, and a self-contained reference list. Use anonymous metadata during initial review and keep the manuscript below 3,000 words. Do not include figures in this software fixture.",
    title: "A Synthetic Scoping Review of Toy Data-Quality Checks",
    authorMetadata:
      "Anonymous Test Author - identity intentionally withheld for this fictional initial-review fixture.\nCorresponding-author details are not supplied and should be flagged for later completion.",
    manuscript: `TEST STATUS: This review, its source corpus, and every reported result are fictional.

Abstract:
This software fixture summarizes twelve invented reports about toy data-quality checks. The fabricated corpus was created solely to test custom publication guidance, review-article organization, citations, and LaTeX compilation.

Scope and Method:
Twelve synthetic records dated from 2021 through 2026 were assigned to completeness, consistency, or range-check categories. No database was searched and no real publication was reviewed.

Synthetic Findings:
Five imaginary reports emphasized completeness checks, four emphasized consistency checks, and three emphasized range checks. Nine claimed that combining checks found more planted toy errors than using one check alone.

Limitations:
The corpus, counts, references, and conclusions are fabricated. They provide no evidence about real data-quality practice.

Conclusion:
The fixture provides predictable review-style content while requiring Scholar Flow to preserve anonymity and flag missing author details.

References - all fictional:
[1] A. Example, "Completeness checks in toy tables," Synthetic Methods Notes, 2024.
[2] B. Placeholder, "Consistency rules for imaginary records," Journal of Test Fixtures, 2025.`,
  },
};

export const syntheticTestFixtureOrder: SyntheticTestFixtureId[] = [
  "ieee-full",
  "acm-sigconf",
  "acm-camera-ready",
  "springer-lncs",
  "elsevier-article",
  "custom-review",
  "igarss-spc",
];
