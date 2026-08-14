import {
  ENGINE_VERSION,
  PERFORMANCE_DURATION_MS,
  compileScore,
  createReceipt,
  normalizeScore,
} from "./score.mjs";

const VOICE_CONFIG = Object.freeze({
  "round-bass": Object.freeze({ wave: "sine", overtone: "triangle", ratio: 2, gain: 0.2, attack: 0.035, filter: 920 }),
  wood: Object.freeze({ wave: "triangle", overtone: "sine", ratio: 3, gain: 0.17, attack: 0.008, filter: 3_600 }),
  glass: Object.freeze({ wave: "sine", overtone: "sine", ratio: 2.01, gain: 0.145, attack: 0.012, filter: 7_600 }),
  "warm-brass": Object.freeze({ wave: "sawtooth", overtone: "triangle", ratio: 1.005, gain: 0.105, attack: 0.085, filter: 2_100 }),
  air: Object.freeze({ wave: "sine", overtone: "triangle", ratio: 1.5, gain: 0.08, attack: 0.38, filter: 3_200 }),
  trill: Object.freeze({ wave: "sine", overtone: "sine", ratio: 1.498, gain: 0.11, attack: 0.006, filter: 7_800 }),
});

export const AUDIO_TRUTH_RMS = 0.0008;
export const AUDIO_RESUME_TIMEOUT_MS = 1_500;

function nowEpochForContext(context, contextTime) {
  return Date.now() + Math.max(0, (contextTime - context.currentTime) * 1000);
}

function safeStop(node, at) {
  try {
    node.stop(at);
  } catch {
    // A source can already be stopped after an interrupted performance.
  }
}

function safeDisconnect(node) {
  try {
    node?.disconnect();
  } catch {
    // A disconnected graph is already clean.
  }
}

export class AgentBloomAudio {
  constructor({ contextFactory, onState, timers } = {}) {
    this.contextFactory = contextFactory || null;
    this.onState = onState;
    this.timers = timers || {
      setTimeout: (...args) => globalThis.setTimeout(...args),
      clearTimeout: (...args) => globalThis.clearTimeout(...args),
      setInterval: (...args) => globalThis.setInterval(...args),
      clearInterval: (...args) => globalThis.clearInterval(...args),
    };
    this.context = null;
    this.master = null;
    this.analyser = null;
    this.compressor = null;
    this.runGain = null;
    this.sources = [];
    this.completionTimer = null;
    this.cleanupJobs = [];
    this.state = "idle";
    this.currentScore = null;
    this.currentSchedule = null;
    this.startedAtEpochMs = null;
    this.takeoverEvents = 0;
    this.truthTimer = null;
    this.performanceAnchorTime = null;
    this.signalEverConfirmed = false;
    this.maxRms = 0;
    this.performanceGeneration = 0;
    this.operation = Promise.resolve();
  }

  enqueue(operation) {
    const pending = this.operation.catch(() => {}).then(operation);
    this.operation = pending;
    return pending;
  }

  async resumeContext() {
    let timeoutHandle;
    const timeout = new Promise((resolve) => {
      timeoutHandle = this.timers.setTimeout(() => resolve("timeout"), AUDIO_RESUME_TIMEOUT_MS);
      timeoutHandle?.unref?.();
    });
    try {
      const outcome = await Promise.race([
        Promise.resolve(this.context.resume()).then(() => "resumed", () => "failed"),
        timeout,
      ]);
      return outcome;
    } finally {
      if (timeoutHandle) this.timers.clearTimeout(timeoutHandle);
    }
  }

  emitState(state, detail = {}) {
    this.state = state;
    const payload = Object.freeze({
      state,
      engineVersion: ENGINE_VERSION,
      startedAtEpochMs: this.startedAtEpochMs,
      takeoverEvents: this.takeoverEvents,
      truth: this.audioTruth(),
      ...detail,
    });
    this.onState?.(payload);
    return payload;
  }

  audioTruth() {
    return this.confirmedTruth(this.sampleTruth());
  }

