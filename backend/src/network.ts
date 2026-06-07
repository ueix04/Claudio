import { fetch as undiciFetch, ProxyAgent } from "undici";

const DEFAULT_PROXY_HOST = "127.0.0.1";
const DEFAULT_PROXY_PORT = "7897";
const NETWORK_ERROR_PATTERNS = [
  "fetch failed",
  "econnreset",
  "socket hang up",
  "etimedout",
  "connect timeout",
  "enotfound",
  "eai_again",
  "econnrefused",
  "und_err",
];

const proxyAgentCache = new Map<string, ProxyAgent>();

function getProxyAgent(proxyUrl: string): ProxyAgent {
  let agent = proxyAgentCache.get(proxyUrl);
  if (!agent) {
    agent = new ProxyAgent(proxyUrl);
    proxyAgentCache.set(proxyUrl, agent);
  }
  return agent;
}

function toMessagePart(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  return "";
}

export function getNetworkProxyUrl(): string {
  const explicit = (process.env.NETWORK_PROXY_URL || process.env.EXTERNAL_PROXY_URL || "").trim();
  if (explicit) return explicit;

  const host = (process.env.NETWORK_PROXY_HOST || DEFAULT_PROXY_HOST).trim() || DEFAULT_PROXY_HOST;
  const port = (process.env.NETWORK_PROXY_PORT || DEFAULT_PROXY_PORT).trim() || DEFAULT_PROXY_PORT;
  return `http://${host}:${port}`;
}

export function getNetworkErrorMessage(error: unknown): string {
  if (error instanceof Error) {
    const cause = error.cause as { message?: unknown; code?: unknown } | undefined;
    return [
      error.message,
      toMessagePart(cause?.message),
      toMessagePart(cause?.code),
    ].filter(Boolean).join(" | ");
  }

  if (error && typeof error === "object") {
    const neteaseError = error as {
      status?: unknown;
      body?: { msg?: unknown; code?: unknown };
      message?: unknown;
    };

    return [
      toMessagePart(neteaseError.message),
      toMessagePart(neteaseError.status),
      toMessagePart(neteaseError.body?.code),
      toMessagePart(neteaseError.body?.msg),
    ].filter(Boolean).join(" | ");
  }

  return String(error);
}

export function isLikelyNetworkError(error: unknown): boolean {
  const message = getNetworkErrorMessage(error).toLowerCase();
  if (NETWORK_ERROR_PATTERNS.some((pattern) => message.includes(pattern))) {
    return true;
  }

  if (error && typeof error === "object") {
    const neteaseError = error as {
      status?: unknown;
      body?: { code?: unknown; msg?: unknown };
    };
    return Number(neteaseError.status) === 502 || Number(neteaseError.body?.code) === 502;
  }

  return false;
}

export async function withProxyFallback<T>(
  label: string,
  operation: (proxyUrl?: string) => Promise<T>,
): Promise<T> {
  try {
    return await operation();
  } catch (error) {
    if (!isLikelyNetworkError(error)) {
      throw error;
    }

    const proxyUrl = getNetworkProxyUrl();
    console.warn(
      `${label} direct request failed (${getNetworkErrorMessage(error)}), retrying via proxy ${proxyUrl}`,
    );
    return operation(proxyUrl);
  }
}

export async function fetchWithProxyFallback(
  input: string | URL,
  init: RequestInit,
  label: string,
): Promise<Response> {
  try {
    return await fetch(input, init);
  } catch (error) {
    if (!isLikelyNetworkError(error)) {
      throw error;
    }

    const proxyUrl = getNetworkProxyUrl();
    console.warn(
      `${label} direct request failed (${getNetworkErrorMessage(error)}), retrying via proxy ${proxyUrl}`,
    );

    const proxiedInit = {
      ...init,
      dispatcher: getProxyAgent(proxyUrl),
    } as any;

    return await undiciFetch(String(input), proxiedInit) as unknown as Response;
  }
}
