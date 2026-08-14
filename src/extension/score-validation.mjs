// The build copies ../shared beside extension files, so this source-relative
// import is rewritten to the packaged ./shared location during build.
import { normalizeScore } from "../shared/score.mjs";

export const MAX_SCORE_BYTES = 2 * 1024;

export function inspectAgentScore(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return Object.freeze({ ok: false, reason: "score-object-required" });
  }

  let encoded;
  try {
    encoded = JSON.stringify(input);
  } catch {
    return Object.freeze({ ok: false, reason: "score-not-serializable" });
  }

  if (typeof encoded !== "string") {
    return Object.freeze({ ok: false, reason: "score-not-serializable" });
  }
  if (new TextEncoder().encode(encoded).byteLength > MAX_SCORE_BYTES) {
    return Object.freeze({ ok: false, reason: "score-too-large" });
  }

  try {
    return Object.freeze({ ok: true, score: normalizeScore(JSON.parse(encoded)) });
  } catch {
    return Object.freeze({ ok: false, reason: "score-invalid" });
  }
}
