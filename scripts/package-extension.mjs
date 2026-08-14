import { access, mkdir, readdir, rm, utimes } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = resolve(root, "dist/extension");
const packageDir = resolve(root, "dist/packages");
const output = resolve(packageDir, "agent-bloom-bridge.zip");
const archiveMtime = new Date("2000-01-01T00:00:00.000Z");

await access(resolve(extensionDir, "manifest.json"));
await mkdir(packageDir, { recursive: true });
await rm(output, { force: true });
const entries = await collectEntries(extensionDir);
if (!entries.length) throw new Error("Extension artifact is empty");
const result = spawnSync("zip", ["-X", "-q", "-D", output, ...entries], {
  cwd: extensionDir,
  env: { ...process.env, TZ: "UTC" },
  stdio: "inherit",
});
if (result.status !== 0) throw new Error("zip failed while packaging the extension");
process.stdout.write(`${output.slice(root.length + 1)}\n`);

async function collectEntries(path) {
  const entries = await readdir(path, { withFileTypes: true });
  entries.sort((left, right) => left.name.localeCompare(right.name, "en"));
  const files = [];
  for (const entry of entries) {
    const child = join(path, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Extension artifact contains a symlink: ${relative(extensionDir, child)}`);
    if (entry.isDirectory()) {
      files.push(...await collectEntries(child));
      continue;
    }
    if (!entry.isFile()) throw new Error(`Extension artifact contains an unsupported entry: ${relative(extensionDir, child)}`);
    await utimes(child, archiveMtime, archiveMtime);
    files.push(relative(extensionDir, child));
  }
  return files;
}
