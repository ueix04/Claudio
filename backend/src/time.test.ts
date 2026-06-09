import { afterEach, describe, expect, it } from "vitest";
import { formatStationTimeOfDay, getStationHour, getStationTimeZone } from "./time.js";

describe("station time", () => {
  const originalTimeZone = process.env.CLAUDIO_TIME_ZONE;

  afterEach(() => {
    if (originalTimeZone === undefined) {
      delete process.env.CLAUDIO_TIME_ZONE;
    } else {
      process.env.CLAUDIO_TIME_ZONE = originalTimeZone;
    }
  });

  it("formats DJ prompt time in the station timezone by default", () => {
    delete process.env.CLAUDIO_TIME_ZONE;
    const utcAfternoon = new Date("2026-06-09T17:04:59.000Z");

    expect(getStationTimeZone()).toBe("Asia/Hong_Kong");
    expect(formatStationTimeOfDay(utcAfternoon)).toBe("01:04");
    expect(getStationHour(utcAfternoon)).toBe(1);
  });

  it("allows an explicit station timezone override", () => {
    process.env.CLAUDIO_TIME_ZONE = "UTC";
    const utcAfternoon = new Date("2026-06-09T17:04:59.000Z");

    expect(getStationTimeZone()).toBe("UTC");
    expect(formatStationTimeOfDay(utcAfternoon)).toBe("17:04");
    expect(getStationHour(utcAfternoon)).toBe(17);
  });

  it("falls back to the station timezone for invalid values", () => {
    process.env.CLAUDIO_TIME_ZONE = "not-a-timezone";

    expect(getStationTimeZone()).toBe("Asia/Hong_Kong");
  });
});
