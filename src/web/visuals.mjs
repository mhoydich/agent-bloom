import { PERFORMANCE_DURATION_MS } from "./shared/score.mjs";

const INK = "#10100f";
const PAPER = "#f4eddf";
const VOICE_COLORS = Object.freeze({
  "round-bass": "#1918d8",
  wood: "#ff4714",
  glass: "#ef9eb6",
  "warm-brass": "#f3a712",
  air: "#b5c900",
  trill: "#17a8a2",
});

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function smoothstep(edge0, edge1, value) {
  const t = clamp((value - edge0) / (edge1 - edge0), 0, 1);
  return t * t * (3 - 2 * t);
}

export class AgentBloomVisuals {
  constructor(canvas) {
    this.canvas = canvas;
    this.context = canvas.getContext("2d", { alpha: true });
    this.score = null;
    this.schedule = null;
    this.state = "armed";
    this.startedAtEpochMs = null;
    this.visualStartedAtEpochMs = null;
    this.animationFrame = null;
    this.lastWidth = 0;
    this.lastHeight = 0;
    this.reducedMotion = globalThis.matchMedia?.("(prefers-reduced-motion: reduce)")?.matches || false;
    this.tick = this.tick.bind(this);
    this.start();
  }

  setScore(score, schedule) {
    this.score = score;
    this.schedule = schedule;
  }

  beginPerformance(startedAtEpochMs = Date.now()) {
    this.visualStartedAtEpochMs = startedAtEpochMs;
  }

  setState(state, { startedAtEpochMs } = {}) {
    this.state = state;
    if (state === "playing" && Number.isFinite(startedAtEpochMs)) this.startedAtEpochMs = startedAtEpochMs;
    if (state !== "playing") this.startedAtEpochMs = null;
    if (state === "complete") this.visualStartedAtEpochMs = Date.now() - PERFORMANCE_DURATION_MS;
  }

  start() {
    if (this.animationFrame) return;
    this.animationFrame = requestAnimationFrame(this.tick);
  }

  stop() {
    cancelAnimationFrame(this.animationFrame);
    this.animationFrame = null;
  }

  resize() {
    const rect = this.canvas.getBoundingClientRect();
    const ratio = Math.min(2, globalThis.devicePixelRatio || 1);
    const width = Math.max(1, Math.round(rect.width * ratio));
    const height = Math.max(1, Math.round(rect.height * ratio));
    if (width === this.lastWidth && height === this.lastHeight) return;
    this.lastWidth = width;
    this.lastHeight = height;
    this.canvas.width = width;
    this.canvas.height = height;
  }

  tick(now) {
    this.resize();
    this.draw(now);
    this.animationFrame = requestAnimationFrame(this.tick);
  }

  draw(now) {
    const context = this.context;
    const width = this.canvas.width;
    const height = this.canvas.height;
    if (!width || !height) return;
    context.clearRect(0, 0, width, height);

    const ratio = width / Math.max(1, height);
    const visualRunning = Number.isFinite(this.visualStartedAtEpochMs);
    const elapsed = visualRunning
      ? clamp(Date.now() - this.visualStartedAtEpochMs, 0, PERFORMANCE_DURATION_MS)
      : this.reducedMotion ? 0 : (now * 0.035) % PERFORMANCE_DURATION_MS;
    const progress = elapsed / PERFORMANCE_DURATION_MS;
    const movement = Math.min(3, Math.floor(progress * 4));
    const movementProgress = (progress * 4) % 1;

    context.save();
    context.globalCompositeOperation = "source-over";
    context.fillStyle = "rgba(244,237,223,0.62)";
    context.fillRect(0, 0, width, height);

    this.drawMovementFields(context, width, height, progress, movement);
    this.drawConductorLine(context, width, height, progress, movementProgress);
    if (visualRunning && this.schedule) this.drawEvents(context, width, height, elapsed);
    else this.drawArmedOrbit(context, width, height, elapsed, ratio);
    this.drawFrame(context, width, height, progress);
    context.restore();
  }

