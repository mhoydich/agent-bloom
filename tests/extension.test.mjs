import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";
import { DEFAULT_SCORE, PROTOCOL } from "../src/shared/score.mjs";
import { MAX_SCORE_BYTES, inspectAgentScore } from "../src/extension/score-validation.mjs";
import { createSessionRoutes } from "../src/extension/session-routes.mjs";

const root = resolve(".");
const manifestPath = join(root, "src/extension/manifest.json");

test("MV3 manifest keeps the exact least-privilege boundary", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  assert.equal(manifest.manifest_version, 3);
  assert.equal(manifest.minimum_chrome_version, "116");
  assert.deepEqual(manifest.permissions, ["sidePanel", "offscreen", "storage"]);
  assert.equal(manifest.host_permissions, undefined);
  assert.equal(manifest.optional_host_permissions, undefined);
  assert.equal(manifest.background.type, "module");
  assert.equal(manifest.side_panel.default_path, "sidepanel.html");
  assert.deepEqual(manifest.content_scripts[0].matches, ["https://mhoydich.github.io/agent-bloom/*"]);
  assert.match(manifest.content_security_policy.extension_pages, /script-src 'self'/);
});

test("manifest references local files that exist", async () => {
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const paths = [
    manifest.background.service_worker,
    manifest.side_panel.default_path,
    ...manifest.content_scripts.flatMap((script) => script.js),
    ...Object.values(manifest.icons),
  ];
  for (const path of paths) assert.ok(existsSync(join(root, "src/extension", path)), path);
});

