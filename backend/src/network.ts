import { fetch as undiciFetch, ProxyAgent } from "undici";

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

export function getNetworkProxyUrl(): string | undefined {
  const explicit = (process.env.NETWORK_PROXY_URL || process.env.EXTERNAL_PROXY_URL || "").trim();
  if (explicit) return explicit;

  const host = process.env.NETWORK_PROXY_HOST?.trim();
  if (!host) return undefined;

  const port = process.env.NETWORK_PROXY_PORT?.trim() || DEFAULT_PROXY_PORT;
  return `http://${host}:${port}`;
}

export function hasNetworkProxyConfigured(): boolean {
  return Boolean(getNetworkProxyUrl());
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

async function wait(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withDirectRetry<T>(
  label: string,
  operation: () => Promise<T>,
  options?: {
    attempts?: number;
    delayMs?: number;
  },
): Promise<T> {
  const attempts = Math.max(1, options?.attempts ?? 3);
  const delayMs = Math.max(0, options?.delayMs ?? 400);
  let lastError: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await operation();
    } catch (error) {
      lastError = error;
      if (!isLikelyNetworkError(error) || attempt === attempts) {
        throw error;
      }
      console.warn(
        `${label} direct request failed (${getNetworkErrorMessage(error)}), retry ${attempt + 1}/${attempts}`,
      );
      await wait(delayMs * attempt);
    }
  }

  throw lastError;
}

export async function withConfiguredProxy<T>(
  label: string,
  operation: (proxyUrl?: string) => Promise<T>,
): Promise<T> {
  const proxyUrl = getNetworkProxyUrl();
  if (proxyUrl) {
    return operation(proxyUrl);
  }

  return withDirectRetry(label, () => operation());
}

export async function fetchWithDirectRetry(
  input: string | URL,
  init: RequestInit,
  label: string,
  options?: {
    attempts?: number;
    delayMs?: number;
  },
): Promise<Response> {
  return withDirectRetry(label, () => fetch(input, init), options);
}

export async function fetchWithConfiguredProxy(
  input: string | URL,
  init: RequestInit,
  label: string,
): Promise<Response> {
  const proxyUrl = getNetworkProxyUrl();
  if (proxyUrl) {
    return fetchViaProxy(input, init);
  }

  return fetchWithDirectRetry(input, init, label);
}

export async function fetchViaProxy(
  input: string | URL,
  init: RequestInit = {},
): Promise<Response> {
  const proxyUrl = getNetworkProxyUrl();
  if (!proxyUrl) {
    throw new Error("Network proxy is not configured");
  }
  const proxiedInit = {
    ...init,
    dispatcher: getProxyAgent(proxyUrl),
  } as any;

  return await undiciFetch(String(input), proxiedInit) as unknown as Response;
}