  ensureGraph() {
    if (this.context) return;
    if (this.contextFactory) {
      this.context = this.contextFactory();
    } else if (typeof globalThis.AudioContext === "function") {
      this.context = new globalThis.AudioContext({ latencyHint: "interactive" });
    } else if (typeof globalThis.webkitAudioContext === "function") {
      this.context = new globalThis.webkitAudioContext({ latencyHint: "interactive" });
    } else {
      throw new Error("Web Audio is unavailable");
    }
    const context = this.context;

    this.master = context.createGain();
    this.master.gain.value = 0.94;

    this.compressor = context.createDynamicsCompressor();
    this.compressor.threshold.value = -15;
    this.compressor.knee.value = 16;
    this.compressor.ratio.value = 6;
    this.compressor.attack.value = 0.004;
    this.compressor.release.value = 0.18;

    this.analyser = context.createAnalyser();
    this.analyser.fftSize = 1024;
    this.analyser.smoothingTimeConstant = 0.72;

    this.compressor.connect(this.master);
    this.master.connect(this.analyser);
    this.analyser.connect(context.destination);
  }

  perform(input) {
    return this.enqueue(() => this.performNow(input));
  }

  async performNow(input) {
    const score = normalizeScore(input);
    const schedule = compileScore(score);

    if (this.hasActivePerformance()) await this.stopNow({ fadeMs: 80, silent: true });
    const generation = ++this.performanceGeneration;
    this.takeoverEvents = 0;
    const [armedReceipt, engineReceipt, playingReceipt] = await Promise.all([
      createReceipt(score, "armed", this.takeoverEvents),
      createReceipt(score, "engine-confirmed", this.takeoverEvents),
      createReceipt(score, "playing", this.takeoverEvents),
    ]);
    this.currentScore = score;
    this.currentSchedule = schedule;
    this.startedAtEpochMs = null;
    this.performanceAnchorTime = null;
    this.signalEverConfirmed = false;
    this.maxRms = 0;
    this.emitState("validating", { receipt: armedReceipt });

    try {
      this.ensureGraph();
      const resumeOutcome = await this.resumeContext();
      if (resumeOutcome === "timeout") {
        const receipt = await createReceipt(score, "blocked", this.takeoverEvents);
        return this.emitState("blocked", { receipt, reason: "AudioContext resume timed out" });
      }
      if (resumeOutcome === "failed") throw new Error("AudioContext resume failed");
    } catch (error) {
      const receipt = await createReceipt(score, "blocked", this.takeoverEvents);
      return this.emitState("blocked", { receipt, reason: error instanceof Error ? error.message : String(error) });
    }

    if (this.context.state !== "running") {
      const receipt = await createReceipt(score, "blocked", this.takeoverEvents);
      return this.emitState("blocked", { receipt, reason: "AudioContext is suspended" });
    }

    const context = this.context;
    const startAt = context.currentTime + 0.08;
    this.performanceAnchorTime = startAt;
    this.startedAtEpochMs = nowEpochForContext(context, startAt);
    this.runGain = context.createGain();
    this.runGain.gain.setValueAtTime(0.0001, context.currentTime);
    this.runGain.gain.exponentialRampToValueAtTime(1, startAt + 0.08);
    this.runGain.gain.setValueAtTime(1, startAt + PERFORMANCE_DURATION_MS / 1000 - 1.8);
    this.runGain.gain.exponentialRampToValueAtTime(0.0001, startAt + PERFORMANCE_DURATION_MS / 1000);
    this.runGain.connect(this.compressor);

    for (const event of schedule.events) this.scheduleEvent(event, startAt, this.runGain);

    this.emitState("engine-confirmed", {
      receipt: engineReceipt,
      schedule,
      startedAtEpochMs: this.startedAtEpochMs,
    });

    this.clearPerformanceTimers();
    const truthTimer = this.timers.setInterval(() => {
      if (generation !== this.performanceGeneration || this.truthTimer !== truthTimer) return;
      if (this.state !== "engine-confirmed" && this.state !== "playing") return;
      const truth = this.sampleTruth();
      this.recordTruth(truth);
      this.emitState(this.signalEverConfirmed ? "playing" : "engine-confirmed", {
        receipt: this.signalEverConfirmed ? playingReceipt : engineReceipt,
        startedAtEpochMs: this.startedAtEpochMs,
        truth: this.confirmedTruth(truth),
      });
    }, 1_000);
    this.truthTimer = truthTimer;
    truthTimer?.unref?.();

    const completionTimer = this.timers.setTimeout(async () => {
      if (generation !== this.performanceGeneration || this.completionTimer !== completionTimer) return;
      this.completionTimer = null;
      const sample = this.sampleTruth();
      this.recordTruth(sample);
      const finalTruth = this.terminalTruth("complete", sample);
      if (this.truthTimer) this.timers.clearInterval(this.truthTimer);
      this.truthTimer = null;
      const completedGain = this.runGain;
      this.runGain = null;
      safeDisconnect(completedGain);
      this.sources.length = 0;
      this.performanceAnchorTime = null;
      const completeReceipt = await createReceipt(score, "complete", this.takeoverEvents);
      if (generation !== this.performanceGeneration) return;
      this.emitState("complete", { receipt: completeReceipt, schedule, truth: finalTruth });
    }, PERFORMANCE_DURATION_MS + 180);
    this.completionTimer = completionTimer;
    completionTimer?.unref?.();

    return {
      state: this.state,
      receipt: engineReceipt,
      schedule,
      startedAtEpochMs: this.startedAtEpochMs,
      truth: this.confirmedTruth(),
    };
  }

