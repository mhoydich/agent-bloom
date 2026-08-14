export const SCORE_VERSION = 1;
export const PROTOCOL = "tonebloom.agent.v1";
export const ENGINE_VERSION = "agent-bloom/1.0.0";
export const PERFORMANCE_DURATION_MS = 88_000;
export const MOVEMENT_DURATION_MS = 22_000;
export const HOME_START_MS = 83_500;
export const MAX_COMPILED_EVENTS = 2_048;

export const MODES = Object.freeze([
  "major-pentatonic",
  "minor-pentatonic",
  "dorian",
  "lydian",
  "mixolydian",
]);

export const MOTIONS = Object.freeze(["drift", "stride", "skip", "rush"]);

export const ARCS = Object.freeze([
  "arrive-lift-bloom-home",
  "gather-turn-release-home",
  "scatter-align-bloom-home",
]);

export const VOICES = Object.freeze([
  "round-bass",
  "wood",
  "glass",
  "warm-brass",
  "air",
  "trill",
]);

export const DEFAULT_SCORE = Object.freeze({
  version: SCORE_VERSION,
  seed: "56a01001",
  bpm: 96,
  root: 2,
  mode: "lydian",
  motion: "stride",
  arc: "gather-turn-release-home",
  palette: Object.freeze(["round-bass", "wood", "glass", "air"]),
  energy: Object.freeze([2, 3, 5, 3]),
  motif: Object.freeze([0, 2, 4, 6, 4, 2, 1, 0]),
});

const SCORE_KEYS = Object.freeze([
  "version",
  "seed",
  "bpm",
  "root",
  "mode",
  "motion",
  "arc",
  "palette",
  "energy",
  "motif",
]);

const MODE_INTERVALS = Object.freeze({
  "major-pentatonic": Object.freeze([0, 2, 4, 7, 9, 12, 14, 16]),
  "minor-pentatonic": Object.freeze([0, 3, 5, 7, 10, 12, 15, 17]),
  dorian: Object.freeze([0, 2, 3, 5, 7, 9, 10, 12]),
  lydian: Object.freeze([0, 2, 4, 6, 7, 9, 11, 12]),
  mixolydian: Object.freeze([0, 2, 4, 5, 7, 9, 10, 12]),
});

const ARC_SHAPES = Object.freeze({
  "arrive-lift-bloom-home": Object.freeze({
    voiceFractions: Object.freeze([0.5, 0.75, 1, 0.5]),
    intensity: Object.freeze([0.48, 0.74, 1, 0.42]),
  }),
  "gather-turn-release-home": Object.freeze({
    voiceFractions: Object.freeze([0.34, 0.67, 1, 0.5]),
    intensity: Object.freeze([0.42, 0.68, 0.9, 0.38]),
  }),
  "scatter-align-bloom-home": Object.freeze({
    voiceFractions: Object.freeze([0.75, 1, 0.67, 0.5]),
    intensity: Object.freeze([0.7, 0.88, 0.64, 0.34]),
  }),
});

const MOTION_PATTERNS = Object.freeze({
  drift: Object.freeze([0, 5]),
  stride: Object.freeze([0, 2, 4, 6]),
  skip: Object.freeze([0, 1, 3, 4, 6]),
  rush: Object.freeze([0, 1, 2, 3, 4, 5, 6, 7]),
});

const MOTION_DENSITY = Object.freeze({ drift: 0.34, stride: 0.5, skip: 0.62, rush: 0.78 });

const VOICE_OCTAVE = Object.freeze({
  "round-bass": -12,
  wood: 0,
  glass: 12,
  "warm-brass": 0,
  air: 12,
  trill: 24,
});

const VOICE_DURATION = Object.freeze({
  "round-bass": 0.84,
  wood: 0.34,
  glass: 0.78,
  "warm-brass": 0.72,
  air: 2.8,
  trill: 0.22,
});

function fail(message) {
  throw new TypeError(`Invalid AgentScoreV1: ${message}`);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}

function assertInteger(value, min, max, label) {
  if (!Number.isInteger(value) || value < min || value > max) {
    fail(`${label} must be an integer from ${min} to ${max}`);
  }
}

