import { MESSAGE, STATE, envelope, immutableReceipt, isEnvelope } from "./protocol.mjs";
import { inspectAgentScore } from "./score-validation.mjs";
import { createSessionRoutes } from "./session-routes.mjs";

const OFFSCREEN_PATH = "offscreen.html";
const SESSION_KEY = "agentBloomSession";
let creatingOffscreen = null;
const sessionRoutes = createSessionRoutes(chrome.storage.session);
let commandQueue = Promise.resolve();

chrome.runtime.onInstalled.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onStartup.addListener(() => {
  chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true }).catch(() => {});
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (!isEnvelope(message)) return false;

  const operation = shouldSerialize(message)
    ? (commandQueue = commandQueue.catch(() => {}).then(() => routeMessage(message, sender)))
    : routeMessage(message, sender);

  void operation
    .then(sendResponse)
    .catch((error) => {
      sendResponse(
        stateReply(message.requestId, STATE.FAILED, {
          phase: STATE.FAILED,
          reason: safeReason(error),
        }),
      );
    });
  return true;
});

async function routeMessage(message, sender) {
  if (isTrustedOffscreen(message, sender)) {
    const requestId = safeRequestId(message.requestId);
    const current = await readSession();
    if (current.requestId && requestId !== current.requestId) {
      if (requestId) await sessionRoutes.delete(requestId);
      return envelope("extension", MESSAGE.STATE, {
        requestId,
        state: safeState(message.state),
        ignored: true,
      });
    }
    const reply = envelope("extension", MESSAGE.STATE, {
      requestId,
      state: safeState(message.state),
      ...finiteField("startedAtEpochMs", message.startedAtEpochMs),
      receipt: immutableReceipt(message.receipt || { phase: safeState(message.state) }),
      ...truthField(message.truth),
    });
    await saveSession(reply);
    await broadcast(reply, await sessionRoutes.read(requestId));
    if (isTerminalState(reply.state)) await sessionRoutes.delete(requestId);
    return reply;
  }

  if (!isTrustedCommand(message, sender)) {
    return stateReply(message.requestId, STATE.REJECTED, {
      phase: STATE.REJECTED,
      reason: "untrusted-source",
    });
  }

  switch (message.type) {
    case MESSAGE.HELLO:
      return envelope("extension", MESSAGE.READY, {
        state: (await readSession()).state || STATE.IDLE,
        version: chrome.runtime.getManifest().version,
      });
    case MESSAGE.GET_STATE:
      return envelope("extension", MESSAGE.STATE, await readSession());
    case MESSAGE.PERFORM:
      return perform(message, sender);
    case MESSAGE.STOP:
      return stop(message, sender);
    default:
      return stateReply(message.requestId, STATE.REJECTED, {
        phase: STATE.REJECTED,
        reason: "unknown-command",
      });
  }
}

function shouldSerialize(message) {
  return (
    (message.source === "web" || message.source === "sidepanel") &&
    (message.type === MESSAGE.PERFORM || message.type === MESSAGE.STOP)
  );
}

async function perform(message, sender) {
  const requestId = safeRequestId(message.requestId);
  const scoreCheck = inspectAgentScore(message.score);
  if (!requestId || !scoreCheck.ok) {
    return stateReply(requestId, STATE.REJECTED, {
      phase: STATE.REJECTED,
      reason: requestId ? scoreCheck.reason : "request-id-required",
    });
  }

  const previous = await readSession();
  const previousRequestId = safeRequestId(previous.requestId);
  if (previousRequestId && previousRequestId !== requestId) await sessionRoutes.delete(previousRequestId);
  const route = routeFromSender(sender);
  if (route) await sessionRoutes.save(requestId, route);
  try {
    await ensureOffscreen();
  } catch (error) {
    const failed = stateReply(requestId, STATE.FAILED, {
      phase: STATE.FAILED,
      reason: safeReason(error),
    });
    await saveSession(failed);
    await broadcast(failed, route);
    await sessionRoutes.delete(requestId);
    return failed;
  }
  const queued = stateReply(requestId, STATE.QUEUED, {
    phase: STATE.QUEUED,
    seed: scoreCheck.score.seed,
  });
  await saveSession(queued);
  await broadcast(queued, route);

  let response;
  try {
    response = await chrome.runtime.sendMessage(
      envelope("extension", MESSAGE.AUDIO_PERFORM, {
        target: "offscreen",
        requestId,
        score: scoreCheck.score,
      }),
    );
  } catch (error) {
    const failed = stateReply(requestId, STATE.FAILED, {
      phase: STATE.FAILED,
      reason: safeReason(error),
    });
    await saveSession(failed);
    await broadcast(failed, route);
    await sessionRoutes.delete(requestId);
    return failed;
  }

  if (!response || response.source !== "offscreen" || response.type !== MESSAGE.AUDIO_STATE) {
    const failed = stateReply(requestId, STATE.FAILED, {
      phase: STATE.FAILED,
      reason: "audio-response-missing",
    });
    await saveSession(failed);
    await broadcast(failed, route);
    await sessionRoutes.delete(requestId);
    return failed;
  }
  const reply = envelope("extension", MESSAGE.STATE, {
    requestId,
    state: safeState(response.state),
    ...finiteField("startedAtEpochMs", response.startedAtEpochMs),
    receipt: immutableReceipt(response.receipt || { phase: safeState(response.state) }),
    ...truthField(response.truth),
  });
  await saveSession(reply);
  if (isTerminalState(reply.state)) await sessionRoutes.delete(requestId);
  return reply;
}