  hasActivePerformance() {
    return Boolean(
      this.runGain ||
      this.completionTimer ||
      this.truthTimer ||
      this.state === "engine-confirmed" ||
      this.state === "playing",
    );
  }

  clearPerformanceTimers() {
    if (this.completionTimer) this.timers.clearTimeout(this.completionTimer);
    if (this.truthTimer) this.timers.clearInterval(this.truthTimer);
    this.completionTimer = null;
    this.truthTimer = null;
  }

  scheduleDisconnect(node, delayMs) {
    const timer = this.timers.setTimeout(() => {
      const index = this.cleanupJobs.findIndex(([handle]) => handle === timer);
      if (index >= 0) this.cleanupJobs.splice(index, 1);
      safeDisconnect(node);
    }, delayMs);
    this.cleanupJobs.push([timer, node]);
    timer?.unref?.();
  }

  clearCleanupJobs() {
    for (const [timer, node] of this.cleanupJobs) {
      this.timers.clearTimeout(timer);
      safeDisconnect(node);
    }
    this.cleanupJobs.length = 0;
  }

  scheduleEvent(event, anchorTime, destination) {
    const context = this.context;
    const config = VOICE_CONFIG[event.voice];
    const start = anchorTime + event.atMs / 1000;
    const duration = Math.max(0.08, event.durationMs / 1000);
    const release = Math.min(duration * 0.54, event.voice === "air" ? 1.15 : 0.52);
    const stop = start + duration;

    const voiceGain = context.createGain();
    const filter = context.createBiquadFilter();
    const panner = typeof context.createStereoPanner === "function" ? context.createStereoPanner() : null;
    const amplitude = Math.max(0.0001, config.gain * event.velocity);

    filter.type = "lowpass";
    filter.frequency.setValueAtTime(config.filter, start);
    filter.Q.value = event.voice === "glass" || event.voice === "trill" ? 1.7 : 0.72;
    voiceGain.gain.setValueAtTime(0.0001, start);
    voiceGain.gain.exponentialRampToValueAtTime(amplitude, start + Math.min(config.attack, duration * 0.22));
    voiceGain.gain.setValueAtTime(amplitude * 0.82, Math.max(start + config.attack, stop - release));
    voiceGain.gain.exponentialRampToValueAtTime(0.0001, stop);

    if (panner) {
      panner.pan.setValueAtTime(event.pan, start);
      filter.connect(voiceGain).connect(panner).connect(destination);
    } else {
      filter.connect(voiceGain).connect(destination);
    }

    const primary = context.createOscillator();
    primary.type = config.wave;
    primary.frequency.setValueAtTime(event.frequency, start);
    if (event.voice === "warm-brass") primary.detune.linearRampToValueAtTime(4, stop);
    primary.connect(filter);

    const overtone = context.createOscillator();
    const overtoneGain = context.createGain();
    overtone.type = config.overtone;
    overtone.frequency.setValueAtTime(event.frequency * config.ratio, start);
    overtoneGain.gain.value = event.voice === "glass" ? 0.22 : event.voice === "air" ? 0.1 : 0.14;
    overtone.connect(overtoneGain).connect(filter);

    if (event.voice === "trill") {
      primary.frequency.setValueAtTime(event.frequency, start);
      const hop = Math.min(0.07, duration / 5);
      for (let index = 1; index < 5; index += 1) {
        primary.frequency.setValueAtTime(event.frequency * (index % 2 ? 1.12246 : 1), start + hop * index);
      }
    }

    primary.start(start);
    overtone.start(start);
    safeStop(primary, stop + 0.02);
    safeStop(overtone, stop + 0.02);
    this.sources.push(primary, overtone);
    primary.addEventListener("ended", () => this.removeSource(primary), { once: true });
    overtone.addEventListener("ended", () => this.removeSource(overtone), { once: true });
  }

