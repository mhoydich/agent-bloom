import { AgentBloomAudio } from "./shared/audio.mjs";
import {
  DEFAULT_SCORE,
  PERFORMANCE_DURATION_MS,
  PROTOCOL,
  compileScore,
  createReceipt,
  describeContract,
  normalizeScore,
  parseScoreFragment,
  serializeScore,
} from "./shared/score.mjs";
import { AgentBloomVisuals } from "./visuals.mjs";

const ROOT_NAMES = Object.freeze(["C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B"]);
const TERMINAL_STATES = new Set(["complete", "stopped", "interrupted", "rejected", "failed", "ended-unconfirmed", "error"]);
const BRIDGE_SETTLED_STATES = new Set([
  "engine-confirmed",
  "playing",
  "blocked",
  "rejected",
  "failed",
  "stopped",
  "complete",
  "ended-unconfirmed",
]);
const ACTIVE_STATES = new Set(["validating", "queued", "engine-confirmed", "playing"]);
const STATE_LABELS = Object.freeze({
  idle: "STANDING BY",
  validating: "COMPOSING",
  armed: "ARMED",
  queued: "SCORE RECEIVED",
  "engine-confirmed": "ENGINE CONFIRMED",
  playing: "SIGNAL CONFIRMED",
  blocked: "AUDIO HELD BY BROWSER",
  complete: "HOME",
  stopped: "REST",
  interrupted: "REST",
  rejected: "SCORE REJECTED",
  failed: "ENGINE FAILED",
  "ended-unconfirmed": "SIGNAL UNCONFIRMED",
  error: "SCORE REJECTED",
});

document.body.innerHTML = `
  <main class="agent-bloom" data-tone-bloom-agent="v1" data-state="idle" data-transport="none">
    <header class="masthead">
      <a class="brand" href="https://tonebloom.xyz" aria-label="Tone Bloom home">TONE <span>BLOOM</span></a>
      <div class="edition">AGENT BLOOM · PUBLIC INSTRUMENT 01</div>
      <div class="duration">88 SECONDS</div>
    </header>

    <section class="score-head" aria-labelledby="agent-bloom-title">
      <div>
        <p class="eyebrow">A PUBLIC INSTRUMENT FOR BROWSER COMPANIONS</p>
        <h1 id="agent-bloom-title">AGENT<br>BLOOM</h1>
      </div>
      <div class="score-state">
        <span class="state-number">01</span>
        <strong id="performance-state" role="status" aria-live="polite" aria-atomic="true">STANDING BY</strong>
        <time id="remaining-time" datetime="PT88S" aria-label="88 seconds remaining">1:28</time>
      </div>
    </section>

    <section class="visual-frame" aria-label="Autonomous deterministic visualization of the current companion-authored score">
      <img class="poster-art" src="./assets/agent-bloom-og.png" alt="" draggable="false" aria-hidden="true">
      <canvas id="score-canvas" role="img" aria-label="The four movements Arrive, Gather, Bloom, and Home unfold from the current AgentScoreV1">
        AGENT BLOOM renders a deterministic four-movement score visualization.
      </canvas>
      <div class="movement-labels" aria-hidden="true">
        <span>01 ARRIVE</span><span>02 GATHER</span><span>03 BLOOM</span><span>04 HOME</span>
      </div>
    </section>

    <section class="score-receipt" aria-label="Current score and receipt">
      <div class="score-facts" id="score-facts"></div>
      <div class="receipt-block">
        <span>PUBLIC SCORE RECEIPT</span>
        <output id="receipt-id">PREPARING</output>
      </div>
    </section>

    <footer class="footer">
      <p>YOUR AI WRITES THE SCORE. TONE BLOOM MAKES IT SOUND.</p>
      <div class="footer-meta">
        <span>ORIGINAL BROWSER SYNTHESIS</span>
        <span>SIGNED 5.6 SOL · MIKE HOYDICH</span>
        <span>ENGINE 1.0</span>
      </div>
    </footer>

    <aside class="companion-controls" aria-labelledby="companion-control-title">
      <span id="companion-control-title">BROWSER COMPANION CONTROL</span>
      <div>
        <button id="agent-perform" type="button" data-agent-action="perform">AI: PERFORM CURRENT SCORE</button>
        <button id="agent-stop" type="button" data-agent-action="stop">AI: STOP</button>
      </div>
    </aside>
    <script id="tone-bloom-agent-contract" type="application/json"></script>
    <script id="tone-bloom-agent-status" type="application/json"></script>
  </main>
`;