  drawMovementFields(context, width, height, progress, movement) {
    const colors = this.score?.palette?.map((voice) => VOICE_COLORS[voice]) || ["#1918d8", "#ff4714", "#b5c900", "#ef9eb6"];
    const unit = width / 4;
    for (let index = 0; index < 4; index += 1) {
      const active = index === movement;
      const pulse = 0.5 + Math.sin(progress * Math.PI * 8 + index * 1.7) * 0.5;
      context.fillStyle = `${colors[index % colors.length]}${active ? "d8" : "38"}`;
      const inset = active ? unit * 0.03 * pulse : unit * 0.07;
      context.fillRect(index * unit + inset, inset, unit - inset * 2, height - inset * 2);

      context.strokeStyle = INK;
      context.lineWidth = Math.max(2, width * 0.0015);
      context.strokeRect(index * unit, 0, unit, height);
    }
  }

  drawConductorLine(context, width, height, progress, movementProgress) {
    const baseY = height * (0.18 + progress * 0.64);
    context.beginPath();
    for (let x = 0; x <= width; x += Math.max(4, width / 220)) {
      const normalX = x / width;
      const wave = Math.sin(normalX * Math.PI * 8 + progress * Math.PI * 14) * height * 0.026;
      const secondary = Math.sin(normalX * Math.PI * 25 - progress * Math.PI * 6) * height * 0.009;
      const y = baseY + wave * (0.35 + movementProgress * 0.65) + secondary;
      if (x === 0) context.moveTo(x, y);
      else context.lineTo(x, y);
    }
    context.strokeStyle = PAPER;
    context.lineWidth = Math.max(3, width * 0.004);
    context.stroke();
    context.strokeStyle = INK;
    context.lineWidth = Math.max(1, width * 0.0012);
    context.stroke();

    const headX = width * progress;
    context.beginPath();
    context.arc(headX, baseY, Math.max(8, width * 0.012), 0, Math.PI * 2);
    context.fillStyle = PAPER;
    context.fill();
    context.strokeStyle = INK;
    context.stroke();
  }

  drawEvents(context, width, height, elapsed) {
    const horizon = 1_650;
    for (const event of this.schedule.events) {
      const age = elapsed - event.atMs;
      if (age < -100 || age > horizon) continue;
      const life = clamp(1 - age / horizon, 0, 1);
      const anticipation = age < 0 ? 0.2 : 1;
      const x = ((event.motifIndex + 0.5) / 8) * width;
      const lane = event.voiceIndex / Math.max(1, this.score.palette.length - 1);
      const y = height * (0.18 + lane * 0.64);
      const radius = Math.max(3, width * 0.052 * smoothstep(0, 1, life) * anticipation * event.velocity);

      context.save();
      context.globalAlpha = 0.24 + life * 0.7;
      context.translate(x, y);
      context.rotate((event.degree / 8) * Math.PI + age * 0.0005);
      context.fillStyle = VOICE_COLORS[event.voice] || PAPER;
      context.strokeStyle = INK;
      context.lineWidth = Math.max(1, width * 0.0015);
      if (event.voice === "trill" || event.voice === "glass") {
        for (let petal = 0; petal < 4; petal += 1) {
          context.rotate(Math.PI / 2);
          context.beginPath();
          context.ellipse(radius * 0.75, 0, radius, radius * 0.34, 0, 0, Math.PI * 2);
          context.fill();
          context.stroke();
        }
      } else {
        context.fillRect(-radius, -radius, radius * 2, radius * 2);
        context.strokeRect(-radius, -radius, radius * 2, radius * 2);
      }
      context.restore();
    }
  }

  drawArmedOrbit(context, width, height, elapsed, ratio) {
    const phase = elapsed / PERFORMANCE_DURATION_MS * Math.PI * 2;
    const centerX = width * (ratio > 1 ? 0.72 : 0.5);
    const centerY = height * 0.52;
    const orbitX = width * 0.19;
    const orbitY = height * 0.27;
    context.strokeStyle = INK;
    context.lineWidth = Math.max(2, width * 0.0015);
    context.beginPath();
    context.ellipse(centerX, centerY, orbitX, orbitY, -0.18, 0, Math.PI * 2);
    context.stroke();
    context.beginPath();
    context.arc(centerX + Math.cos(phase) * orbitX, centerY + Math.sin(phase) * orbitY, Math.max(6, width * 0.009), 0, Math.PI * 2);
    context.fillStyle = PAPER;
    context.fill();
    context.stroke();
  }

  drawFrame(context, width, height, progress) {
    context.strokeStyle = INK;
    context.lineWidth = Math.max(3, width * 0.003);
    context.strokeRect(0, 0, width, height);
    context.fillStyle = INK;
    context.fillRect(0, height - Math.max(8, height * 0.016), width * progress, Math.max(8, height * 0.016));
  }
}
