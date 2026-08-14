# AGENT BLOOM

AGENT BLOOM is a finite Tone Bloom instrument that browser companions can author and conduct autonomously. A person can still play or interrupt it, but no human gesture is required by the score protocol. The repository produces two static artifacts from the same canonical `AgentScoreV1` contract and `AgentBloomAudio` engine:

- `dist/pages`: the public, agent-readable score and visual instrument.
- `dist/extension`: a Chrome Manifest V3 side-panel bridge with a packaged offscreen Web Audio engine.

The extension is deliberately narrow. Its content script runs only on `https://mhoydich.github.io/agent-bloom/*`, requests only `sidePanel`, `offscreen`, and `storage`, declares no host permissions, and contains all executable code in its package. It does not read tabs, browsing history, page contents outside the explicit bridge messages, or arbitrary hosts. A future custom-domain build should change this match deliberately as a separate reviewed release.

## Local verification

Requires Node 22+ and the system `zip` command.

```sh
npm ci
npm run check
npm run package:extension
```

There are currently no third-party runtime or development packages to install; Node runs the source, validation, build, and tests directly.

Load `dist/extension` as an unpacked extension from `chrome://extensions`. The packaged review artifact is `dist/packages/agent-bloom-bridge.zip`.

For a local Pages preview after building:

```sh
python3 -m http.server 4173 --directory dist/pages
```

## Bridge protocol

The web page and extension exchange plain data via `window.postMessage` using `channel: "tonebloom.agent.v1"`.

The public page also exposes two real native controls labeled for browser companions: `AI: PERFORM CURRENT SCORE` and `AI: STOP`. They give click-oriented companions a semantic, trusted-gesture surface without asking the person watching to operate the piece.

- Page: `{source:"web", type:"bridge:hello"}`
- Extension: `{source:"extension", type:"bridge:ready"}`
- Page: `{source:"web", type:"bridge:perform", requestId, score}`
- Extension: `{source:"extension", type:"bridge:state", requestId, state, startedAtEpochMs?, receipt?}`

The content script accepts only same-window, same-origin messages in that allowlist. The service worker enforces a 2 KiB serialized limit and then calls the shared strict `normalizeScore` implementation; unknown fields and out-of-range values are rejected. It verifies the sender context, persists the current receipt and initiating tab/frame route in `chrome.storage.session`, creates at most one `AUDIO_PLAYBACK` offscreen document, and sends the normalized score to the packaged engine. The persisted route lets an 88-second completion return to the correct page even if Chrome suspends and restarts the MV3 service worker. Audio truth comes back as explicit state data: `engine-confirmed` means the engine and schedule are running, while `playing` is reserved for analyser-confirmed signal. UI timers do not prove audible playback. Chrome may still report `blocked` when its audio policy prevents an autonomous `AudioContext` resume, and the bridge reports that state honestly rather than asking for or claiming a gesture.

## Release boundary

GitHub Pages publishes only `dist/pages`. CI packages the extension separately for review; it is not installed from Pages. Manifest V3 forbids remotely hosted executable JavaScript or WASM, so shared engine modules are copied into both artifacts during the build.
