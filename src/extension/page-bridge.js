(() => {
  "use strict";

  const CHANNEL = "tonebloom.agent.v1";
  const FROM_PAGE = "web";
  const FROM_EXTENSION = "extension";
  const MAX_SCORE_BYTES = 2 * 1024;
  const ACCEPTED = new Set(["bridge:hello", "bridge:perform", "bridge:stop", "bridge:get-state"]);
  const OUTBOUND = new Set(["bridge:ready", "bridge:state"]);

  function isPlainObject(value) {
    if (!value || typeof value !== "object") return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  }

  function post(message) {
    window.postMessage({ channel: CHANNEL, source: FROM_EXTENSION, ...message }, window.location.origin);
  }

  function reject(requestId, reason) {
    post({
      type: "bridge:state",
      requestId: typeof requestId === "string" ? requestId : null,
      state: "rejected",
      receipt: { phase: "rejected", reason },
    });
  }

  function commandForRuntime(message) {
    const command = {
      channel: CHANNEL,
      source: FROM_PAGE,
      type: message.type,
    };
    if (typeof message.requestId === "string") command.requestId = message.requestId;
    if (message.type !== "bridge:perform") return command;

    let encoded;
    try {
      encoded = JSON.stringify(message.score);
    } catch {
      return null;
    }
    if (typeof encoded !== "string" || new TextEncoder().encode(encoded).byteLength > MAX_SCORE_BYTES) {
      return null;
    }
    command.score = JSON.parse(encoded);
    return command;
  }

  window.addEventListener("message", (event) => {
    if (event.source !== window || event.origin !== window.location.origin) return;
    const message = event.data;
    if (!isPlainObject(message) || message.channel !== CHANNEL || message.source !== FROM_PAGE) return;
    if (!ACCEPTED.has(message.type)) return;
    const command = commandForRuntime(message);
    if (!command) {
      reject(message.requestId, "score-too-large-or-unserializable");
      return;
    }

    chrome.runtime.sendMessage(command, (response) => {
      if (chrome.runtime.lastError) {
        post({
          type: "bridge:state",
          requestId: typeof message.requestId === "string" ? message.requestId : null,
          state: "failed",
          receipt: {
            phase: "failed",
            reason: "extension-message-failed",
          },
        });
        return;
      }
      if (response && typeof response === "object") post(response);
    });
  });

  chrome.runtime.onMessage.addListener((message) => {
    if (!message || message.channel !== CHANNEL || message.source !== FROM_EXTENSION) return;
    if (!OUTBOUND.has(message.type)) return;
    post(message);
  });
})();
