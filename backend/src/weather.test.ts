import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  buildWeatherPromptContext,
  getDefaultWeatherPromptContext,
  getCurrentWeather,
  resetWeatherCacheForTests,
  WeatherInputError,
} from "./weather.js";

describe("weather service", () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    process.env.OPENWEATHER_API_KEY = "test-key";
    delete process.env.OPENWEATHER_DEFAULT_CITY;
    delete process.env.OPENWEATHER_DEFAULT_COUNTRY;
    delete process.env.OPENWEATHER_DEFAULT_LAT;
    delete process.env.OPENWEATHER_DEFAULT_LON;
    process.env.OPENWEATHER_DEFAULT_UNITS = "metric";
    process.env.OPENWEATHER_DEFAULT_LANG = "zh_cn";
  });

  afterEach(() => {
    resetWeatherCacheForTests();
    vi.unstubAllGlobals();
    delete process.env.OPENWEATHER_API_KEY;
    delete process.env.OPENWEATHER_DEFAULT_CITY;
    delete process.env.OPENWEATHER_DEFAULT_COUNTRY;
    delete process.env.OPENWEATHER_DEFAULT_LAT;
    delete process.env.OPENWEATHER_DEFAULT_LON;
    delete process.env.OPENWEATHER_DEFAULT_UNITS;
    delete process.env.OPENWEATHER_DEFAULT_LANG;
    delete process.env.OPENWEATHER_REFRESH_MS;
  });

  it("按城市名调用 geocoding 和当前天气接口", async () => {
    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);

      if (url.includes("/geo/1.0/direct")) {
        return new Response(JSON.stringify([
          { name: "Hong Kong", lat: 22.3193, lon: 114.1694, country: "HK" },
        ]), { status: 200 });
      }

      if (url.includes("/data/2.5/weather")) {
        return new Response(JSON.stringify({
          coord: { lat: 22.3193, lon: 114.1694 },
          weather: [{ id: 800, main: "Clear", description: "晴", icon: "01d" }],
          main: {
            temp: 28.4,
            feels_like: 31.2,
            temp_min: 27.6,
            temp_max: 29.1,
            pressure: 1008,
            humidity: 82,
          },
          wind: { speed: 4.1, deg: 120 },
          visibility: 10000,
          dt: 1_715_000_000,
          timezone: 28_800,
          sys: { country: "HK", sunrise: 1_714_980_000, sunset: 1_715_028_000 },
          name: "Hong Kong",
        }), { status: 200 });
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const result = await getCurrentWeather({ city: "Hong Kong" });

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result.location).toMatchObject({
      name: "Hong Kong",
      country: "HK",
      lat: 22.3193,
      lon: 114.1694,
    });
    expect(result.temperature.unit).toBe("°C");
    expect(result.weather.description).toBe("晴");
    expect(result.wind.unit).toBe("m/s");
  });

  it("缺少位置时抛出输入错误", async () => {
    await expect(getCurrentWeather()).rejects.toBeInstanceOf(WeatherInputError);
  });

  it("默认位置天气会缓存复用", async () => {
    process.env.OPENWEATHER_DEFAULT_CITY = "Panyu,Guangzhou";
    process.env.OPENWEATHER_DEFAULT_COUNTRY = "CN";

    const fetchMock = vi.fn(async (input: URL | RequestInfo) => {
      const url = String(input);

      if (url.includes("/geo/1.0/direct")) {
        return new Response(JSON.stringify([
          { name: "Panyu", lat: 22.937, lon: 113.384, country: "CN" },
        ]), { status: 200 });
      }

      if (url.includes("/data/2.5/weather")) {
        return new Response(JSON.stringify({
          coord: { lat: 22.937, lon: 113.384 },
          weather: [{ id: 801, main: "Clouds", description: "多云", icon: "02d" }],
          main: {
            temp: 29,
            feels_like: 33,
            temp_min: 28,
            temp_max: 30,
            pressure: 1006,
            humidity: 79,
          },
          wind: { speed: 2.8, deg: 150 },
          dt: 1_715_000_100,
          timezone: 28_800,
          sys: { country: "CN" },
          name: "Panyu",
        }), { status: 200 });
      }

      throw new Error(`Unexpected URL: ${url}`);
    });

    vi.stubGlobal("fetch", fetchMock);

    const first = await getDefaultWeatherPromptContext();
    const second = await getDefaultWeatherPromptContext();

    expect(first).toContain("Panyu, CN当前天气多云");
    expect(second).toBe(first);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it("把天气格式化成晨报上下文", () => {
    const summary = buildWeatherPromptContext({
      source: "openweather",
      fetchedAt: Date.now(),
      location: { name: "Hong Kong", country: "HK", lat: 22.3, lon: 114.2 },
      weather: { description: "多云" },
      temperature: { actual: 28, feelsLike: 31, min: 27, max: 29, unit: "°C" },
      wind: { speed: 4.1, unit: "m/s" },
      humidity: 82,
      pressure: 1007,
      precipitation: { rain1h: 1.5, unit: "mm" },
      observedAt: Date.now(),
      timezoneOffset: 28_800,
    });

    expect(summary).toContain("Hong Kong, HK当前天气多云");
    expect(summary).toContain("气温28°C");
    expect(summary).toContain("近1小时降雨1.5 mm");
  });
});
