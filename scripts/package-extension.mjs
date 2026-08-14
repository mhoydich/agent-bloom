import { access, mkdir, rm } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const extensionDir = resolve(root, "dist/extension");
const packageDir = resolve(root, "dist/packages");
const output = resolve(packageDir, "agent-bloom-bridge.zip");

await access(resolve(extensionDir, "manifest.json"));
await mkdir(packageDir, { recursive: true });
await rm(output, { force: true });
const result = spawnSync("zip", ["-X", "-q", "-r", output, "."], {
  cwd: extensionDir,
  stdio: "inherit",
});
if (result.status !== 0) throw new Error("zip failed while packaging the extension");
process.stdout.write(`${output.slice(root.length + 1)}\n`);