test("extension source has no remotely hosted executable code or dynamic evaluation", async () => {
  const source = await allText(join(root, "src/extension"));
  assert.doesNotMatch(source, /\b(?:import|importScripts)\s*\(?\s*["']https?:\/\//);
  assert.doesNotMatch(source, /\b(?:eval|Function)\s*\(/);
  assert.doesNotMatch(source, /innerHTML\s*=/);
});

test("score bridge delegates strict AgentScoreV1 validation to the canonical shared contract", () => {
  const accepted = inspectAgentScore(DEFAULT_SCORE);
  assert.equal(accepted.ok, true);
  assert.deepEqual(accepted.score, DEFAULT_SCORE);

  assert.deepEqual(inspectAgentScore(null), { ok: false, reason: "score-object-required" });
  assert.deepEqual(inspectAgentScore({ ...DEFAULT_SCORE, bpm: 145 }), { ok: false, reason: "score-invalid" });
  assert.deepEqual(inspectAgentScore({ ...DEFAULT_SCORE, extra: true }), { ok: false, reason: "score-invalid" });
  assert.deepEqual(inspectAgentScore({ ...DEFAULT_SCORE, palette: ["wood"] }), { ok: false, reason: "score-invalid" });
  assert.deepEqual(
    inspectAgentScore({ ...DEFAULT_SCORE, extra: "x".repeat(MAX_SCORE_BYTES) }),
    { ok: false, reason: "score-too-large" },
  );
});

test("page bridge accepts only the explicit Tone Bloom protocol", async () => {
  const source = await readFile(join(root, "src/extension/page-bridge.js"), "utf8");
  assert.match(source, /event\.source !== window/);
  assert.match(source, /event\.origin !== window\.location\.origin/);
  assert.match(source, /message\.source !== FROM_PAGE/);
  assert.match(source, /ACCEPTED\.has\(message\.type\)/);
  assert.match(source, /OUTBOUND\.has\(message\.type\)/);
});

test("side panel presents autonomous companion operation without a human-start prompt", async () => {
  const source = await readFile(join(root, "src/extension/sidepanel.html"), "utf8");
  assert.match(source, /Browser companions write and conduct finite Tone Bloom scores here/);
  assert.doesNotMatch(source, /press|click|human|yourself/i);
});

test("side panel labels analyser evidence as measured signal", async () => {
  const source = await readFile(join(root, "src/extension/sidepanel.mjs"), "utf8");
  assert.match(source, /Measured signal · RMS/);
  assert.doesNotMatch(source, /Audible signal/);
});

test("service worker bounds scores, deduplicates offscreen creation, and persists state", async () => {
  const source = await readFile(join(root, "src/extension/service-worker.mjs"), "utf8");
  const validation = await readFile(join(root, "src/extension/score-validation.mjs"), "utf8");
  assert.match(validation, /MAX_SCORE_BYTES = 2 \* 1024/);
  assert.match(validation, /normalizeScore/);
  assert.match(source, /chrome\.runtime\.getContexts/);
  assert.match(source, /creatingOffscreen/);
  assert.match(source, /let commandQueue = Promise\.resolve\(\)/);
  assert.match(source, /reasons: \["AUDIO_PLAYBACK"\]/);
  assert.match(source, /chrome\.storage\.session/);
  assert.match(source, /createSessionRoutes/);
  assert.match(source, /sessionRoutes\.save/);
  assert.match(source, /sessionRoutes\.read/);
  assert.match(source, /sender\?\.id === chrome\.runtime\.id/);
  assert.match(source, /sender\.frameId === 0/);
  assert.match(source, /chrome\.tabs\.sendMessage/);
  assert.match(source, /unknown-command/);
});

test("tab/frame routes survive a service-worker restart and are removed at terminal state", async () => {
  const backing = {};
  const storage = {
    async get(key) {
      return key in backing ? { [key]: structuredClone(backing[key]) } : {};
    },
    async set(values) {
      Object.assign(backing, structuredClone(values));
    },
  };

  const firstWorker = createSessionRoutes(storage);
  await firstWorker.save("ab-restart-1", { tabId: 41, frameId: 0 });

  // This new instance has no memory shared with the first worker.
  const restartedWorker = createSessionRoutes(storage);
  assert.deepEqual(await restartedWorker.read("ab-restart-1"), { tabId: 41, frameId: 0 });
  await restartedWorker.delete("ab-restart-1");
  assert.equal(await firstWorker.read("ab-restart-1"), null);
});

test("offscreen engine uses AgentBloomAudio and fails closed for unknown states", async () => {
  const source = await readFile(join(root, "src/extension/offscreen.mjs"), "utf8");
  assert.match(source, /import \{ AgentBloomAudio \}/);
  assert.match(source, /new AgentBloomAudio/);
  assert.match(source, /let operation = Promise\.resolve\(\)/);
  assert.match(source, /activeGeneration/);
  assert.match(source, /!sender\.url \|\| sender\.url === chrome\.runtime\.getURL\("service-worker\.mjs"\)/);
  assert.match(source, /return STATE\.FAILED/);
  assert.doesNotMatch(source, /return STATE\.PLAYING;\s*\n}/);
});

test("stop receipts preserve terminal audio truth across the extension boundary", async () => {
  const offscreen = await readFile(join(root, "src/extension/offscreen.mjs"), "utf8");
  const worker = await readFile(join(root, "src/extension/service-worker.mjs"), "utf8");
  assert.match(offscreen, /undefined, result\?\.truth/);
  assert.match(worker, /truthField\(audioResponse\?\.truth\)/);
});

test("protocol preserves engine-confirmed separately from measured playing", async () => {
  const { CHANNEL, STATE } = await import("../src/extension/protocol.mjs");
  assert.equal(CHANNEL, PROTOCOL);
  assert.equal(STATE.ENGINE_CONFIRMED, "engine-confirmed");
  assert.equal(STATE.PLAYING, "playing");
});

test("a restarted service worker routes COMPLETE to the persisted initiating tab/frame", async () => {
  const listeners = [];
  const storageData = {};
  const tabMessages = [];
  const extensionId = "agent-bloom-test";
  const extensionUrl = (path) => `chrome-extension://${extensionId}/${String(path).replace(/^\//, "")}`;
  const chromeMock = {
    runtime: {
      id: extensionId,
      onInstalled: { addListener() {} },
      onStartup: { addListener() {} },
      onMessage: { addListener(listener) { listeners.push(listener); } },
      getURL: extensionUrl,
      getManifest: () => ({ version: "0.1.0" }),
      getContexts: async () => [{ contextType: "OFFSCREEN_DOCUMENT" }],
      async sendMessage(message) {
        if (message.type !== "audio:perform") return undefined;
        return {
          channel: "tonebloom.agent.v1",
          source: "offscreen",
          type: "audio:state",
          requestId: message.requestId,
          state: "engine-confirmed",
          startedAtEpochMs: 1_786_650_000_000,
          receipt: { receiptId: "AB1-TEST", phase: "engine-confirmed" },
          truth: {
            contextState: "running",
            engineState: "engine-confirmed",
            activeSources: 0,
            scheduledSources: 12,
            rms: 0,
            maxRms: 0,
            peak: 0,
            signalEverConfirmed: false,
            audible: false,
          },
        };
      },
    },
    sidePanel: { setPanelBehavior: async () => {} },
    offscreen: { createDocument: async () => {} },
    storage: {
      session: {
        async get(key) {
          return key in storageData ? { [key]: structuredClone(storageData[key]) } : {};
        },
        async set(values) {
          Object.assign(storageData, structuredClone(values));
        },
      },
    },
    tabs: {
      async sendMessage(tabId, message, options) {
        tabMessages.push(structuredClone({ tabId, message, options }));
      },
    },
  };

  globalThis.chrome = chromeMock;
  try {
    await import(`../src/extension/service-worker.mjs?worker=before-${Date.now()}`);
    const firstWorker = listeners.at(-1);
    const requestId = "ab-restart-complete";
    const startup = await dispatchRuntimeMessage(firstWorker, {
      channel: "tonebloom.agent.v1",
      source: "web",
      type: "bridge:perform",
      requestId,
      score: DEFAULT_SCORE,
    }, {
      id: extensionId,
      url: "https://mhoydich.github.io/agent-bloom/#score/1/test",
      frameId: 0,
      tab: { id: 41 },
    });
    assert.equal(startup.state, "engine-confirmed");

    // Importing a fresh module simulates Chrome waking a new MV3 worker after
    // the original worker (and all of its in-memory state) was discarded.
    await import(`../src/extension/service-worker.mjs?worker=after-${Date.now()}`);
    const restartedWorker = listeners.at(-1);
    const completion = await dispatchRuntimeMessage(restartedWorker, {
      channel: "tonebloom.agent.v1",
      source: "offscreen",
      type: "audio:state",
      requestId,
      state: "complete",
      receipt: { receiptId: "AB1-TEST", phase: "complete" },
      truth: {
        contextState: "running",
        engineState: "complete",
        activeSources: 0,
        scheduledSources: 0,
        rms: 0,
        maxRms: 0.024,
        peak: 0,
        signalEverConfirmed: true,
        audible: false,
      },
    }, {
      id: extensionId,
      url: extensionUrl("offscreen.html"),
    });

    assert.equal(completion.state, "complete");
    assert.equal(completion.truth.signalEverConfirmed, true);
    assert.equal(completion.truth.maxRms, 0.024);
    assert.deepEqual(tabMessages.at(-1), {
      tabId: 41,
      options: { frameId: 0 },
      message: completion,
    });
    assert.deepEqual(storageData.agentBloomRoutes, {});
  } finally {
    delete globalThis.chrome;
  }
});

test("clean build copies the shared engine into both artifacts", () => {
  execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: root, stdio: "pipe" });
  for (const target of ["pages", "extension"]) {
    assert.ok(existsSync(join(root, "dist", target, "shared", "audio.mjs")));
    assert.ok(existsSync(join(root, "dist", target, "shared", "score.mjs")));
  }
  assert.ok(existsSync(join(root, "dist/pages/.nojekyll")));
  assert.ok(existsSync(join(root, "dist/extension/icons/icon-128.png")));
  const builtManifest = JSON.parse(execFileSync(
    process.execPath,
    ["-e", `process.stdout.write(require("node:fs").readFileSync(${JSON.stringify(join(root, "dist/extension/manifest.json"))}, "utf8"))`],
    { encoding: "utf8" },
  ));
  assert.equal(builtManifest.host_permissions, undefined);
});

async function allText(path) {
  let output = "";
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) output += await allText(child);
    else if (/\.(?:m?js|html|json|css)$/.test(entry.name)) output += `\n${await readFile(child, "utf8")}`;
  }
  return output;
}

function dispatchRuntimeMessage(listener, message, sender) {
  return new Promise((resolve, reject) => {
    const returned = listener(message, sender, resolve);
    if (returned !== true) reject(new Error("Expected an asynchronous runtime listener"));
  });
}
