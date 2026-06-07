import { existsSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config as loadEnv } from "dotenv";

const runtimeDir = path.dirname(fileURLToPath(import.meta.url));

export const backendDir = path.resolve(runtimeDir, "..");
export const repoRoot = path.resolve(runtimeDir, "../..");

function isTestEnv(): boolean {
  return process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}

function resolveDataDir(): string {
  const explicitDataDir = process.env.CLAUDIO_DATA_DIR?.trim();
  if (explicitDataDir) {
    return path.isAbsolute(explicitDataDir)
      ? explicitDataDir
      : path.resolve(repoRoot, explicitDataDir);
  }

  return path.join(repoRoot, isTestEnv() ? "data.test" : "data");
}

export const dataDir = resolveDataDir();
export const audioDir = path.join(dataDir, "audio");
export const frontendDistDir = path.join(repoRoot, "frontend", "dist");

const envCandidates = [
  path.join(repoRoot, ".env"),
  path.join(backendDir, ".env"),
  path.join(process.cwd(), ".env"),
];

for (const envPath of envCandidates) {
  if (existsSync(envPath)) {
    loadEnv({ path: envPath, override: false });
    break;
  }
}
