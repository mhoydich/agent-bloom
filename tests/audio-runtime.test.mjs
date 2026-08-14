import assert from "node:assert/strict";
import test from "node:test";

import { AgentBloomAudio } from "../src/shared/audio.mjs";
import { DEFAULT_SCORE, PERFORMANCE_DURATION_MS, compileScore } from "../src/shared/score.mjs";

test("each scheduled oscillator starts exactly once", async () => {
  const runtime = createRuntime();
  const result = await runtime.engine.perform(DEFAULT_SCORE);
  const expectedOscillators = compileScore(DEFAULT_SCORE).events.length * 2;

  assert.equal(result.state, "engine-confirmed");
  assert.equal(result.receipt.state, "engine-confirmed");
  assert.equal(result.truth.audible, false);
  assert.equal(runtime.context.oscillators.length, expectedOscillators);
  assert.ok(runtime.context.oscillators.every((oscillator) => oscillator.startTimes.length === 1));

  await runtime.engine.dispose();
});

test("scheduled audio becomes playing only after measured signal and keeps sticky truth", async () => {
  const runtime = createRuntime();
  await runtime.engine.perform(DEFAULT_SCORE);

  await runtime.timers.advanceBy(1_000);
  assert.equal(runtime.states.at(-1).state, "engine-confirmed");
  assert.equal(runtime.states.at(-1).truth.signalEverConfirmed, false);
  assert.equal(runtime.states.at(-1).receipt.state, "engine-confirmed");

  runtime.context.analyser.amplitude = 0.012;
  await runtime.timers.advanceBy(1_000);
  assert.equal(runtime.states.at(-1).state, "playing");
  assert.equal(runtime.states.at(-1).truth.audible, true);
  assert.equal(runtime.states.at(-1).truth.signalEverConfirmed, true);
  assert.equal(runtime.states.at(-1).receipt.state, "playing");

  runtime.context.analyser.amplitude = 0;
  await runtime.timers.advanceBy(1_000);
  assert.equal(runtime.states.at(-1).state, "playing");
  assert.equal(runtime.states.at(-1).truth.audible, false);
  assert.equal(runtime.states.at(-1).truth.signalEverConfirmed, true);
  assert.ok(runtime.states.at(-1).truth.maxRms >= 0.012);

  await runtime.engine.dispose();
});

test("a browser-blocked context can resume and schedule the score", async () => {
  const runtime = createRuntime({ resumePlan: ["suspended", "running", "running"] });
  const blocked = await runtime.engine.perform(DEFAULT_SCORE);

  assert.equal(blocked.state, "blocked");
  assert.equal(blocked.receipt.state, "blocked");
  assert.equal(runtime.context.oscillators.length, 0);

  const resumed = await runtime.engine.resume();
  assert.equal(resumed.state, "engine-confirmed");
  assert.equal(resumed.receipt.state, "engine-confirmed");
  assert.ok(runtime.context.oscillators.length > 0);
  assert.equal(runtime.context.resumeCalls, 3);

  await runtime.engine.dispose();
});

test("stop cancels completion, stops scheduled sources, and reports terminal silence", async () => {
  const runtime = createRuntime();
  await runtime.engine.perform(DEFAULT_SCORE);
  runtime.context.analyser.amplitude = 0.01;
  await runtime.timers.advanceBy(1_000);

  const stopped = await runtime.engine.stop({ fadeMs: 20 });
  assert.equal(stopped.state, "interrupted");
  assert.equal(stopped.receipt.state, "interrupted");
  assert.equal(stopped.truth.engineState, "interrupted");
  assert.equal(stopped.truth.audible, false);
  assert.equal(stopped.truth.signalEverConfirmed, true);
  assert.equal(stopped.truth.activeSources, 0);
  assert.equal(stopped.truth.scheduledSources, 0);
  assert.ok(runtime.context.oscillators.every((oscillator) => oscillator.stopTimes.length >= 2));

  await runtime.timers.advanceBy(PERFORMANCE_DURATION_MS + 1_000);
  assert.equal(runtime.states.some((state) => state.state === "complete"), false);
  assert.equal(runtime.engine.runGain, null);

  await runtime.engine.dispose();
});

test("reperform while engine-confirmed retires only the old graph", async () => {
  const runtime = createRuntime();
  const first = await runtime.engine.perform(DEFAULT_SCORE);
  const oldGain = runtime.engine.runGain;
  const oldOscillators = [...runtime.context.oscillators];
  const secondScore = { ...DEFAULT_SCORE, seed: "a1b2c3d4" };

  const second = await runtime.engine.perform(secondScore);
  const newGain = runtime.engine.runGain;
  assert.equal(first.state, "engine-confirmed");
  assert.equal(second.state, "engine-confirmed");
  assert.notEqual(second.receipt.receiptId, first.receipt.receiptId);
  assert.notEqual(newGain, oldGain);
  assert.ok(oldOscillators.every((oscillator) => oscillator.stopTimes.length >= 2));

  await runtime.timers.advanceBy(140);
  assert.equal(oldGain.disconnected, true);
  assert.equal(newGain.disconnected, false);
  assert.equal(runtime.engine.runGain, newGain);

  await runtime.timers.advanceBy(PERFORMANCE_DURATION_MS + 180);
  const completions = runtime.states.filter((state) => state.state === "complete");
  assert.equal(completions.length, 1);
  assert.equal(completions[0].receipt.receiptId, second.receipt.receiptId);

  await runtime.engine.dispose();
});