function strictInteger(value, label) {
  if (!/^-?\d+$/.test(value)) fail(`${label} must be an integer`);
  return Number(value);
}

export function normalizeScore(input) {
  if (!isPlainObject(input)) fail("score must be an object");

  const unknownKeys = Object.keys(input).filter((key) => !SCORE_KEYS.includes(key));
  const missingKeys = SCORE_KEYS.filter((key) => !(key in input));
  if (unknownKeys.length) fail(`unknown field ${unknownKeys[0]}`);
  if (missingKeys.length) fail(`missing field ${missingKeys[0]}`);

  if (input.version !== SCORE_VERSION) fail(`version must be ${SCORE_VERSION}`);
  if (typeof input.seed !== "string" || !/^[0-9a-f]{8}$/.test(input.seed)) {
    fail("seed must be exactly 8 lowercase hexadecimal characters");
  }

  assertInteger(input.bpm, 60, 144, "bpm");
  assertInteger(input.root, 0, 11, "root");
  if (!MODES.includes(input.mode)) fail("mode is not supported");
  if (!MOTIONS.includes(input.motion)) fail("motion is not supported");
  if (!ARCS.includes(input.arc)) fail("arc is not supported");

  if (!Array.isArray(input.palette) || input.palette.length < 2 || input.palette.length > 4) {
    fail("palette must contain 2 to 4 voices");
  }
  if (new Set(input.palette).size !== input.palette.length) fail("palette voices must be unique");
  input.palette.forEach((voice) => {
    if (!VOICES.includes(voice)) fail(`voice ${String(voice)} is not supported`);
  });

  if (!Array.isArray(input.energy) || input.energy.length !== 4) {
    fail("energy must contain exactly 4 movement values");
  }
  input.energy.forEach((value, index) => assertInteger(value, 1, 5, `energy[${index}]`));

  if (!Array.isArray(input.motif) || input.motif.length !== 8) {
    fail("motif must contain exactly 8 scale degrees");
  }
  input.motif.forEach((value, index) => assertInteger(value, 0, 7, `motif[${index}]`));

  return Object.freeze({
    version: SCORE_VERSION,
    seed: input.seed,
    bpm: input.bpm,
    root: input.root,
    mode: input.mode,
    motion: input.motion,
    arc: input.arc,
    palette: Object.freeze([...input.palette]),
    energy: Object.freeze([...input.energy]),
    motif: Object.freeze([...input.motif]),
  });
}

export function serializeScore(input) {
  const score = normalizeScore(input);
  return [
    "#score",
    score.version,
    score.seed,
    score.bpm,
    score.root,
    score.mode,
    score.motion,
    score.arc,
    score.palette.join("+"),
    score.energy.join("-"),
    score.motif.join("-"),
  ].join("/");
}

