/**
 * Shared content-intelligence type definitions.
 *
 * Consumed by `ContentIntelligenceService` and `services/media/fingerprint`.
 * Kept dependency-free so it can be imported from anywhere in pc2-node
 * without dragging in node-only or browser-only modules.
 */

// ────────────────────────────────────────────────────────────────
// Perceptual hashing
// ────────────────────────────────────────────────────────────────

export type HashAlgorithm =
  | 'phash'
  | 'dhash'
  | 'ahash'
  | 'whash'
  | 'chromaprint'
  | 'shingle'
  | 'simhash';

export interface PerceptualHashResult {
  /** Per-frame / per-tile image hashes when available. */
  imageHashes?: string[];
  /** Audio fingerprint string (e.g. chromaprint output). */
  audioFingerprint?: string;
  /** Text shingles for textual similarity comparisons. */
  textShingles?: string[];
  /** SimHash for text/document content. */
  textHash?: string;
  /** A single representative hash used for similarity lookups. */
  dominantHash: string;
  /** Algorithm used to produce `dominantHash`. */
  algorithm: HashAlgorithm;
  /** ISO-8601 timestamp of when the hash was computed. */
  computedAt: string;
}

// ────────────────────────────────────────────────────────────────
// Content analysis input
// ────────────────────────────────────────────────────────────────

export interface ContentAnalysisParams {
  filePath: string;
  mimeType: string;
  fileSize: number;
  /** Pre-computed sha256 (hex) if the caller already has it. */
  existingHash?: string;
}

// ────────────────────────────────────────────────────────────────
// Content classification (topics, language, complexity)
// ────────────────────────────────────────────────────────────────

export interface ContentClassification {
  topics: string[];
  language: string;
  /** 0–1 (0 = simple, 1 = highly technical). */
  complexity: number;
  contentType: string;
  genre?: string;
  keywords?: string[];
}

// ────────────────────────────────────────────────────────────────
// Quality assessment (production value, technical attributes)
// ────────────────────────────────────────────────────────────────

export interface QualityAssessment {
  resolution?: string;
  bitrate?: number;
  duration?: number;
  sampleRate?: number;
  channels?: number;
  /** 0–1 quality / production-value score. */
  productionScore: number;
  technicalNotes?: string[];
}

// ────────────────────────────────────────────────────────────────
// Safety assessment (adult content, violence, copyright risk)
// ────────────────────────────────────────────────────────────────

export interface SafetyAssessment {
  adultContent: boolean;
  violence: boolean;
  /** 0–1 copyright-risk score. */
  copyrightRisk: number;
  /** 0–1 overall safety score (1 = safe). */
  safetyScore: number;
  flags: string[];
  blocked: boolean;
  warnings?: string[];
}

// ────────────────────────────────────────────────────────────────
// Provenance (originality, similarity to existing content)
// ────────────────────────────────────────────────────────────────

export interface ContentProvenance {
  /** sha256 of original bytes (hex). */
  originalHash: string;
  perceptualHash?: string;
  audioFingerprint?: string;
  /** ISO-8601 timestamp of first observed publication. */
  firstPublished: string;
  similarContentFound: boolean;
  /** 0–1 similarity to closest existing match (when found). */
  similarityScore?: number;
}

// ────────────────────────────────────────────────────────────────
// Aggregate report returned by ContentIntelligenceService.analyze()
// ────────────────────────────────────────────────────────────────

export interface ContentIntelligenceReport {
  classification: ContentClassification;
  quality: QualityAssessment;
  safety: SafetyAssessment;
  provenance: ContentProvenance;
  /** ISO-8601 timestamp of when the analysis completed. */
  analyzedAt: string;
  /** Identifier of the analyzer (service + version). */
  analyzedBy: string;
}
