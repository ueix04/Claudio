const OPENWEATHER_API_BASE = "https://api.openweathermap.org";
const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_REFRESH_MS = 60 * 60 * 1000;

export type WeatherUnits = "standard" | "metric" | "imperial";

export interface WeatherRequest {
  city?: string;
  country?: string;
  lat?: number;
  lon?: number;
  units?: WeatherUnits;
  lang?: string;
}

export interface CurrentWeather {
  source: "openweather";
  fetchedAt: number;
  location: {
    name: string;
    country?: string;
    state?: string;
    lat: number;
    lon: number;
  };
  weather: {
    id?: number;
    main?: string;
    description: string;
    icon?: string;
    iconUrl?: string;
  };
  temperature: {
    actual: number;
    feelsLike: number;
    min: number;
    max: number;
    unit: "K" | "°C" | "°F";
  };
  wind: {
    speed: number;
    deg?: number;
    gust?: number;
    unit: "m/s" | "mph";
  };
  humidity: number;
  pressure: number;
  clouds?: number;
  visibility?: number;
  precipitation: {
    rain1h?: number;
    snow1h?: number;
    unit: "mm";
  };
  observedAt: number;
  sunriseAt?: number;
  sunsetAt?: number;
  timezoneOffset: number;
}

export interface CachedWeatherSnapshot {
  weather: CurrentWeather;
  promptContext: string;
  fetchedAt: number;
  expiresAt: number;
}

export class WeatherConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WeatherConfigError";
  }
}

export class WeatherInputError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WeatherInputError";
  }
}

export class WeatherUpstreamError extends Error {
  status: number;

  constructor(message: string, status: number) {
    super(message);
    this.name = "WeatherUpstreamError";
    this.status = status;
  }
}

interface OpenWeatherGeoResult {
  name: string;
  lat: number;
  lon: number;
  country?: string;
  state?: string;
}

interface OpenWeatherCurrentWeatherResponse {
  coord: {
    lon: number;
    lat: number;
  };
  weather?: Array<{
    id?: number;
    main?: string;
    description?: string;
    icon?: string;
  }>;
  main: {
    temp: number;
    feels_like: number;
    temp_min: number;
    temp_max: number;
    pressure: number;
    humidity: number;
  };
  visibility?: number;
  wind?: {
    speed: number;
    deg?: number;
    gust?: number;
  };
  clouds?: {
    all?: number;
  };
  rain?: {
    "1h"?: number;
  };
  snow?: {
    "1h"?: number;
  };
  dt: number;
  sys?: {
    sunrise?: number;
    sunset?: number;
    country?: string;
  };
  timezone?: number;
  name?: string;
}

let cachedDefaultWeather: CachedWeatherSnapshot | null = null;
let refreshTimer: NodeJS.Timeout | null = null;
let refreshInFlight: Promise<CachedWeatherSnapshot | null> | null = null;
let refreshLoopStarted = false;