const root = document.querySelector(".agent-bloom");
const canvas = document.querySelector("#score-canvas");
const stateOutput = document.querySelector("#performance-state");
const remainingOutput = document.querySelector("#remaining-time");
const receiptOutput = document.querySelector("#receipt-id");
const factsOutput = document.querySelector("#score-facts");
const statusScript = document.querySelector("#tone-bloom-agent-status");
const contractScript = document.querySelector("#tone-bloom-agent-contract");
const performControl = document.querySelector("#agent-perform");
const stopControl = document.querySelector("#agent-stop");

contractScript.textContent = JSON.stringify({
  ...describeContract(),
  canonicalUrl: "https://mhoydich.github.io/agent-bloom/",
  autonomous: true,
  interface: "window.toneBloomAgent.v1",
  nativeControls: Object.freeze({ perform: "#agent-perform", stop: "#agent-stop" }),
});

const visuals = new AgentBloomVisuals(canvas);
let localGeneration = 0;
const audio = new AgentBloomAudio({ onState: (detail) => {
  if (detail?.state === "interrupted" && currentState === "playing") return;
  handleRuntimeState(detail, localGeneration);
} });
const queuedScores = [];
const pendingBridgeRequests = new Map();
let currentScore = DEFAULT_SCORE;
let currentSchedule = compileScore(currentScore);
let currentReceipt = null;
let currentState = "idle";
let currentTruth = null;
let currentError = null;
let startedAtEpochMs = null;
let bridgeReady = false;
let booted = false;
let requestSequence = 0;
let generation = 0;
let activeBridgeRequestId = null;
let transport = "none";
let operationChain = Promise.resolve();

visuals.setScore(currentScore, currentSchedule);
renderScore(currentScore);
updateMachineStatus();

function makeRequestId() {
  requestSequence += 1;
  return `ab-${Date.now().toString(36)}-${requestSequence.toString(36)}`;
}

function serializeOperation(operation) {
  const result = operationChain.then(operation, operation);
  operationChain = result.catch(() => {});
  return result;
}

function setState(state, detail = {}) {
  const previousState = currentState;
  currentState = state;
  if (state === "playing" && Number.isFinite(detail.startedAtEpochMs)) {
    startedAtEpochMs = detail.startedAtEpochMs;
  } else if (state !== "playing") {
    startedAtEpochMs = null;
  }
  if (detail.reason) currentError = Object.freeze({ code: detail.code || currentError?.code || state, reason: String(detail.reason) });
  else if (!["rejected", "failed", "ended-unconfirmed", "error"].includes(state)) currentError = null;

  root.dataset.state = state;
  root.dataset.transport = transport;
  if (currentError) root.dataset.error = currentError.reason;
  else delete root.dataset.error;
  stateOutput.textContent = STATE_LABELS[state] || state.replaceAll("-", " ").toUpperCase();
  visuals.setState(state, { startedAtEpochMs: state === "playing" ? startedAtEpochMs : undefined });
  if (detail.receipt) setReceipt(detail.receipt);
  if ("truth" in detail) currentTruth = detail.truth || null;
  updateCountdown();
  updateMachineStatus();

  if (state === "complete" && previousState !== "complete") advanceQueue();
}

function setReceipt(receipt) {
  currentReceipt = receipt;
  const visibleId = receipt.receiptId || receipt.scoreHash?.slice(0, 12) || receipt.phase || receipt.state || "RECORDED";
  receiptOutput.textContent = String(visibleId).toUpperCase();
  receiptOutput.dataset.state = receipt.state || receipt.phase || currentState;
}

function renderScore(score) {
  const facts = [
    ["ROOT", `${ROOT_NAMES[score.root]}3`],
    ["MODE", score.mode.replaceAll("-", " ")],
    ["MOTION", score.motion],
    ["TEMPO", `${score.bpm} BPM`],
    ["VOICES", score.palette.length],
    ["SEED", score.seed.toUpperCase()],
  ];
  factsOutput.innerHTML = facts.map(([label, value]) => `
    <div><span>${label}</span><strong>${value}</strong></div>
  `).join("");
}

function updateMachineStatus() {
  statusScript.textContent = JSON.stringify({
    protocol: PROTOCOL,
    state: currentState,
    transport,
    generation,
    score: currentScore,
    receipt: currentReceipt,
    truth: currentTruth,
    error: currentError,
    startedAtEpochMs,
    queued: queuedScores.length,
    bridgeReady,
  });
}

function canonicalizeLocation(score) {
  const fragment = serializeScore(score);
  if (location.hash !== fragment) history.replaceState(null, "", fragment);
}

function settleBridgeRequest(requestId, result) {
  const pending = pendingBridgeRequests.get(requestId);
  if (!pending) return;
  clearTimeout(pending.timeout);
  pendingBridgeRequests.delete(requestId);
  pending.resolve(result);
}

