import { readdir, readFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { normalizeScore } from "../src/shared/score.mjs";

const scoresDir = resolve("src/scores");
if (!existsSync(scoresDir)) {
  process.stdout.write("No packaged scores; URL score grammar is canonical\n");
  process.exit(0);
}
const files = (await readdir(scoresDir)).filter((name) => name.endsWith(".json"));
if (!files.length) throw new Error("No score JSON files found");

for (const file of files) {
  const value = JSON.parse(await readFile(join(scoresDir, file), "utf8"));
  if (file === "index.json" || file.includes("schema")) continue;
  try {
    normalizeScore(value);
  } catch (error) {
    throw new Error(`${file} is not a valid AgentScoreV1: ${error.message}`, { cause: error });
  }
}

process.stdout.write(`Validated ${files.length} score JSON file(s)\n`);
