import type { Lesson } from "./types.js";

/**
 * Lessons are matched by plain token overlap, on purpose. A reviewer who asks
 * "why did this line get that category?" gets an answer they can check with
 * their eyes: these words matched that earlier correction. Embeddings would
 * match more, and explain nothing.
 */

const STOPWORDS = new Set([
  "a", "an", "the", "of", "to", "for", "and", "or", "in", "on", "at", "by", "from", "with", "ref", "re",
]);

/** Lowercase, strip accents, drop digits and punctuation, drop stopwords and one-letter tokens. */
export function normalize(description: string): string[] {
  return description
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z\s]/g, " ")
    .split(/\s+/)
    .filter((token) => token.length > 1 && !STOPWORDS.has(token));
}

/** Canonical pattern for a description: unique sorted tokens. Two descriptions with the same pattern are "the same kind of line". */
export function patternOf(description: string): string {
  return [...new Set(normalize(description))].sort().join(" ");
}

export interface LessonMatch {
  lesson: Lesson;
  /** Jaccard similarity between the description tokens and the lesson pattern, 0..1. */
  score: number;
  sharedTokens: string[];
}

export interface LessonEngineOptions {
  /** Minimum Jaccard score to apply a lesson. Default 0.6. */
  threshold?: number;
  /** Minimum shared tokens, so a lesson never fires on one generic word. Default 2 (or the pattern length, if shorter). */
  minSharedTokens?: number;
}

export class LessonEngine {
  private readonly threshold: number;
  private readonly minSharedTokens: number;

  constructor(options: LessonEngineOptions = {}) {
    this.threshold = options.threshold ?? 0.6;
    this.minSharedTokens = options.minSharedTokens ?? 2;
  }

  /** Best matching lesson for a description, or null. Ties go to the most recently updated lesson. */
  match(description: string, lessons: readonly Lesson[]): LessonMatch | null {
    const tokens = new Set(normalize(description));
    if (tokens.size === 0) return null;

    let best: LessonMatch | null = null;
    for (const lesson of lessons) {
      const patternTokens = new Set(lesson.pattern.split(" ").filter(Boolean));
      if (patternTokens.size === 0) continue;
      const shared = [...tokens].filter((t) => patternTokens.has(t));
      const union = new Set([...tokens, ...patternTokens]).size;
      const score = shared.length / union;
      const required = Math.min(this.minSharedTokens, patternTokens.size);
      if (shared.length < required || score < this.threshold) continue;
      if (!best || score > best.score || (score === best.score && lesson.updatedAt > best.lesson.updatedAt)) {
        best = { lesson, score, sharedTokens: shared.sort() };
      }
    }
    return best;
  }

  /** Human-readable justification, meant for the review screen and the audit trail. */
  explain(match: LessonMatch): string {
    return `lesson ${match.lesson.id} matched with score ${match.score.toFixed(2)} on [${match.sharedTokens.join(", ")}]`;
  }
}