function settleAllBridgeRequests(state = "stopped") {
  for (const [requestId, pending] of pendingBridgeRequests) {
    clearTimeout(pending.timeout);
    pending.resolve(Object.freeze({ state, requestId }));
  }
  pendingBridgeRequests.clear();
}

function performThroughBridge(score, operationGeneration) {
  const requestId = makeRequestId();
  activeBridgeRequestId = requestId;
  return new Promise((resolve) => {
    const timeout = setTimeout(() => {
      pendingBridgeRequests.delete(requestId);
      if (operationGeneration === generation && activeBridgeRequestId === requestId) {
        setState("ended-unconfirmed", { reason: "bridge-state-timeout" });
      }
      resolve(Object.freeze({ state: "ended-unconfirmed", requestId, reason: "bridge-state-timeout" }));
    }, 8_000);
    pendingBridgeRequests.set(requestId, { generation: operationGeneration, resolve, timeout });
    window.postMessage({
      channel: PROTOCOL,
      source: "web",
      type: "bridge:perform",
      requestId,
      score,
    }, location.origin);
  });
}

async function haltCurrentTransport() {
  const requestId = activeBridgeRequestId;
  activeBridgeRequestId = null;
  settleAllBridgeRequests("stopped");
  if (transport === "bridge" && bridgeReady) {
    window.postMessage({
      channel: PROTOCOL,
      source: "web",
      type: "bridge:stop",
      requestId: requestId || makeRequestId(),
    }, location.origin);
  }
  if (transport === "local" && ACTIVE_STATES.has(currentState)) {
    return audio.stop({ fadeMs: 80, silent: true });
  }
  return null;
}

async function performNow(score, { updateLocation = true, clearQueue = true } = {}) {
  await haltCurrentTransport();
  if (clearQueue) queuedScores.length = 0;
  generation += 1;
  const operationGeneration = generation;
  currentScore = score;
  currentSchedule = compileScore(score);
  currentTruth = null;
  currentError = null;
  visuals.setScore(score, currentSchedule);
  visuals.beginPerformance(Date.now());
  renderScore(score);
  if (updateLocation) canonicalizeLocation(score);
  const armedReceipt = await createReceipt(score, "armed");
  if (operationGeneration !== generation) return Object.freeze({ state: "stopped" });
  setState("validating", { receipt: armedReceipt });

  if (bridgeReady) {
    transport = "bridge";
    root.dataset.transport = transport;
    updateMachineStatus();
    return performThroughBridge(score, operationGeneration);
  }

  transport = "local";
  localGeneration = operationGeneration;
  root.dataset.transport = transport;
  updateMachineStatus();
  return audio.perform(score);
}

function rejectScore(error, code = "score-invalid") {
  const reason = error instanceof Error ? error.message : String(error);
  currentScore = null;
  currentSchedule = null;
  currentReceipt = null;
  currentTruth = null;
  visuals.setScore(null, null);
  factsOutput.innerHTML = `<div class="score-rejected"><span>SCORE</span><strong>REJECTED</strong></div>`;
  receiptOutput.textContent = "REJECTED";
  receiptOutput.dataset.state = "rejected";
  currentError = Object.freeze({ code, reason });
  setState("rejected", { code, reason });
  return currentError;
}

function perform(input, options = {}) {
  let score;
  try {
    score = normalizeScore(input);
  } catch (error) {
    return serializeOperation(async () => {
      generation += 1;
      queuedScores.length = 0;
      await haltCurrentTransport();
      rejectScore(error);
      throw error;
    });
  }
  return serializeOperation(() => performNow(score, options));
}

function queue(input) {
  let score;
  try {
    score = normalizeScore(input);
  } catch (error) {
    return Promise.reject(error);
  }
  return serializeOperation(async () => {
    if (!ACTIVE_STATES.has(currentState)) return performNow(score, { clearQueue: false });
    if (queuedScores.length >= 3) throw new RangeError("Agent Bloom queue is limited to 3 scores");
    queuedScores.push(score);
    updateMachineStatus();
    return createReceipt(score, "armed");
  });
}

function advanceQueue() {
  const nextScore = queuedScores.shift();
  updateMachineStatus();
  if (nextScore) void serializeOperation(() => performNow(nextScore, { clearQueue: false })).catch(() => {});
}

function stop() {
  generation += 1;
  queuedScores.length = 0;
  settleAllBridgeRequests("stopped");
  return serializeOperation(async () => {
    const terminal = await haltCurrentTransport();
    transport = "none";
    const truth = terminal?.truth
      ? { ...terminal.truth, engineState: "stopped", activeSources: 0, scheduledSources: 0, audible: false }
      : null;
    setState("stopped", { truth });
    return Object.freeze({ state: "stopped", truth });
  });
}

