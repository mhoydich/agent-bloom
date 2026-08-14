import { AgentBloomAudio } from "./shared/audio.mjs";
import { MESSAGE, STATE, envelope, immutableReceipt, isEnvelope } from "./protocol.mjs";

let engine = null;
let activeRequestId = null;
let activeGeneration = 0;
let operation = Promise.resolve();

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isTrustedAudioCommand(message, sender)) return false;

  if (message.type === MESSAGE.AUDIO_PERFORM) {
    operation = operation.catch(() => {}).then(() => perform(message));
    void operation.then(sendResponse).catch((error) => {
      sendResponse(
        audioReply(message.requestId, STATE.FAILED, {
          phase: STATE.FAILED,
          reason: error instanceof Error ? error.name : "audio-failed",
        }),
      );
    });
    return true;
  }

  if (message.type === MESSAGE.AUDIO_STOP) {
    operation = operation.catch(() => {}).then(() => stop(message.requestId));
    void operation.then(sendResponse);
    return true;
  }
  return false;
});

async function perform(message) {
  if (activeRequestId) await stop(activeRequestId);
  activeRequestId = message.requestId;
  activeGeneration += 1;
  const generation = activeGeneration;
  if (!engine) engine = new AgentBloomAudio();
  engine.onState = (engineState) => forwardEngineState(engineState, generation);
  const result = await engine.perform(message.score);
  return audioReply(
    message.requestId,
    normalizePhase(result.state),
    result.receipt || { phase: normalizePhase(result.state) },
    result.startedAtEpochMs,
    result.truth,
  );
}

function forwardEngineState(engineState = {}, generation) {
  if (!activeRequestId || generation !== activeGeneration) return;
  const phase = normalizePhase(engineState.state);
  const reply = audioReply(activeRequestId, phase, {
    ...(engineState.receipt || {}),
    phase,
    ...(engineState.reason ? { reason: engineState.reason } : {}),
  }, engineState.startedAtEpochMs, engineState.truth);
  void chrome.runtime.sendMessage(reply).catch(() => {});
  if ([STATE.COMPLETE, STATE.STOPPED, STATE.FAILED, STATE.BLOCKED, STATE.ENDED_UNCONFIRMED].includes(phase)) {
    activeRequestId = null;
  }
}

async function stop(requestId) {
  activeRequestId = null;
  activeGeneration += 1;
  const result = engine ? await engine.stop() : { state: "interrupted" };
  return audioReply(requestId, STATE.STOPPED, {
    ...(result?.receipt || {}),
    phase: STATE.STOPPED,
  });
}

function audioReply(requestId, state, receipt, startedAtEpochMs, truth) {
  return envelope("offscreen", MESSAGE.AUDIO_STATE, {
    requestId: typeof requestId === "string" ? requestId : null,
    state,
    ...(Number.isFinite(startedAtEpochMs) ? { startedAtEpochMs } : {}),
    receipt: immutableReceipt(receipt),
    ...(truth && typeof truth === "object" ? { truth: immutableReceipt(truth) } : {}),
  });
}

function normalizePhase(value) {
  if (value === "validating" || value === "armed") return STATE.QUEUED;
  if (value === "interrupted") return STATE.STOPPED;
  if (Object.values(STATE).includes(value)) return value;
  return STATE.FAILED;
}

function isTrustedAudioCommand(message, sender) {
  return Boolean(
    isEnvelope(message) &&
      message.source === "extension" &&
      message.target === "offscreen" &&
      sender?.id === chrome.runtime.id &&
      (!sender.url || sender.url === chrome.runtime.getURL("service-worker.mjs")) &&
      !sender.tab,
  );
}
