import { describe, expect, it } from "vitest";
import {
  buildHostStyleGuide,
  buildSegueDirective,
  getDayPart,
  inferSegueKind,
  inferWeatherTone,
} from "./radio-style.js";

describe("radio-style", () => {
  it("derives day part from clock time", () => {
    expect(getDayPart("02:15")).toBe("late_night");
    expect(getDayPart("09:20")).toBe("morning");
    expect(getDayPart("15:30")).toBe("afternoon");
    expect(getDayPart("21:05")).toBe("evening");
  });

  it("infers weather tone from weather context", () => {
    expect(inferWeatherTone("广州小雨，22°C")).toBe("rainy");
    expect(inferWeatherTone("Shiqiao当前天气多云，气温25°C")).toBe("cloudy");
    expect(inferWeatherTone("香港当前天气晴，气温28°C")).toBe("sunny");
  });

  it("selects host style from time and weather", () => {
    expect(buildHostStyleGuide("08:30", "香港当前天气晴，气温28°C")).toContain("清透晨间型");
    expect(buildHostStyleGuide("02:10", "广州小雨，22°C")).toContain("深夜陪伴型");
    expect(buildHostStyleGuide("23:10", "广州小雨，22°C")).toContain("夜雨电台型");
    expect(buildHostStyleGuide("23:10", "广州小雨，22°C", "en")).toContain("rainy-night radio");
  });

  it("selects segue kind from program stage and atmosphere", () => {
    expect(inferSegueKind({
      timeOfDay: "02:10",
      weatherContext: "广州小雨，22°C",
      queueLength: 4,
      nextIndex: 1,
    })).toBe("night_companion");

    expect(inferSegueKind({
      timeOfDay: "15:20",
      weatherContext: "Shiqiao当前天气多云，气温25°C",
      queueLength: 4,
      nextIndex: 3,
    })).toBe("landing");

    expect(buildSegueDirective("settle")).toContain("降温");
    expect(buildSegueDirective("settle", "en")).toContain("Segue type: settle");
  });
});
