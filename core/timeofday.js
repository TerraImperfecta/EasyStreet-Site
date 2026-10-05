// Time of day (#51, D-038). Where a part-time bus lane or busway applies, a tile carries per
// direction `ts{f,r}` — its weekly schedule as 168 "0"/"1" hours from Monday 00:00, New York
// time — and `o{A,B,C}{f,r}`, the score outside it (absent: not legal then either). Outside the
// schedule the bus lane is the right-hand lane (D-015) or the busway an ordinary street.

import { scoreProps } from "./buckets.js";

const WEEKDAY = { Mon: 0, Tue: 1, Wed: 2, Thu: 3, Fri: 4, Sat: 5, Sun: 6 };

/** Hour of the week (0 = Monday 00:00–01:00) in New York for a Date. */
export function hourOfWeek(date = new Date()) {
  const parts = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/New_York",
    weekday: "short",
    hour: "numeric",
    hourCycle: "h23",
  }).formatToParts(date);
  const get = (type) => parts.find((p) => p.type === type).value;
  return WEEKDAY[get("weekday")] * 24 + (Number(get("hour")) % 24);
}

/** Is this direction's part-time restriction out of force at hour `h`? (null h: always in force) */
export function offHours(t, dir, h) {
  const bits = t[`ts${dir}`];
  return h != null && typeof bits === "string" && bits[h] === "0";
}

/** The score that applies at hour `h` for a class and direction, or null if not legal then. */
export function scoreAt(t, cls, dir, h) {
  const key = offHours(t, dir, h) ? `o${cls}${dir}` : scoreProps(cls)[dir === "f" ? "fwd" : "rev"];
  return t[key] ?? null;
}

/** MapLibre expression for one direction's score at hour `h` (null: ignore schedules). */
export function dirScoreExpr(cls, dir, h, missing) {
  const base = ["coalesce", ["get", `s${cls}${dir}`], missing];
  if (h == null) return base;
  const ts = `ts${dir}`;
  return [
    "case",
    ["all", ["has", ts], ["==", ["slice", ["get", ts], h, h + 1], "0"]],
    ["coalesce", ["get", `o${cls}${dir}`], missing],
    base,
  ];
}

/** "7AM–10AM / 4PM–7PM weekdays"-style text is in the tile's hours note; this says whether now. */
export function restrictionNow(t, dir, h) {
  if (typeof t[`ts${dir}`] !== "string") return null;
  return offHours(t, dir, h) ? "off" : "on";
}
