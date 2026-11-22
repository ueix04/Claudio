import { fetchViaMusicRelay, hasMusicRelay, MUSIC_ROUTE_TIMEOUT_MS } from "./relay.js";

export async function fetchSourceText(url: URL, init: RequestInit = {}): Promise<string> {
  const headers = new Headers(init.headers);
  headers.set("User-Agent", "Claudio/1.0");
  const signal = AbortSignal.timeout(4_000);
  const request: RequestInit = {
    ...init,
    headers,
    redirect: "error",
    signal,
  };
  let response: Response | undefined;
  if (hasMusicRelay()) {
    try {
      response = await fetchViaMusicRelay(url, {
        ...request,
        signal: AbortSignal.any([signal, AbortSignal.timeout(MUSIC_ROUTE_TIMEOUT_MS)]),
      });
    } catch {
      // Keep direct lookup available when the desktop or tunnel is offline.
    }
  }
  response ??= await fetch(url, request);
  if (!response.ok) {
    await response.body?.cancel().catch(() => {});
    throw new Error(`Music source returned HTTP ${response.status}`);
  }
  return response.text();
}

export async function fetchSourceJson<T>(url: URL, init?: RequestInit): Promise<T> {
  const text = await fetchSourceText(url, init);
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new Error("Music source returned invalid JSON");
  }
}
