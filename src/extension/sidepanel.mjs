import { MESSAGE, STATE, envelope, isEnvelope } from "./protocol.mjs";

const stateNode = document.querySelector("#state");
const detailNode = document.querySelector("#detail");
const stopButton = document.querySelector("#stop");
const openButton = document.querySelector("#open");

chrome.runtime.onMessage.addListener((message) => {
  if (isEnvelope(message) && message.source === "extension" && message.type === MESSAGE.STATE) render(message);
});

stopButton.addEventListener("click", async () => {
  const response = await chrome.runtime.sendMessage(
    envelope("sidepanel", MESSAGE.STOP, { requestId: `panel-${Date.now()}` }),
  );
  render(response);
});

openButton.addEventListener("click", () => {
  window.open("https://mhoydich.github.io/agent-bloom/", "_blank", "noopener");
});

void chrome.runtime
  .sendMessage(envelope("sidepanel", MESSAGE.GET_STATE))
  .then(render)
  .catch(() => render({ state: STATE.FAILED, receipt: { reason: "bridge-unavailable" } }));

function render(message) {
  if (!message || typeof message !== "object") return;
  const state = typeof message.state === "string" ? message.state : STATE.IDLE;
  document.body.dataset.state = state;
  stateNode.textContent = state.replaceAll("-", " ").toUpperCase();
  detailNode.textContent = describe(message);
}

function describe(message) {
  if (message.state === STATE.ENGINE_CONFIRMED && message.truth?.audible !== true) {
    return "Engine running · waiting for measured signal";
  }
  if (message.state === STATE.PLAYING && message.truth?.audible === true) {
    return `Audible signal · RMS ${Number(message.truth.rms).toFixed(4)}`;
  }
  if (message.receipt?.receiptId) return `${message.receipt.receiptId} · ${message.receipt.phase || message.state}`;
  if (message.receipt?.seed) return `${message.receipt.seed.toUpperCase()} · ${message.receipt.phase || message.state}`;
  if (message.receipt?.reason) return message.receipt.reason.replaceAll("-", " ");
  if (message.state === STATE.IDLE) return "Waiting for a score.";
  return message.state || "Ready.";
}
