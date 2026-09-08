/**
 * Question detection (PRD §10).
 *
 * The job is narrow and important: decide *when* the interviewer has finished asking
 * something, so the LLM fires once on a complete question instead of on every partial
 * transcript. §9 is explicit about the failure mode to avoid:
 *
 *     "I wanted to ask..."
 *     "I wanted to ask how..."
 *     "I wanted to ask how you would..."
 *     "I wanted to ask how you would design a URL shortener."   <- only this should fire
 *
 * Firing early wastes tokens and shows the user an answer to half a question; firing late
 * eats the §30 latency budget. Pure logic, no I/O, so it can be tested exhaustively.
 */

export type Speaker = "interviewer" | "candidate" | "unknown";

export interface TranscriptChunk {
  /** Text of this chunk. Partial chunks are revisions, not additions. */
  text: string;
  /** Streaming STT emits unstable partials, then a stable final for the segment. */
  isFinal: boolean;
  /** Monotonic ms timestamp from the audio clock. */
  atMs: number;
  /** When diarization is available, candidate speech never triggers a question. */
  speaker?: Speaker;
}

export type DetectionReason =
  | "terminal-question-mark"
  | "imperative-prompt"
  | "silence-after-interrogative";

export interface DetectedQuestion {
  text: string;
  reason: DetectionReason;
  confidence: number;
  atMs: number;
}

export interface QuestionDetectorOptions {
  /** Quiet time after the last final chunk before a pending utterance may fire. */
  silenceMs?: number;
  /** Utterances shorter than this can only fire via an explicit "?". */
  minWords?: number;
  /** Detections below this confidence are suppressed. */
  minConfidence?: number;
}

const DEFAULTS = {
  silenceMs: 900,
  minWords: 4,
  minConfidence: 0.6,
} as const;

/** Backchannel noise. Never a question, even with a question mark. */
const ACKNOWLEDGEMENTS = new Set([
  "ok", "okay", "right", "sure", "yeah", "yes", "no", "nope", "yep", "cool",
  "gotcha", "got it", "makes sense", "understood", "thanks", "thank you",
  "mm hmm", "mhm", "uh huh", "alright", "all right", "perfect", "great", "nice",
  "really", "seriously", "oh", "hmm", "huh", "wow", "interesting", "fair enough",
]);

/** Question-initial words: wh-words plus inverted auxiliaries. */
const INTERROGATIVE_OPENERS = new Set([
  "what", "why", "how", "when", "where", "which", "who", "whom", "whose",
  "can", "could", "would", "will", "shall", "should", "do", "does", "did",
  "is", "are", "was", "were", "have", "has", "had", "may", "might",
]);

/**
 * Prompts that demand an answer but carry no question mark.
 * "Tell me about a time you handled an outage." is a question in every sense that matters.
 */
const IMPERATIVE_PROMPT =
  /^(tell me|walk me through|talk me through|take me through|describe|explain|give me|share|suppose|imagine|consider|let'?s say|let'?s talk|say more)\b/;

/**
 * An interrogative buried mid-sentence — the §9 case. "I wanted to ask how you would
 * design a URL shortener." opens with a declarative but is unmistakably a question.
 */
const EMBEDDED_INTERROGATIVE =
  /\b(how|what|why|when|where|which|who)\s+(you|we|i|they|it|he|she|would|do|does|did|is|are|can|could|should|might)\b/;

/** Softened lead-ins that mark a question even without a wh-word. */
const QUESTION_LEAD_IN =
  /\b(i (wanted|want|would like|'?d like) to (ask|know|hear|understand)|i'?m curious|i wonder|wondering (if|whether|how|what)|any thoughts|your thoughts)\b/;

const normalize = (s: string): string =>
  s.toLowerCase().replace(/[^\p{L}\p{N}\s']/gu, " ").replace(/\s+/g, " ").trim();

const wordCount = (s: string): number => (normalize(s) === "" ? 0 : normalize(s).split(" ").length);

const isAcknowledgement = (s: string): boolean => ACKNOWLEDGEMENTS.has(normalize(s));

const startsInterrogative = (s: string): boolean => {
  const first = normalize(s).split(" ")[0];
  return first !== undefined && INTERROGATIVE_OPENERS.has(first);
};

const looksLikeQuestion = (s: string): boolean => {
  const n = normalize(s);
  return (
    startsInterrogative(n) ||
    IMPERATIVE_PROMPT.test(n) ||
    EMBEDDED_INTERROGATIVE.test(n) ||
    QUESTION_LEAD_IN.test(n)
  );
};

export class QuestionDetector {
  readonly #opts: Required<QuestionDetectorOptions>;
  #buffer: string[] = [];
  #lastFinalAtMs = 0;
  #lastEmitted = "";

  constructor(options: QuestionDetectorOptions = {}) {
    this.#opts = { ...DEFAULTS, ...options };
  }

  /** Text accumulated but not yet emitted. Exposed for UI ("listening…") and tests. */
  get pending(): string {
    return this.#buffer.join(" ").replace(/\s+/g, " ").trim();
  }

  /**
   * Feed a transcript chunk. Returns a question the moment one is complete enough to
   * answer, otherwise null. Partial chunks never fire — that is the whole point.
   */
  push(chunk: TranscriptChunk): DetectedQuestion | null {
    if (chunk.speaker === "candidate") return null;
    if (!chunk.isFinal) return null;

    const text = chunk.text.trim();
    if (text === "") return null;

    this.#buffer.push(text);
    this.#lastFinalAtMs = chunk.atMs;

    const pending = this.pending;
    if (isAcknowledgement(pending)) {
      this.#buffer = [];
      return null;
    }

    // An explicit "?" is the strongest signal available; act on it immediately rather
    // than paying the silence timeout.
    if (/\?\s*$/.test(pending) && wordCount(pending) >= 1) {
      return this.#emit(pending, "terminal-question-mark", 0.95, chunk.atMs);
    }

    // "Tell me about X." — a directive with terminal punctuation and no question mark.
    if (/[.!]\s*$/.test(pending) && IMPERATIVE_PROMPT.test(normalize(pending))) {
      if (wordCount(pending) >= this.#opts.minWords) {
        return this.#emit(pending, "imperative-prompt", 0.85, chunk.atMs);
      }
    }

    return null;
  }

  /**
   * Advance the clock. Call on a timer: an utterance that never got a question mark still
   * needs to fire once the speaker has clearly stopped.
   */
  tick(nowMs: number): DetectedQuestion | null {
    const pending = this.pending;
    if (pending === "") return null;
    if (nowMs - this.#lastFinalAtMs < this.#opts.silenceMs) return null;

    if (wordCount(pending) >= this.#opts.minWords && looksLikeQuestion(pending)) {
      return this.#emit(pending, "silence-after-interrogative", 0.7, nowMs);
    }

    // Silence with nothing question-shaped: statement or filler. Drop it so it cannot
    // contaminate the next utterance.
    this.#buffer = [];
    return null;
  }

  reset(): void {
    this.#buffer = [];
    this.#lastFinalAtMs = 0;
    this.#lastEmitted = "";
  }

  #emit(
    text: string,
    reason: DetectionReason,
    confidence: number,
    atMs: number,
  ): DetectedQuestion | null {
    this.#buffer = [];
    if (confidence < this.#opts.minConfidence) return null;
    if (normalize(text) === normalize(this.#lastEmitted)) return null; // never answer twice
    this.#lastEmitted = text;
    return { text, reason, confidence, atMs };
  }
}