export function parseScoreFragment(fragment) {
  const source = String(fragment || "").replace(/^#/, "");
  const parts = source.split("/").map((part) => decodeURIComponent(part));
  if (parts.length !== 11 || parts[0] !== "score") {
    fail("fragment must match #score/1/…");
  }

  return normalizeScore({
    version: strictInteger(parts[1], "version"),
    seed: parts[2],
    bpm: strictInteger(parts[3], "bpm"),
    root: strictInteger(parts[4], "root"),
    mode: parts[5],
    motion: parts[6],
    arc: parts[7],
    palette: parts[8].split("+").filter(Boolean),
    energy: parts[9].split("-").map((value) => strictInteger(value, "energy")),
    motif: parts[10].split("-").map((value) => strictInteger(value, "motif")),
  });
}

export function canonicalScoreString(input) {
  return serializeScore(input).slice(1);
}

export async function sha256Hex(value) {
  if (!globalThis.crypto?.subtle) throw new Error("Web Crypto SHA-256 is unavailable");
  const encoded = new TextEncoder().encode(String(value));
  const digest = await globalThis.crypto.subtle.digest("SHA-256", encoded);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export async function createReceipt(input, state = "armed", takeoverEvents = 0) {
  const score = normalizeScore(input);
  const canonicalFragment = canonicalScoreString(score);
  const scoreHash = await sha256Hex(canonicalFragment);
  return Object.freeze({
    receiptId: `AB1-${scoreHash.slice(0, 12).toUpperCase()}`,
    scoreHash,
    engineVersion: ENGINE_VERSION,
    canonicalUrl: `#${canonicalFragment}`,
    durationMs: PERFORMANCE_DURATION_MS,
    state,
    takeoverEvents,
  });
}

function mulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state += 0x6d2b79f5;
    let value = state;
    value = Math.imul(value ^ (value >>> 15), value | 1);
    value ^= value + Math.imul(value ^ (value >>> 7), value | 61);
    return ((value ^ (value >>> 14)) >>> 0) / 4_294_967_296;
  };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

export function midiToFrequency(midi) {
  return 440 * 2 ** ((midi - 69) / 12);
}

export function compileScore(input) {
  const score = normalizeScore(input);
  const random = mulberry32(Number.parseInt(score.seed, 16));
  const scale = MODE_INTERVALS[score.mode];
  const arc = ARC_SHAPES[score.arc];
  const pattern = MOTION_PATTERNS[score.motion];
  const eighthMs = 30_000 / score.bpm;
  const events = [];

  // A fixed four-note handshake makes every valid score audible immediately
  // after an agent starts it. The notes still belong to the authored score:
  // their pitch, timbre and stereo placement derive from its motif and palette.
  for (let index = 0; index < 4; index += 1) {
    const voiceIndex = index % Math.min(2, score.palette.length);
    const voice = score.palette[voiceIndex];
    const degree = score.motif[index];
    const midi = clamp(48 + score.root + scale[degree] + VOICE_OCTAVE[voice], 28, 96);
    events.push(Object.freeze({
      atMs: index * 760,
      durationMs: voice === "air" ? 1_350 : 620,
      movement: 0,
      voice,
      voiceIndex,
      motifIndex: index,
      degree,
      midi,
      frequency: Math.round(midiToFrequency(midi) * 1000) / 1000,
      velocity: 0.46 + index * 0.025,
      pan: [-0.36, 0.28, -0.12, 0.42][index],
      identity: true,
    }));
  }

  for (let movement = 0; movement < 4; movement += 1) {
    const movementStart = movement * MOVEMENT_DURATION_MS;
    // Reserve the last 4.5 seconds for an unambiguous cadence. Randomly
    // generated events must never speak over the HOME chord.
    const movementEnd = Math.min(
      movementStart + MOVEMENT_DURATION_MS,
      movement === 3 ? HOME_START_MS : PERFORMANCE_DURATION_MS,
    );
    const activeVoiceCount = clamp(
      Math.ceil(score.palette.length * arc.voiceFractions[movement]),
      1,
      score.palette.length,
    );
    const activeVoices = score.palette.slice(0, activeVoiceCount);
    const energy = score.energy[movement];
    const probability = clamp(
      MOTION_DENSITY[score.motion] * (0.44 + energy * 0.12) * arc.intensity[movement],
      0.12,
      0.94,
    );
    const stepCount = Math.ceil(MOVEMENT_DURATION_MS / eighthMs);

    for (let step = 0; step < stepCount; step += 1) {
      const nominalAt = movementStart + step * eighthMs;
      if (nominalAt >= movementEnd - 180) break;

      for (let voiceIndex = 0; voiceIndex < activeVoices.length; voiceIndex += 1) {
        const voice = activeVoices[voiceIndex];
        const phase = (step + voiceIndex * 2 + movement) % 8;
        const onPattern = pattern.includes(phase);
        const voiceProbability = probability * (1 - voiceIndex * 0.09);
        const airPulse = voice === "air" && step % 8 === movement % 4;
        if (!airPulse && (!onPattern || random() > voiceProbability)) continue;

        const swing = score.motion === "skip" && step % 2 ? eighthMs * 0.16 : 0;
        const humanize = (random() - 0.5) * Math.min(22, eighthMs * 0.06);
        const at = Math.max(movementStart, nominalAt + swing + humanize);
        const motifIndex = (step + voiceIndex + movement * 2) % score.motif.length;
        const degree = score.motif[motifIndex];
        const inversion = voiceIndex > 1 && random() > 0.68 ? 12 : 0;
        const midi = clamp(48 + score.root + scale[degree] + VOICE_OCTAVE[voice] + inversion, 28, 96);
        const durationMs = Math.min(
          eighthMs * VOICE_DURATION[voice] * (voice === "air" ? 1.25 + energy * 0.09 : 1),
          PERFORMANCE_DURATION_MS - at - 24,
        );

        events.push(Object.freeze({
          atMs: Math.round(at * 1000) / 1000,
          durationMs: Math.max(80, Math.round(durationMs * 1000) / 1000),
          movement,
          voice,
          voiceIndex,
          motifIndex,
          degree,
          midi,
          frequency: Math.round(midiToFrequency(midi) * 1000) / 1000,
          velocity: Math.round(clamp(0.24 + energy * 0.075 + random() * 0.13, 0.24, 0.82) * 1000) / 1000,
          pan: Math.round(clamp((voiceIndex / Math.max(1, activeVoices.length - 1)) * 1.4 - 0.7 + (random() - 0.5) * 0.16, -0.82, 0.82) * 1000) / 1000,
        }));
      }
    }
  }

  const homeAt = HOME_START_MS;
  const homeSemitones = [0, 7, 12];
  score.palette.slice(0, 3).forEach((voice, index) => {
    const degree = index === 0 ? 0 : index === 1 ? 4 : 7;
    const midi = clamp(48 + score.root + homeSemitones[index] + VOICE_OCTAVE[voice], 28, 92);
    events.push(Object.freeze({
      atMs: homeAt + index * 72,
      durationMs: 4_300 - index * 72,
      movement: 3,
      voice,
      voiceIndex: index,
      motifIndex: index,
      degree,
      homeInterval: homeSemitones[index],
      midi,
      frequency: Math.round(midiToFrequency(midi) * 1000) / 1000,
      velocity: 0.52 - index * 0.04,
      pan: index === 0 ? 0 : index === 1 ? -0.22 : 0.22,
      home: true,
    }));
  });

  events.sort((a, b) => a.atMs - b.atMs || (a.voice < b.voice ? -1 : a.voice > b.voice ? 1 : 0));
  if (events.length > MAX_COMPILED_EVENTS) {
    throw new RangeError(`Compiled score exceeds ${MAX_COMPILED_EVENTS} events`);
  }
  for (const event of events) {
    if (event.atMs < 0 || event.durationMs <= 0 || event.atMs + event.durationMs > PERFORMANCE_DURATION_MS) {
      throw new RangeError("Compiled score contains an event outside the 88 second performance window");
    }
  }
  return Object.freeze({
    score,
    engineVersion: ENGINE_VERSION,
    durationMs: PERFORMANCE_DURATION_MS,
    movementDurationMs: MOVEMENT_DURATION_MS,
    movements: Object.freeze(["ARRIVE", "GATHER", "BLOOM", "HOME"]),
    events: Object.freeze(events),
  });
}

export async function scheduleDigest(input) {
  const compiled = input?.events ? input : compileScore(input);
  return sha256Hex(JSON.stringify(compiled.events));
}

export function describeContract() {
  return Object.freeze({
    protocol: PROTOCOL,
    scoreVersion: SCORE_VERSION,
    engineVersion: ENGINE_VERSION,
    durationMs: PERFORMANCE_DURATION_MS,
    fragmentGrammar: "#score/1/<seed>/<bpm>/<root>/<mode>/<motion>/<arc>/<voice+voice>/<e-e-e-e>/<n-n-n-n-n-n-n-n>",
    limits: Object.freeze({
      seed: "8 lowercase hex characters",
      bpm: Object.freeze([60, 144]),
      root: Object.freeze([0, 11]),
      palette: Object.freeze([2, 4]),
      queue: 3,
    }),
    values: Object.freeze({ modes: MODES, motions: MOTIONS, arcs: ARCS, voices: VOICES }),
    defaultScore: DEFAULT_SCORE,
  });
}
