import { statSync } from "node:fs";
import path from "node:path";
import { fetch as undiciFetch, ProxyAgent } from "undici";
import { dataDir } from "../runtime.js";

const relaySocket = path.join(dataDir, "music-relay", "relay.sock");
export const MUSIC_ROUTE_TIMEOUT_MS = 2_500;
let dispatcher: ProxyAgent | undefined;

export function hasMusicRelay(): boolean {
  return process.platform !== "win32" && (statSync(relaySocket, { throwIfNoEntry: false })?.isSocket() ?? false);
}

export async function fetchViaMusicRelay(url: URL, init: RequestInit): Promise<Response> {
  dispatcher ??= new ProxyAgent({
    uri: "http://localhost",
    proxyTls: { socketPath: relaySocket },
  });
  return await undiciFetch(url.href, {
    ...(init as Parameters<typeof undiciFetch>[1]),
    dispatcher,
  }) as unknown as Response;
}