function status() {
  return Object.freeze({
    state: currentState,
    transport,
    generation,
    score: currentScore,
    receipt: currentReceipt,
    truth: currentTruth,
    localSignal: transport === "local" ? audio.sampleTruth() : null,
    error: currentError,
    startedAtEpochMs,
    queued: queuedScores.length,
    bridgeReady,
  });
}

function handleRuntimeState(detail, operationGeneration) {
  if (operationGeneration !== generation || transport !== "local") return;
  setState(detail.state, detail);
}

function handleBridgeState(message) {
  if (message.requestId !== activeBridgeRequestId) return;
  const pending = pendingBridgeRequests.get(message.requestId);
  if (pending && pending.generation !== generation) return;
  setState(message.state, message);
  if (BRIDGE_SETTLED_STATES.has(message.state)) settleBridgeRequest(message.requestId, message);
  if (TERMINAL_STATES.has(message.state)) activeBridgeRequestId = null;
}

window.addEventListener("message", async (event) => {
  if (event.source !== window || event.origin !== location.origin) return;
  const message = event.data;
  if (!message || message.channel !== PROTOCOL || typeof message.type !== "string") return;
  if (message.source === "web") return;

  if (message.source === "extension" && message.type === "bridge:ready") {
    bridgeReady = true;
    root.dataset.bridge = "ready";
    updateMachineStatus();
    return;
  }
  if (message.source === "extension" && message.type === "bridge:state") {
    handleBridgeState(message);
    return;
  }
  if (message.source === "companion" && message.type === "perform") {
    try {
      const result = await perform(message.score);
      window.postMessage({ channel: PROTOCOL, source: "web", type: "state", requestId: message.requestId, ...result }, location.origin);
    } catch (error) {
      window.postMessage({
        channel: PROTOCOL,
        source: "web",
        type: "state",
        requestId: message.requestId,
        state: "rejected",
        reason: error instanceof Error ? error.message : String(error),
      }, location.origin);
    }
  }
});

window.toneBloomAgent = Object.freeze({
  v1: Object.freeze({ describe: describeContract, perform, queue, status, stop }),
});

window.addEventListener("hashchange", () => {
  if (!booted || !location.hash.startsWith("#score/")) return;
  try {
    const score = parseScoreFragment(location.hash);
    void perform(score, { updateLocation: false });
  } catch (error) {
    void stop().then(() => rejectScore(error, "invalid-score-fragment"));
  }
});

function localAccent(event) {
  if (transport !== "local") return;
  if (currentState === "blocked") {
    void audio.resume();
    return;
  }
  if (currentState !== "playing") return;
  let voiceIndex = 0;
  if (event.type === "pointerdown") {
    const rect = canvas.getBoundingClientRect();
    voiceIndex = Math.floor(((event.clientX - rect.left) / rect.width) * currentScore.palette.length);
  } else if (/^[1-6]$/.test(event.key)) {
    voiceIndex = Number(event.key) - 1;
  } else if (event.code !== "Space") {
    return;
  }
  audio.accent(voiceIndex);
}

canvas.addEventListener("pointerdown", localAccent);
window.addEventListener("keydown", localAccent);
performControl.addEventListener("click", () => {
  if (currentScore) void perform(currentScore);
});
stopControl.addEventListener("click", () => void stop());

function updateCountdown() {
  let seconds = 88;
  if (currentState === "playing" && startedAtEpochMs) {
    const remaining = Math.max(0, PERFORMANCE_DURATION_MS - (Date.now() - startedAtEpochMs));
    seconds = Math.ceil(remaining / 1000);
  } else if (TERMINAL_STATES.has(currentState)) {
    seconds = 0;
  }
  remainingOutput.textContent = `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
  remainingOutput.dateTime = `PT${seconds}S`;
  remainingOutput.setAttribute("aria-label", `${seconds} seconds remaining`);
}

setInterval(updateCountdown, 1_000);

async function boot() {
  let score = DEFAULT_SCORE;
  if (location.hash.startsWith("#score/")) {
    try {
      score = parseScoreFragment(location.hash);
    } catch (error) {
      booted = true;
      rejectScore(error, "invalid-score-fragment");
      return;
    }
  }
  window.postMessage({ channel: PROTOCOL, source: "web", type: "bridge:hello" }, location.origin);
  await new Promise((resolve) => setTimeout(resolve, 350));
  booted = true;
  await perform(score);
}

void boot().catch((error) => rejectScore(error, "boot-failed"));
