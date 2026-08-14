import assert from "node:assert/strict";
import test from "node:test";

import {
  DEFAULT_SCORE,
  PERFORMANCE_DURATION_MS,
  compileScore,
  normalizeScore,
  parseScoreFragment,
  scheduleDigest,
  serializeScore,
} from "../src/shared/score.mjs";

test("default public score round trips through the URL grammar", () => {
  const fragment = serializeScore(DEFAULT_SCORE);
  assert.match(fragment, /^#score\/1\//);
  assert.deepEqual(parseScoreFragment(fragment), normalizeScore(DEFAULT_SCORE));
});

test("compiler is deterministic and finite at exactly 88 seconds", async () => {
  const first = compileScore(DEFAULT_SCORE);
  const second = compileScore(DEFAULT_SCORE);
  assert.deepEqual(first, second);
  assert.equal(first.durationMs, PERFORMANCE_DURATION_MS);
  assert.ok(first.events.length > 80);
  assert.ok(first.events.every((event) => event.atMs >= 0));
  assert.ok(first.events.every((event) => event.atMs + event.durationMs <= PERFORMANCE_DURATION_MS));
  assert.equal(await scheduleDigest(first), await scheduleDigest(second));
});

test("strict score validation rejects code-like and out-of-range data", () => {
  assert.throws(() => normalizeScore({ ...DEFAULT_SCORE, bpm: 200 }), /bpm/);
  assert.throws(() => normalizeScore({ ...DEFAULT_SCORE, script: "alert(1)" }), /unknown field/);
  assert.throws(() => normalizeScore({ ...DEFAULT_SCORE, palette: ["air", "air"] }), /unique/);
  assert.throws(() => parseScoreFragment("#score/1/not-hex/96/2/lydian/stride/gather-turn-release-home/air+glass/2-3-4-2/0-1-2-3-4-5-6-7"), /seed/);
});

test("the resolved home section is rooted and contains real events", () => {
  const schedule = compileScore(DEFAULT_SCORE);
  const home = schedule.events.filter((event) => event.movement === 3);
  assert.ok(home.length > 0);
  assert.ok(home.some((event) => event.motifIndex === 0));
});

test("every valid maximum-density score remains compilable", () => {
  const dense = normalizeScore({
    ...DEFAULT_SCORE,
    seed: "ffffffff",
    bpm: 144,
    motion: "rush",
    palette: ["round-bass", "wood", "glass", "trill"],
    energy: [5, 5, 5, 5],
  });
  const schedule = compileScore(dense);
  assert.ok(schedule.events.length > 512);
  assert.ok(schedule.events.every((event) => event.atMs + event.durationMs <= PERFORMANCE_DURATION_MS));
});
