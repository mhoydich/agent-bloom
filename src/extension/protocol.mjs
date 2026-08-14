export const CHANNEL = "tonebloom.agent.v1";

export const MESSAGE = Object.freeze({
  HELLO: "bridge:hello",
  READY: "bridge:ready",
  PERFORM: "bridge:perform",
  STOP: "bridge:stop",
  STATE: "bridge:state",
  GET_STATE: "bridge:get-state",
  PANEL_OPEN: "panel:open",
  AUDIO_PERFORM: "audio:perform",
  AUDIO_STOP: "audio:stop",
  AUDIO_STATE: "audio:state",
});

export const STATE = Object.freeze({
  IDLE: "idle",
  QUEUED: "queued",
  ENGINE_CONFIRMED: "engine-confirmed",
  PLAYING: "playing",
  STOPPED: "stopped",
  COMPLETE: "complete",
  BLOCKED: "blocked",
  REJECTED: "rejected",
  FAILED: "failed",
  ENDED_UNCONFIRMED: "ended-unconfirmed",
});

export function isEnvelope(value) {
  return Boolean(
    value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      value.channel === CHANNEL &&
      typeof value.type === "string",
  );
}

export function envelope(source, type, detail = {}) {
  return Object.freeze({ channel: CHANNEL, source, type, ...detail });
}

export function cloneData(value) {
  if (typeof structuredClone === "function") return structuredClone(value);
  return JSON.parse(JSON.stringify(value));
}

function deepFreeze(value) {
  if (!value || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) deepFreeze(child);
  return Object.freeze(value);
}

export function immutableReceipt(receipt) {
  return deepFreeze(cloneData(receipt));
}