function parseOptionalNumber(raw: string | undefined): number | undefined {
  if (!raw) return undefined;

  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

function getApiKey(): string {
  const apiKey = process.env.OPENWEATHER_API_KEY?.trim();
  if (!apiKey) {
    throw new WeatherConfigError("Missing OPENWEATHER_API_KEY");
  }

  return apiKey;
}

function getTimeoutMs(): number {
  const envValue = parseOptionalNumber(process.env.OPENWEATHER_TIMEOUT_MS?.trim());
  return envValue && envValue > 0 ? envValue : DEFAULT_TIMEOUT_MS;
}

function getRefreshIntervalMs(): number {
  const envValue = parseOptionalNumber(process.env.OPENWEATHER_REFRESH_MS?.trim());
  return envValue && envValue > 0 ? envValue : DEFAULT_REFRESH_MS;
}

function isTestEnv(): boolean {
  return process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}

function isWeatherUnits(value: string | undefined): value is WeatherUnits {
  return value === "standard" || value === "metric" || value === "imperial";
}

function resolveUnits(requestUnits?: string): WeatherUnits {
  const candidate = (requestUnits || process.env.OPENWEATHER_DEFAULT_UNITS || "metric").trim().toLowerCase();
  if (!isWeatherUnits(candidate)) {
    throw new WeatherInputError(`Unsupported weather units: ${candidate}`);
  }

  return candidate;
}

function resolveLang(requestLang?: string): string {
  const candidate = requestLang?.trim() || process.env.OPENWEATHER_DEFAULT_LANG?.trim();
  return candidate || "zh_cn";
}

function resolveDefaultLocation(): Pick<WeatherRequest, "city" | "country" | "lat" | "lon"> {
  return {
    city: process.env.OPENWEATHER_DEFAULT_CITY?.trim() || undefined,
    country: process.env.OPENWEATHER_DEFAULT_COUNTRY?.trim() || undefined,
    lat: parseOptionalNumber(process.env.OPENWEATHER_DEFAULT_LAT?.trim()),
    lon: parseOptionalNumber(process.env.OPENWEATHER_DEFAULT_LON?.trim()),
  };
}

export function hasDefaultWeatherLocation(): boolean {
  const defaults = resolveDefaultLocation();
  return (
    (typeof defaults.lat === "number" && typeof defaults.lon === "number")
    || typeof defaults.city === "string"
  );
}

export function canFetchDefaultWeather(): boolean {
  return Boolean(process.env.OPENWEATHER_API_KEY?.trim()) && hasDefaultWeatherLocation();
}

function isSnapshotFresh(snapshot: CachedWeatherSnapshot): boolean {
  return snapshot.expiresAt > Date.now();
}

function getTemperatureUnit(units: WeatherUnits): "K" | "°C" | "°F" {
  if (units === "imperial") return "°F";
  if (units === "metric") return "°C";
  return "K";
}

function getWindUnit(units: WeatherUnits): "m/s" | "mph" {
  return units === "imperial" ? "mph" : "m/s";
}

function buildIconUrl(icon?: string): string | undefined {
  return icon ? `https://openweathermap.org/img/wn/${icon}@2x.png` : undefined;
}

async function requestOpenWeather<T>(pathname: string, searchParams: Record<string, string | number | undefined>): Promise<T> {
  const apiKey = getApiKey();
  const url = new URL(pathname, OPENWEATHER_API_BASE);

  for (const [key, value] of Object.entries(searchParams)) {
    if (value !== undefined) {
      url.searchParams.set(key, String(value));
    }
  }
  url.searchParams.set("appid", apiKey);

  const response = await fetch(url, {
    headers: {
      Accept: "application/json",
    },
    signal: AbortSignal.timeout(getTimeoutMs()),
  });

  const text = await response.text();
  const parsed = text ? JSON.parse(text) as unknown : null;

  if (!response.ok) {
    const upstreamMessage = typeof (parsed as { message?: unknown } | null)?.message === "string"
      ? (parsed as { message: string }).message
      : `OpenWeather request failed: ${response.status}`;
    throw new WeatherUpstreamError(upstreamMessage, response.status);
  }

  return parsed as T;
}

async function geocodeCity(city: string, country: string | undefined): Promise<OpenWeatherGeoResult> {
  const query = country ? `${city},${country}` : city;
  const results = await requestOpenWeather<OpenWeatherGeoResult[]>("/geo/1.0/direct", {
    q: query,
    limit: 1,
  });

  if (!Array.isArray(results) || results.length === 0) {
    throw new WeatherInputError(`Location not found: ${query}`);
  }

  return results[0];
}

function normalizeWeatherResponse(
  payload: OpenWeatherCurrentWeatherResponse,
  units: WeatherUnits,
  fallbackLocation?: OpenWeatherGeoResult,
): CurrentWeather {
  const primaryWeather = Array.isArray(payload.weather) && payload.weather.length > 0
    ? payload.weather[0]
    : undefined;

  return {
    source: "openweather",
    fetchedAt: Date.now(),
    location: {
      name: payload.name || fallbackLocation?.name || "Unknown",
      country: payload.sys?.country || fallbackLocation?.country,
      state: fallbackLocation?.state,
      lat: payload.coord?.lat ?? fallbackLocation?.lat ?? 0,
      lon: payload.coord?.lon ?? fallbackLocation?.lon ?? 0,
    },
    weather: {
      id: primaryWeather?.id,
      main: primaryWeather?.main,
      description: primaryWeather?.description || primaryWeather?.main || "Unknown",
      icon: primaryWeather?.icon,
      iconUrl: buildIconUrl(primaryWeather?.icon),
    },
    temperature: {
      actual: payload.main.temp,
      feelsLike: payload.main.feels_like,
      min: payload.main.temp_min,
      max: payload.main.temp_max,
      unit: getTemperatureUnit(units),
    },
    wind: {
      speed: payload.wind?.speed ?? 0,
      deg: payload.wind?.deg,
      gust: payload.wind?.gust,
      unit: getWindUnit(units),
    },
    humidity: payload.main.humidity,
    pressure: payload.main.pressure,
    clouds: payload.clouds?.all,
    visibility: payload.visibility,
    precipitation: {
      rain1h: payload.rain?.["1h"],
      snow1h: payload.snow?.["1h"],
      unit: "mm",
    },
    observedAt: payload.dt * 1000,
    sunriseAt: payload.sys?.sunrise ? payload.sys.sunrise * 1000 : undefined,
    sunsetAt: payload.sys?.sunset ? payload.sys.sunset * 1000 : undefined,
    timezoneOffset: payload.timezone ?? 0,
  };
}

export async function getCurrentWeather(request: WeatherRequest = {}): Promise<CurrentWeather> {
  const units = resolveUnits(request.units);
  const lang = resolveLang(request.lang);
  const defaults = resolveDefaultLocation();

  const requestHasCoords = typeof request.lat === "number" || typeof request.lon === "number";
  if (requestHasCoords && (typeof request.lat !== "number" || typeof request.lon !== "number")) {
    throw new WeatherInputError("lat and lon must be provided together");
  }

  const city = request.city?.trim();
  const country = request.country?.trim();
  const shouldUseRequestCoords = typeof request.lat === "number" && typeof request.lon === "number";
  const shouldUseDefaultCoords =
    !shouldUseRequestCoords
    && !city
    && typeof defaults.lat === "number"
    && typeof defaults.lon === "number";

  let fallbackLocation: OpenWeatherGeoResult | undefined;
  let lat: number;
  let lon: number;

  if (shouldUseRequestCoords) {
    lat = request.lat!;
    lon = request.lon!;
  } else if (shouldUseDefaultCoords) {
    lat = defaults.lat!;
    lon = defaults.lon!;
  } else {
    const resolvedCity = city || defaults.city;
    const resolvedCountry = country || defaults.country;

    if (!resolvedCity) {
      throw new WeatherInputError(
        "Weather location is required. Provide city or lat/lon, or set OPENWEATHER_DEFAULT_CITY / OPENWEATHER_DEFAULT_LAT and OPENWEATHER_DEFAULT_LON.",
      );
    }

    fallbackLocation = await geocodeCity(resolvedCity, resolvedCountry);
    lat = fallbackLocation.lat;
    lon = fallbackLocation.lon;
  }

  const payload = await requestOpenWeather<OpenWeatherCurrentWeatherResponse>("/data/2.5/weather", {
    lat,
    lon,
    units,
    lang,
  });

  return normalizeWeatherResponse(payload, units, fallbackLocation);
}

function formatNumber(value: number): string {
  if (Number.isInteger(value)) {
    return String(value);
  }

  return value.toFixed(1);
}

export function buildWeatherPromptContext(weather: CurrentWeather): string {
  const location = [weather.location.name, weather.location.country].filter(Boolean).join(", ");
  const parts = [
    `${location}当前天气${weather.weather.description}`,
    `气温${formatNumber(weather.temperature.actual)}${weather.temperature.unit}`,
    `体感${formatNumber(weather.temperature.feelsLike)}${weather.temperature.unit}`,
    `湿度${weather.humidity}%`,
  ];

  if (typeof weather.wind.speed === "number") {
    parts.push(`风速${formatNumber(weather.wind.speed)} ${weather.wind.unit}`);
  }

  if (typeof weather.precipitation.rain1h === "number") {
    parts.push(`近1小时降雨${formatNumber(weather.precipitation.rain1h)} ${weather.precipitation.unit}`);
  }

  if (typeof weather.precipitation.snow1h === "number") {
    parts.push(`近1小时降雪${formatNumber(weather.precipitation.snow1h)} ${weather.precipitation.unit}`);
  }

  return parts.join("，");
}

export function getCachedDefaultWeather(): CachedWeatherSnapshot | null {
  return cachedDefaultWeather;
}

export async function refreshDefaultWeatherCache(): Promise<CachedWeatherSnapshot | null> {
  if (!canFetchDefaultWeather()) {
    return null;
  }

  if (refreshInFlight) {
    return refreshInFlight;
  }

  refreshInFlight = (async () => {
    const weather = await getCurrentWeather();
    const fetchedAt = Date.now();
    const snapshot: CachedWeatherSnapshot = {
      weather,
      promptContext: buildWeatherPromptContext(weather),
      fetchedAt,
      expiresAt: fetchedAt + getRefreshIntervalMs(),
    };
    cachedDefaultWeather = snapshot;
    console.log(
      `[weather] cache refreshed for ${snapshot.weather.location.name} at ${new Date(snapshot.fetchedAt).toISOString()}`,
    );
    return snapshot;
  })().finally(() => {
    refreshInFlight = null;
  });

  return refreshInFlight;
}

export async function getDefaultWeatherSnapshot(): Promise<CachedWeatherSnapshot | null> {
  if (cachedDefaultWeather) {
    if (!isSnapshotFresh(cachedDefaultWeather)) {
      void refreshDefaultWeatherCache().catch((error) => {
        console.warn("Weather background refresh failed:", error);
      });
    }
    return cachedDefaultWeather;
  }

  return refreshDefaultWeatherCache();
}

export async function getDefaultWeatherPromptContext(): Promise<string | undefined> {
  const snapshot = await getDefaultWeatherSnapshot();
  return snapshot?.promptContext;
}

export async function startWeatherRefreshLoop(): Promise<void> {
  if (refreshLoopStarted || isTestEnv()) {
    return;
  }

  if (!canFetchDefaultWeather()) {
    console.warn("[weather] default weather refresh disabled: missing API key or default location");
    return;
  }

  refreshLoopStarted = true;
  console.log(`[weather] starting refresh loop (${Math.round(getRefreshIntervalMs() / 60000)} min interval)`);

  try {
    await refreshDefaultWeatherCache();
  } catch (error) {
    console.warn("Initial weather fetch failed:", error);
  }

  refreshTimer = setInterval(() => {
    void refreshDefaultWeatherCache().catch((error) => {
      console.warn("Scheduled weather refresh failed:", error);
    });
  }, getRefreshIntervalMs());

  refreshTimer.unref?.();
}

export function stopWeatherRefreshLoop(): void {
  if (refreshTimer) {
    clearInterval(refreshTimer);
    refreshTimer = null;
  }
  refreshLoopStarted = false;
  refreshInFlight = null;
}

export function resetWeatherCacheForTests(): void {
  stopWeatherRefreshLoop();
  cachedDefaultWeather = null;
}
