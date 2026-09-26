/**
 * The cutting up of days, in the dashboard's time zone.
 *
 * Everything this service returns is grouped by day, and a day only exists in
 * a time zone: `Date` knows only two, the machine's and UTC, neither of which
 * is the one we want. The VM runs in UTC, the measured sites are French, and
 * the gap of one or two hours would move every evening onto the next day.
 *
 * Pure: everything receives its instant and its time zone, nothing reads the
 * clock.
 */

/**
 * The day of an instant, as `AAAA-MM-JJ`.
 *
 * `en-CA` returns exactly that form, and it is the only locale to do so without
 * a detour; `fr-FR` would return `20/09/2026`, which does not sort. The parts
 * are read back rather than the string recomposed: a locale is not a contract.
 */
export function dayOf(instant: number, timeZone: string): string {
  const format = new Intl.DateTimeFormat("en-CA", {
    timeZone: timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  });

  const parts = new Map(format.formatToParts(new Date(instant)).map((p) => [p.type, p.value]));
  return `${parts.get("year")}-${parts.get("month")}-${parts.get("day")}`;
}

/** True for a string of the form `AAAA-MM-JJ`, and for it alone. */
export function isValidDay(day: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return false;

  // The pattern lets through 30 February, which the reconstruction shifts to 2
  // March, and the thirteenth month, out of which it makes no date at all. The
  // second case is tested before reformatting: `toISOString` of an invalid date
  // does not return a string, it throws.
  const date = toUTC(day);
  if (Number.isNaN(date.getTime())) return false;
  return date.toISOString().slice(0, 10) === day;
}

/**
 * The day, seen as a UTC instant at noon.
 *
 * Noon and not midnight: the arithmetic on days is then done in milliseconds,
 * and starting from the middle of the day leaves twelve hours of margin on
 * each side. No time zone offset, no switch to summer time then changes the
 * date.
 */
function toUTC(day: string): Date {
  return new Date(`${day}T12:00:00.000Z`);
}

/** The day `n` days before this one (or after, if `n` is negative). */
export function minusDays(day: string, n: number): string {
  const instant = toUTC(day).getTime() - n * 24 * 60 * 60 * 1000;
  return new Date(instant).toISOString().slice(0, 10);
}

/**
 * The `n` days ending at `day`, from the oldest to the most recent.
 *
 * Returned in full, gaps included: a curve must show the days without a visit,
 * and the database carries a row only for those that had one.
 */
export function dayWindow(day: string, n: number): string[] {
  const days: string[] = [];
  for (let i = n - 1; i >= 0; i--) days.push(minusDays(day, i));
  return days;
}
