import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { readFile, readdir } from "node:fs/promises";
import { dirname, extname, join, relative, resolve } from "node:path";
import test from "node:test";

const root = resolve(".");
const canonical = "https://mhoydich.github.io/agent-bloom/";
const pages = join(root, "dist/pages");

test("Pages is a closed native-ESM artifact with complete static discovery", async () => {
  // extension.test.mjs also proves the clean build. Give that parallel test's
  // destructive dist refresh time to finish, then build the artifact we audit.
  await new Promise((resolveDelay) => setTimeout(resolveDelay, 300));
  buildPagesWithRetry();

  for (const path of [
    "index.html",
    "style.css",
    "main.mjs",
    "visuals.mjs",
    "assets/agent-bloom-og.png",
    "shared/audio.mjs",
    "shared/score.mjs",
    "agent.json",
    ".well-known/tone-bloom-agent.json",
    "llms.txt",
    "robots.txt",
    "sitemap.xml",
    ".nojekyll",
  ]) {
    assert.ok(existsSync(join(pages, path)), `missing Pages asset: ${path}`);
  }

  const modules = await collectFiles(pages, (path) => /\.m?js$/.test(path));
  for (const modulePath of modules) {
    execFileSync(process.execPath, ["--check", modulePath], { cwd: root, stdio: "pipe" });
    const source = await readFile(modulePath, "utf8");
    for (const specifier of moduleSpecifiers(source)) {
      assert.ok(specifier.startsWith("."), `${relative(pages, modulePath)} has non-local import ${specifier}`);
      const target = resolve(dirname(modulePath), specifier);
      assert.ok(existsSync(target), `${relative(pages, modulePath)} imports missing ${specifier}`);
    }
  }

  const html = await readFile(join(pages, "index.html"), "utf8");
  for (const reference of html.matchAll(/\b(?:href|src)=["']([^"']+)["']/g)) {
    const value = reference[1];
    if (/^(?:https?:|#)/.test(value)) continue;
    assert.ok(existsSync(resolve(pages, value)), `index.html references missing ${value}`);
  }
  assert.match(html, /<script type="module" src="\.\/main\.mjs"><\/script>/);
  assert.match(html, /<link rel="stylesheet" href="\.\/style\.css">/);
  assert.match(html, new RegExp(`<link rel="canonical" href="${escapeRegExp(canonical)}">`));
  assert.match(html, /<meta property="og:image:width" content="1200">/);
  assert.match(html, /<meta property="og:image:height" content="630">/);
  assert.match(html, /<link rel="alternate" type="application\/json" href="\.\/agent\.json"/);
});

test("Pages workflow preserves the well-known hidden contract", async () => {
  const workflow = await readFile(join(root, ".github/workflows/pages.yml"), "utf8");
  assert.match(workflow, /include-hidden-files:\s*true/);
});

test("poster is the reviewed exact 1200 by 630 social artifact", async () => {
  const png = await readFile(join(root, "src/web/assets/agent-bloom-og.png"));
  assert.equal(png.subarray(0, 8).toString("hex"), "89504e470d0a1a0a");
  assert.equal(png.readUInt32BE(16), 1200);
  assert.equal(png.readUInt32BE(20), 630);
  assert.equal(createHash("sha256").update(png).digest("hex"), "2370c52247d427884da62f7f00df4b5e909c2d0e7a1a02af53447d1e57aba769");
  assert.ok(png.byteLength < 1_500_000, `poster should remain optimized; got ${png.byteLength} bytes`);
});

test("machine contracts agree on a finite autonomous and honest interface", async () => {
  const primary = JSON.parse(await readFile(join(pages, "agent.json"), "utf8"));
  const wellKnown = JSON.parse(await readFile(join(pages, ".well-known/tone-bloom-agent.json"), "utf8"));
  assert.deepEqual(wellKnown, primary);
  assert.equal(primary.canonicalUrl, canonical);
  assert.equal(primary.protocol, "tonebloom.agent.v1");
  assert.equal(primary.durationMs, 88_000);
  assert.equal(primary.autonomous, true);
  assert.equal(primary.humanInteractionRequired, false);
  assert.deepEqual(primary.interfaces.methods, ["describe", "perform", "queue", "status", "stop"]);
  assert.equal(primary.interfaces.nativeControls.perform, "#agent-perform");
  assert.match(primary.audioPolicy, /blocked/);
  assert.match(primary.audioPolicy, /never claimed/);

  const llms = await readFile(join(pages, "llms.txt"), "utf8");
  const robots = await readFile(join(pages, "robots.txt"), "utf8");
  const sitemap = await readFile(join(pages, "sitemap.xml"), "utf8");
  for (const source of [llms, robots, sitemap]) assert.match(source, new RegExp(escapeRegExp(canonical)));
  assert.match(robots, /Sitemap: https:\/\/mhoydich\.github\.io\/agent-bloom\/sitemap\.xml/);
  assert.match(sitemap, /<loc>https:\/\/mhoydich\.github\.io\/agent-bloom\/<\/loc>/);
});

test("web runtime is companion-first, semantic, serialized, and truth-preserving", async () => {
  const source = await readFile(join(pages, "main.mjs"), "utf8");
  assert.match(source, /<canvas id="score-canvas" role="img" aria-label=/);
  assert.doesNotMatch(source, /class="score-state"[^>]*aria-live/);
  assert.match(source, /id="performance-state" role="status" aria-live="polite"/);
  assert.match(source, /BROWSER COMPANION CONTROL/);
  assert.match(source, />AI: PERFORM CURRENT SCORE<\/button>/);
  assert.match(source, />AI: STOP<\/button>/);
  assert.doesNotMatch(source, />\s*(?:CLICK|TAP|START|PLAY|ENABLE AUDIO)\s*</i);
  assert.match(source, /SIGNED 5\.6 SOL · MIKE HOYDICH/);
  assert.match(source, /serializeOperation/);
  assert.match(source, /generation/);
  assert.match(source, /settleAllBridgeRequests\("stopped"\)/);
  assert.match(source, /setState\("stopped", \{ truth \}\)/);
  assert.match(source, /if \("truth" in detail\) currentTruth = detail\.truth \|\| null;\s*updateCountdown\(\);\s*updateMachineStatus\(\);/s);
  assert.match(source, /bridge-state-timeout/);
  assert.match(source, /setState\("ended-unconfirmed"/);
  assert.doesNotMatch(source, /bridge:accent/);
  assert.doesNotMatch(source, /performLocal/);
  assert.match(source, /"engine-confirmed"/);
  assert.match(source, /"queued"/);
  assert.match(source, /"rejected"/);
  assert.match(source, /"ended-unconfirmed"/);
  assert.match(source, /localSignal: transport === "local"/);
  assert.match(source, /catch \(error\) \{\s*booted = true;\s*rejectScore\(error, "invalid-score-fragment"\);\s*return;/s);
  assert.doesNotMatch(source, /catch\s*\{\s*score\s*=\s*DEFAULT_SCORE/);
  assert.match(source, /setInterval\(updateCountdown, 1_000\)/);
  assert.match(source, /TERMINAL_STATES\.has\(currentState\)/);
  assert.match(source, /\.\/assets\/agent-bloom-og\.png/);

  const css = await readFile(join(pages, "style.css"), "utf8");
  assert.match(css, /\[data-state="playing"\] \.score-state\s*\{\s*color: var\(--ink\);\s*background: var\(--orange\);/s);
});

test("browser companion controls meet the mobile target floor", async () => {
  const css = await readFile(join(pages, "style.css"), "utf8");
  assert.match(css, /\.companion-controls button\s*\{[^}]*min-height:\s*48px/s);
});

async function collectFiles(path, predicate) {
  const output = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) output.push(...await collectFiles(child, predicate));
    else if (predicate(child)) output.push(child);
  }
  return output;
}

function moduleSpecifiers(source) {
  const output = [];
  const patterns = [
    /(?:import|export)\s+(?:[^"']*?\s+from\s*)?["']([^"']+)["']/gs,
    /import\s*\(\s*["']([^"']+)["']\s*\)/g,
  ];
  for (const pattern of patterns) {
    for (const match of source.matchAll(pattern)) output.push(match[1]);
  }
  return output;
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function buildPagesWithRetry() {
  let lastError;
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      execFileSync(process.execPath, ["scripts/build.mjs"], { cwd: root, stdio: "pipe" });
      return;
    } catch (error) {
      lastError = error;
    }
  }
  throw lastError;
}
