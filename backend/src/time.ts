const DEFAULT_STATION_TIME_ZONE = "Asia/Hong_Kong";

export function getStationTimeZone(): string {
  const configured = process.env.CLAUDIO_TIME_ZONE?.trim();
  if (!configured) return DEFAULT_STATION_TIME_ZONE;

  try {
    new Intl.DateTimeFormat("en-US", { timeZone: configured }).format(new Date(0));
    return configured;
  } catch {
    return DEFAULT_STATION_TIME_ZONE;
  }
}

function getStationTimeParts(date: Date = new Date()): { hour: string; minute: string } {
  const parts = new Intl.DateTimeFormat("en-GB", {
    timeZone: getStationTimeZone(),
    hour: "2-digit",
    minute: "2-digit",
    hourCycle: "h23",
  }).formatToParts(date);

  const hour = parts.find((part) => part.type === "hour")?.value ?? "00";
  const minute = parts.find((part) => part.type === "minute")?.value ?? "00";

  return { hour, minute };
}

export function formatStationTimeOfDay(date: Date = new Date()): string {
  const { hour, minute } = getStationTimeParts(date);
  return `${hour}:${minute}`;
}

export function getStationHour(date: Date = new Date()): number {
  const hour = Number(getStationTimeParts(date).hour);
  return Number.isFinite(hour) ? hour : 0;
}
