import { fetchViaMusicRelay, hasMusicRelay, MUSIC_ROUTE_TIMEOUT_MS } from "./relay.js";

const MUSIC_AUDIO_DOMAINS = [
  "music.126.net",
  "music.163.com",
  "kuwo.cn",
  "bodian.com",
  "kugou.com",
  "kgimg.com",
  "migu.cn",
  "aqqmusic.tc.qq.com",
  "stream.qqmusic.qq.com",
];
const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);
const MAX_AUDIO_REDIRECTS = 5;

export function parseMusicAudioUrl(value: string, base?: URL): URL | null {
  try {
    const url = new URL(value, base);
    if (
      (url.protocol !== "http:" && url.protocol !== "https:")
      || url.username || url.password || url.port
    ) {
      return null;
    }

    const allowed = MUSIC_AUDIO_DOMAINS.some((domain) =>
      url.hostname === domain || url.hostname.endsWith(`.${domain}`),
    );
    return allowed ? url : null;
  } catch {
    return null;
  }
}
export async function fetchMusicAudio(
  url: URL,
  options: { range?: string; signal: AbortSignal },
): Promise<Response> {
  const initialTarget = parseMusicAudioUrl(url.href);
  if (!initialTarget) {
    throw new Error("Invalid music audio URL");
  }

  const headers = {
    "User-Agent": "Mozilla/5.0 Claudio/1.0",
    Accept: "audio/*,*/*;q=0.9",
    "Accept-Encoding": "identity",
    ...(options.range ? { Range: options.range } : {}),
  };
  if (!hasMusicRelay()) {
    return fetchAudioWithRedirects(initialTarget, headers, options.signal, fetch);
  }

  const direct = new AbortController();
  const timeout = setTimeout(() => direct.abort(), MUSIC_ROUTE_TIMEOUT_MS);
  try {
    const response = await fetchAudioWithRedirects(
      initialTarget,
      headers,
      AbortSignal.any([options.signal, direct.signal]),
      fetch,
    );
    const mediaType = response.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    if (response.status === 416 || (
      response.ok && response.body
      && !mediaType?.startsWith("text/") && mediaType !== "application/json"
    )) {
      return response;
    }
    await response.body?.cancel().catch(() => {});
  } catch (error) {
    if (options.signal.aborted) throw error;
  } finally {
    clearTimeout(timeout);
  }
  return fetchAudioWithRedirects(initialTarget, headers, options.signal, fetchViaMusicRelay);
}

async function fetchAudioWithRedirects(
  initialTarget: URL,
  headers: HeadersInit,
  signal: AbortSignal,
  request: (url: URL, init: RequestInit) => Promise<Response>,
): Promise<Response> {
  let target = initialTarget;
  for (let redirects = 0; redirects <= MAX_AUDIO_REDIRECTS; redirects++) {
    const response = await request(target, {
      headers,
      redirect: "manual",
      signal,
    });
    if (!REDIRECT_STATUSES.has(response.status)) {
      return response;
    }

    const location = response.headers.get("location");
    await response.body?.cancel().catch(() => {});
    const nextTarget = location ? parseMusicAudioUrl(location, target) : null;
    if (!nextTarget) {
      throw new Error("Invalid music audio redirect");
    }
    target = nextTarget;
  }
  throw new Error("Too many music audio redirects");
}
