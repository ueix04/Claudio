export async function fetchSourceText(url: URL, init: RequestInit = {}): Promise<string> {
  const headers = new Headers(init.headers);
  headers.set("User-Agent", "Claudio/1.0");
  const response = await fetch(url, {
    ...init,
    headers,
    redirect: "error",
    signal: AbortSignal.timeout(4_000),
  });
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
