import { cp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const src = join(root, "src");
const dist = join(root, "dist");
const pagesOut = join(dist, "pages");
const extensionOut = join(dist, "extension");

await rm(dist, { recursive: true, force: true });
await mkdir(dist, { recursive: true });

await requireDir(join(src, "web"));
await requireDir(join(src, "shared"));
await requireDir(join(src, "extension"));

await cp(join(src, "web"), pagesOut, { recursive: true });
await cp(join(src, "shared"), join(pagesOut, "shared"), { recursive: true });
if (existsSync(join(src, "scores"))) {
  await cp(join(src, "scores"), join(pagesOut, "scores"), { recursive: true });
}
await writeFile(join(pagesOut, ".nojekyll"), "");

await cp(join(src, "extension"), extensionOut, { recursive: true });
await cp(join(src, "shared"), join(extensionOut, "shared"), { recursive: true });
await rewriteExtensionSharedImports(extensionOut);
if (existsSync(join(src, "scores"))) {
  await cp(join(src, "scores"), join(extensionOut, "scores"), { recursive: true });
}

await assertExtensionPolicy(extensionOut);
process.stdout.write(`Built ${relative(root, pagesOut)} and ${relative(root, extensionOut)}\n`);

async function requireDir(path) {
  if (!existsSync(path)) throw new Error(`Required source directory missing: ${relative(root, path)}`);
}

async function rewriteExtensionSharedImports(path) {
  for (const file of ["score-validation.mjs"]) {
    const target = join(path, file);
    const source = await readFile(target, "utf8");
    await writeFile(target, source.replaceAll('"../shared/', '"./shared/'));
  }
}

async function assertExtensionPolicy(path) {
  const manifest = JSON.parse(await readFile(join(path, "manifest.json"), "utf8"));
  const exact = ["sidePanel", "offscreen", "storage"];
  if (JSON.stringify(manifest.permissions) !== JSON.stringify(exact)) {
    throw new Error(`Extension permission allowlist changed: ${JSON.stringify(manifest.permissions)}`);
  }
  if (manifest.host_permissions || manifest.optional_host_permissions) {
    throw new Error("Extension artifact must not declare host permissions");
  }
  const expectedMatches = ["https://mhoydich.github.io/agent-bloom/*"];
  const actualMatches = manifest.content_scripts?.flatMap((entry) => entry.matches || []) || [];
  if (JSON.stringify(actualMatches) !== JSON.stringify(expectedMatches)) {
    throw new Error(`Extension content-script boundary changed: ${JSON.stringify(actualMatches)}`);
  }
  const referenced = [
    manifest.background?.service_worker,
    manifest.side_panel?.default_path,
    ...(manifest.content_scripts || []).flatMap((entry) => entry.js || []),
    ...Object.values(manifest.icons || {}),
  ];
  for (const file of referenced) {
    if (!file || !existsSync(join(path, file))) {
      throw new Error(`Extension manifest references missing file: ${String(file)}`);
    }
  }
  const source = await collectText(path);
  if (/\b(?:eval|Function)\s*\(/.test(source)) throw new Error("Extension artifact contains dynamic code execution");
  if (/\b(?:import|importScripts)\s*\(?\s*["']https?:\/\//.test(source)) {
    throw new Error("Extension artifact contains remotely hosted code");
  }
  await assertLocalModuleImports(path);
}

async function collectText(path) {
  let output = "";
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) output += await collectText(child);
    else if (/\.(?:m?js|html|json|css)$/.test(entry.name)) output += `\n${await readFile(child, "utf8")}`;
  }
  return output;
}

async function assertLocalModuleImports(path) {
  for (const file of await collectModuleFiles(path)) {
    const source = await readFile(file, "utf8");
    const patterns = [
      /(?:import|export)\s+(?:[^"']*?\s+from\s*)?["']([^"']+)["']/gs,
      /import\s*\(\s*["']([^"']+)["']\s*\)/g,
    ];
    for (const pattern of patterns) {
      for (const match of source.matchAll(pattern)) {
        const specifier = match[1];
        if (!specifier.startsWith(".")) {
          throw new Error(`Extension module has a non-local import: ${specifier}`);
        }
        if (!existsSync(resolve(dirname(file), specifier))) {
          throw new Error(`Extension module import is missing: ${relative(path, file)} -> ${specifier}`);
        }
      }
    }
  }
}

async function collectModuleFiles(path) {
  const files = [];
  for (const entry of await readdir(path, { withFileTypes: true })) {
    const child = join(path, entry.name);
    if (entry.isDirectory()) files.push(...await collectModuleFiles(child));
    else if (/\.m?js$/.test(entry.name)) files.push(child);
  }
  return files;
}
