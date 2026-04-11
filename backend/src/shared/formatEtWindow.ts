/** US Eastern for Polymarket-style window labels. */
const TZ = "America/New_York";

function part(
  tMs: number,
  opts: Intl.DateTimeFormatOptions
): Intl.DateTimeFormatPart[] {
  return new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...opts }).formatToParts(
    new Date(tMs)
  );
}

function getPart(parts: Intl.DateTimeFormatPart[], type: Intl.DateTimeFormatPart["type"]): string {
  return parts.find((p) => p.type === type)?.value ?? "";
}

/** e.g. "2026 - April 7, 4:00AM-4:05AM ET" (unix seconds). */
export function formatWindowRangeEt(startTsSec: number, endTsSec: number): string {
  const a = startTsSec * 1000;
  const b = endTsSec * 1000;
  const yearParts = part(a, { year: "numeric" });
  const year = getPart(yearParts, "year");

  const mdOpts: Intl.DateTimeFormatOptions = { month: "long", day: "numeric" };
  const startMd = new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...mdOpts }).format(
    new Date(a)
  );
  const endMd = new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...mdOpts }).format(
    new Date(b)
  );

  const hmOpts: Intl.DateTimeFormatOptions = {
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
  };
  const startHm = new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...hmOpts })
    .format(new Date(a))
    .replace(/\s+/g, "");
  const endHm = new Intl.DateTimeFormat("en-US", { timeZone: TZ, ...hmOpts })
    .format(new Date(b))
    .replace(/\s+/g, "");

  if (startMd === endMd) {
    return `${year} - ${startMd}, ${startHm}-${endHm} ET`;
  }
  return `${year} - ${startMd}, ${startHm} - ${endMd}, ${endHm} ET`;
}

/** Safe file stem: BTC-5m-2026-04-07_0400-0405-ET (times in ET, 24h in name for sort). */
export function formatScreenshotFileStem(
  symbol: string,
  timeframe: string,
  startTsSec: number,
  endTsSec: number
): string {
  const fmt = (tMs: number) => {
    const p = new Intl.DateTimeFormat("en-US", {
      timeZone: TZ,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
      hour: "2-digit",
      minute: "2-digit",
      hour12: false,
    }).formatToParts(new Date(tMs));
    const g = (ty: Intl.DateTimeFormatPart["type"]) => p.find((x) => x.type === ty)?.value ?? "";
    const y = g("year");
    const m = g("month");
    const d = g("day");
    const h = g("hour");
    const min = g("minute");
    return { y, m, d, h, min };
  };
  const s = fmt(startTsSec * 1000);
  const e = fmt(endTsSec * 1000);
  const datePart = `${s.y}-${s.m}-${s.d}`;
  const startClock = `${s.h}${s.min}`;
  const endClock = `${e.h}${e.min}`;
  const raw = `${symbol}-${timeframe}-${datePart}_${startClock}-${endClock}-ET`;
  return raw.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/-+/g, "-");
}