async function stop(message, sender) {
  const requestId = safeRequestId(message.requestId);
  const current = await readSession();
  const activeRequestId = safeRequestId(current.requestId);
  const exists = await hasOffscreen();
  let audioResponse = null;
  if (exists) {
    audioResponse = await chrome.runtime.sendMessage(
      envelope("extension", MESSAGE.AUDIO_STOP, {
        target: "offscreen",
        requestId: activeRequestId || requestId,
      }),
    );
  }
  const reply = envelope("extension", MESSAGE.STATE, {
    requestId: activeRequestId || requestId,
    state: STATE.STOPPED,
    receipt: immutableReceipt({ phase: STATE.STOPPED }),
    ...truthField(audioResponse?.truth),
  });
  await saveSession(reply);
  const route = (activeRequestId ? await sessionRoutes.read(activeRequestId) : null) || routeFromSender(sender);
  await broadcast(reply, route);
  if (activeRequestId) await sessionRoutes.delete(activeRequestId);
  return reply;
}

async function ensureOffscreen() {
  if (await hasOffscreen()) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: OFFSCREEN_PATH,
        reasons: ["AUDIO_PLAYBACK"],
        justification: "Play the finite score the user explicitly starts.",
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

async function hasOffscreen() {
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ["OFFSCREEN_DOCUMENT"],
    documentUrls: [chrome.runtime.getURL(OFFSCREEN_PATH)],
  });
  return contexts.length > 0;
}

async function saveSession(reply) {
  await chrome.storage.session.set({ [SESSION_KEY]: reply });
}

async function readSession() {
  const stored = await chrome.storage.session.get(SESSION_KEY);
  return stored[SESSION_KEY] || { state: STATE.IDLE, requestId: null, receipt: null };
}

async function broadcast(reply, route) {
  if (route) {
    try {
      await chrome.tabs.sendMessage(route.tabId, reply, { frameId: route.frameId });
    } catch {
      // The initiating page may have navigated or closed.
    }
  }
  try {
    await chrome.runtime.sendMessage(reply);
  } catch {
    // It is valid for no visible panel/content script to be listening.
  }
}

function routeFromSender(sender) {
  return Number.isInteger(sender?.tab?.id) && Number.isInteger(sender?.frameId)
    ? Object.freeze({ tabId: sender.tab.id, frameId: sender.frameId })
    : null;
}

function isTerminalState(state) {
  return [STATE.STOPPED, STATE.COMPLETE, STATE.BLOCKED, STATE.REJECTED, STATE.FAILED, STATE.ENDED_UNCONFIRMED].includes(state);
}

function stateReply(requestId, state, receipt) {
  return envelope("extension", MESSAGE.STATE, {
    requestId: safeRequestId(requestId),
    state,
    receipt: immutableReceipt(receipt),
  });
}

function safeRequestId(value) {
  return typeof value === "string" && /^[A-Za-z0-9._:-]{1,96}$/.test(value) ? value : null;
}

function safeState(value) {
  return Object.values(STATE).includes(value) ? value : STATE.FAILED;
}

function finiteField(name, value) {
  return Number.isFinite(value) ? { [name]: value } : {};
}

function truthField(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {};
  const truth = {
    contextState: typeof value.contextState === "string" ? value.contextState : "unknown",
    engineState: typeof value.engineState === "string" ? value.engineState : "unknown",
    activeSources: Number.isInteger(value.activeSources) && value.activeSources >= 0 ? value.activeSources : 0,
    scheduledSources: Number.isInteger(value.scheduledSources) && value.scheduledSources >= 0 ? value.scheduledSources : 0,
    rms: Number.isFinite(value.rms) && value.rms >= 0 ? value.rms : 0,
    maxRms: Number.isFinite(value.maxRms) && value.maxRms >= 0 ? value.maxRms : 0,
    peak: Number.isFinite(value.peak) && value.peak >= 0 ? value.peak : 0,
    signalEverConfirmed: value.signalEverConfirmed === true,
    audible: value.audible === true,
  };
  return { truth: Object.freeze(truth) };
}

function isTrustedOffscreen(message, sender) {
  return Boolean(
    message.source === "offscreen" &&
      message.type === MESSAGE.AUDIO_STATE &&
      sender?.id === chrome.runtime.id &&
      sender?.url === chrome.runtime.getURL(OFFSCREEN_PATH),
  );
}

function isTrustedCommand(message, sender) {
  if (sender?.id !== chrome.runtime.id) return false;
  if (message.source === "web") {
    return Boolean(
      sender.tab &&
        sender.frameId === 0 &&
        sender.url?.startsWith("https://mhoydich.github.io/agent-bloom/"),
    );
  }
  if (message.source === "sidepanel") {
    return sender.url === chrome.runtime.getURL("sidepanel.html") && !sender.tab;
  }
  return false;
}

function safeReason(error) {
  return error instanceof Error && error.name ? error.name : "bridge-failed";
}