  removeSource(source) {
    const index = this.sources.indexOf(source);
    if (index >= 0) this.sources.splice(index, 1);
  }

  resume() {
    return this.enqueue(() => this.resumeNow());
  }

  async resumeNow() {
    try {
      if (!this.context) this.ensureGraph();
      const resumeOutcome = await this.resumeContext();
      if (resumeOutcome === "timeout") throw new Error("AudioContext resume timed out");
      if (resumeOutcome === "failed") throw new Error("AudioContext resume failed");
    } catch (error) {
      if (!this.currentScore) return { state: "blocked", reason: error instanceof Error ? error.message : String(error) };
      const receipt = await createReceipt(this.currentScore, "blocked", this.takeoverEvents);
      return this.emitState("blocked", {
        receipt,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
    if (this.context.state === "running" && this.currentScore && this.state === "blocked") {
      return this.performNow(this.currentScore);
    }
    if (this.context.state !== "running" && this.currentScore) {
      const receipt = await createReceipt(this.currentScore, "blocked", this.takeoverEvents);
      return this.emitState("blocked", { receipt, reason: "AudioContext is suspended" });
    }
    return { state: this.state, truth: this.audioTruth() };
  }

  stop(options = {}) {
    return this.enqueue(() => this.stopNow(options));
  }

  async stopNow({ fadeMs = 800, silent = false } = {}) {
    this.performanceGeneration += 1;
    this.clearPerformanceTimers();
    const finalSample = this.sampleTruth();
    this.recordTruth(finalSample);
    const finalTruth = this.terminalTruth("interrupted", finalSample);
    const endingGain = this.runGain;
    this.runGain = null;
    if (this.context && endingGain) {
      const now = this.context.currentTime;
      const end = now + Math.max(20, fadeMs) / 1000;
      endingGain.gain.cancelScheduledValues(now);
      endingGain.gain.setValueAtTime(Math.max(0.0001, endingGain.gain.value), now);
      endingGain.gain.exponentialRampToValueAtTime(0.0001, end);
      for (const source of this.sources) safeStop(source, end + 0.03);
      this.scheduleDisconnect(endingGain, Math.max(20, fadeMs) + 60);
    }
    this.sources.length = 0;
    this.performanceAnchorTime = null;
    if (!silent && this.currentScore) {
      const receipt = await createReceipt(this.currentScore, "interrupted", this.takeoverEvents);
      return this.emitState("interrupted", { receipt, truth: finalTruth });
    }
    this.state = "interrupted";
    return { state: "interrupted", truth: finalTruth };
  }

  accent(voiceIndex = 0) {
    if (this.state !== "playing" || !this.currentSchedule || !this.runGain) return false;
    const voice = this.currentScore.palette[Math.abs(voiceIndex) % this.currentScore.palette.length];
    const motifIndex = this.takeoverEvents % this.currentScore.motif.length;
    const exemplar = this.currentSchedule.events.find((event) => event.voice === voice && event.motifIndex === motifIndex)
      || this.currentSchedule.events.find((event) => event.voice === voice);
    if (!exemplar) return false;
    this.takeoverEvents += 1;
    this.scheduleEvent(
      { ...exemplar, atMs: 0, durationMs: Math.min(760, exemplar.durationMs), velocity: Math.min(0.88, exemplar.velocity + 0.16) },
      this.context.currentTime + 0.018,
      this.runGain,
    );
    return true;
  }

  sampleRms() {
    return this.sampleTruth().rms;
  }

  sampleTruth() {
    if (!this.analyser) {
      return Object.freeze({
        contextState: this.context?.state || "uninitialized",
        engineState: this.state,
        activeSources: 0,
        scheduledSources: this.sources.length,
        rms: 0,
        peak: 0,
        audible: false,
      });
    }
    const samples = new Float32Array(this.analyser.fftSize);
    this.analyser.getFloatTimeDomainData(samples);
    let energy = 0;
    let peak = 0;
    for (const sample of samples) {
      energy += sample * sample;
      peak = Math.max(peak, Math.abs(sample));
    }
    const rms = Math.sqrt(energy / samples.length);
    const elapsedMs = this.performanceAnchorTime === null || !this.context
      ? -1
      : (this.context.currentTime - this.performanceAnchorTime) * 1_000;
    const activeEvents = elapsedMs < 0 || !this.currentSchedule
      ? 0
      : this.currentSchedule.events.filter((event) =>
        elapsedMs >= event.atMs && elapsedMs <= event.atMs + event.durationMs,
      ).length;
    return Object.freeze({
      contextState: this.context?.state || "uninitialized",
      engineState: this.state,
      activeSources: activeEvents * 2,
      scheduledSources: this.sources.length,
      rms,
      peak,
      audible: this.context?.state === "running" &&
        (this.state === "playing" || this.state === "engine-confirmed") &&
        rms >= AUDIO_TRUTH_RMS,
    });
  }

  confirmedTruth(sample = this.sampleTruth()) {
    return Object.freeze({
      ...sample,
      signalEverConfirmed: this.signalEverConfirmed || sample.audible,
      maxRms: Math.max(this.maxRms, sample.rms),
    });
  }

  recordTruth(sample) {
    this.maxRms = Math.max(this.maxRms, sample.rms);
    this.signalEverConfirmed ||= sample.audible;
  }

  terminalTruth(engineState, sample = this.sampleTruth()) {
    return Object.freeze({
      ...this.confirmedTruth(sample),
      engineState,
      activeSources: 0,
      scheduledSources: 0,
      audible: false,
    });
  }

  dispose(options = {}) {
    return this.enqueue(() => this.disposeNow(options));
  }

  async disposeNow({ close = true } = {}) {
    await this.stopNow({ fadeMs: 20, silent: true });
    this.clearCleanupJobs();
    safeDisconnect(this.runGain);
    safeDisconnect(this.compressor);
    safeDisconnect(this.master);
    safeDisconnect(this.analyser);
    if (this.context) {
      if (close && typeof this.context.close === "function") await this.context.close();
      else if (typeof this.context.suspend === "function") await this.context.suspend();
    }
    this.context = null;
    this.runGain = null;
    this.compressor = null;
    this.master = null;
    this.analyser = null;
    this.currentScore = null;
    this.currentSchedule = null;
    this.startedAtEpochMs = null;
    this.performanceAnchorTime = null;
    this.signalEverConfirmed = false;
    this.maxRms = 0;
    this.emitState("idle");
    return { state: "idle" };
  }
}