test("completion preserves confirmed history without claiming terminal audibility", async () => {
  const runtime = createRuntime();
  await runtime.engine.perform(DEFAULT_SCORE);
  runtime.context.analyser.amplitude = 0.02;

  await runtime.timers.advanceBy(PERFORMANCE_DURATION_MS + 180);
  const completed = runtime.states.at(-1);
  assert.equal(completed.state, "complete");
  assert.equal(completed.receipt.state, "complete");
  assert.equal(completed.truth.engineState, "complete");
  assert.equal(completed.truth.signalEverConfirmed, true);
  assert.ok(completed.truth.maxRms >= 0.0199);
  assert.equal(completed.truth.audible, false);
  assert.equal(completed.truth.activeSources, 0);
  assert.equal(completed.truth.scheduledSources, 0);

  await runtime.engine.dispose();
});

function createRuntime({ resumePlan = ["running"] } = {}) {
  const timers = new FakeTimers();
  const context = new FakeAudioContext(timers, resumePlan);
  const states = [];
  const engine = new AgentBloomAudio({
    contextFactory: () => context,
    onState: (state) => states.push(state),
    timers,
  });
  return { context, engine, states, timers };
}

class FakeTimers {
  constructor() {
    this.nowMs = 0;
    this.nextId = 1;
    this.jobs = new Map();
  }

  setTimeout(callback, delay = 0) {
    return this.addJob(callback, delay, 0);
  }

  clearTimeout(handle) {
    this.jobs.delete(handle);
  }

  setInterval(callback, delay = 0) {
    return this.addJob(callback, delay, Math.max(1, delay));
  }

  clearInterval(handle) {
    this.jobs.delete(handle);
  }

  addJob(callback, delay, interval) {
    const handle = {
      id: this.nextId,
      unref() {},
    };
    this.nextId += 1;
    this.jobs.set(handle, {
      callback,
      at: this.nowMs + Math.max(0, delay),
      interval,
    });
    return handle;
  }

  async advanceBy(durationMs) {
    const target = this.nowMs + durationMs;
    while (true) {
      const next = [...this.jobs.entries()]
        .filter(([, job]) => job.at <= target)
        .sort((a, b) => a[1].at - b[1].at || a[0].id - b[0].id)[0];
      if (!next) break;

      const [handle, job] = next;
      this.nowMs = job.at;
      if (job.interval && this.jobs.has(handle)) job.at += job.interval;
      else this.jobs.delete(handle);
      await job.callback();
      await Promise.resolve();
    }
    this.nowMs = target;
    await Promise.resolve();
  }
}

class FakeAudioParam {
  constructor(value = 0) {
    this.value = value;
    this.events = [];
  }

  setValueAtTime(value, at) {
    this.value = value;
    this.events.push(["set", value, at]);
  }

  exponentialRampToValueAtTime(value, at) {
    this.value = value;
    this.events.push(["exponential", value, at]);
  }

  linearRampToValueAtTime(value, at) {
    this.value = value;
    this.events.push(["linear", value, at]);
  }

  cancelScheduledValues(at) {
    this.events.push(["cancel", at]);
  }
}

class FakeAudioNode extends EventTarget {
  constructor() {
    super();
    this.connections = [];
    this.disconnected = false;
  }

  connect(destination) {
    this.connections.push(destination);
    return destination;
  }

  disconnect() {
    this.disconnected = true;
    this.connections.length = 0;
  }
}

class FakeOscillator extends FakeAudioNode {
  constructor() {
    super();
    this.frequency = new FakeAudioParam();
    this.detune = new FakeAudioParam();
    this.startTimes = [];
    this.stopTimes = [];
    this.type = "sine";
  }

  start(at) {
    if (this.startTimes.length) {
      const error = new Error("Oscillator already started");
      error.name = "InvalidStateError";
      throw error;
    }
    this.startTimes.push(at);
  }

  stop(at) {
    this.stopTimes.push(at);
  }
}

class FakeAnalyser extends FakeAudioNode {
  constructor() {
    super();
    this.fftSize = 1024;
    this.smoothingTimeConstant = 0;
    this.amplitude = 0;
  }

  getFloatTimeDomainData(samples) {
    for (let index = 0; index < samples.length; index += 1) {
      samples[index] = index % 2 ? -this.amplitude : this.amplitude;
    }
  }
}

class FakeAudioContext {
  constructor(timers, resumePlan) {
    this.timers = timers;
    this.resumePlan = [...resumePlan];
    this.resumeCalls = 0;
    this.state = "suspended";
    this.destination = new FakeAudioNode();
    this.analyser = new FakeAnalyser();
    this.oscillators = [];
    this.gains = [];
  }

  get currentTime() {
    return this.timers.nowMs / 1_000;
  }

  async resume() {
    this.resumeCalls += 1;
    const result = this.resumePlan.length ? this.resumePlan.shift() : "running";
    if (result instanceof Error) throw result;
    this.state = result;
  }

  async suspend() {
    this.state = "suspended";
  }

  async close() {
    this.state = "closed";
  }

  createGain() {
    const node = new FakeAudioNode();
    node.gain = new FakeAudioParam(1);
    this.gains.push(node);
    return node;
  }

  createDynamicsCompressor() {
    const node = new FakeAudioNode();
    node.threshold = new FakeAudioParam();
    node.knee = new FakeAudioParam();
    node.ratio = new FakeAudioParam();
    node.attack = new FakeAudioParam();
    node.release = new FakeAudioParam();
    return node;
  }

  createAnalyser() {
    return this.analyser;
  }

  createBiquadFilter() {
    const node = new FakeAudioNode();
    node.frequency = new FakeAudioParam();
    node.Q = new FakeAudioParam();
    node.type = "lowpass";
    return node;
  }

  createStereoPanner() {
    const node = new FakeAudioNode();
    node.pan = new FakeAudioParam();
    return node;
  }

  createOscillator() {
    const oscillator = new FakeOscillator();
    this.oscillators.push(oscillator);
    return oscillator;
  }
}
