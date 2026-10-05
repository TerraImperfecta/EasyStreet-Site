// Rating sheets in the browser (#100): parse a reports/ratings-<region>.csv, keep answers, and
// write the same columns back so `python -m pipeline.rating_sheet --evaluate` reads it unchanged.
// Pure functions; web/rating.js is the UI.

/** RFC 4180 CSV → array of row objects keyed by the header. */
export function parseCSV(text) {
  const rows = [];
  let field = "";
  let row = [];
  let quoted = false;
  const src = text.replace(/^﻿/, "");
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (quoted) {
      if (c === '"' && src[i + 1] === '"') { field += '"'; i++; }
      else if (c === '"') quoted = false;
      else field += c;
    } else if (c === '"') quoted = true;
    else if (c === ",") { row.push(field); field = ""; }
    else if (c === "\n" || c === "\r") {
      if (c === "\r" && src[i + 1] === "\n") i++;
      row.push(field); field = "";
      if (row.some((v) => v !== "")) rows.push(row);
      row = [];
    } else field += c;
  }
  if (field !== "" || row.length) { row.push(field); if (row.some((v) => v !== "")) rows.push(row); }
  const [header, ...body] = rows;
  if (!header) return { columns: [], rows: [] };
  return { columns: header, rows: body.map((r) => Object.fromEntries(header.map((h, i) => [h, r[i] ?? ""]))) };
}

const cell = (v) => {
  const s = String(v ?? "");
  return /[",\n\r]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
};

/** Back to CSV with the original columns, in their order. */
export function toCSV({ columns, rows }) {
  return [columns.map(cell).join(","), ...rows.map((r) => columns.map((c) => cell(r[c])).join(","))].join("\n") + "\n";
}

export const REQUIRED = ["id", "seg_id", "direction", "streetview", "rating"];

/** Missing columns, if any: a sheet needs these to be rated here. */
export function missingColumns(columns) {
  return REQUIRED.filter((c) => !columns.includes(c));
}

/** Where the block is: the `map` link's query=lat,lng, else Street View's viewpoint. */
export function location(row) {
  for (const [col, re] of [["map", /query=(-?[\d.]+),(-?[\d.]+)/], ["streetview", /viewpoint=(-?[\d.]+),(-?[\d.]+)/]]) {
    const m = re.exec(row[col] ?? "");
    if (m) return { lat: Number(m[1]), lng: Number(m[2]) };
  }
  return null;
}

/** A valid rating: 1–5 in halves ("4.5"). */
export function validRating(v) {
  const n = Number(v);
  return v !== "" && Number.isFinite(n) && n >= 1 && n <= 5 && Number.isInteger(n * 2);
}

export function progress(rows) {
  return { done: rows.filter((r) => validRating(r.rating)).length, total: rows.length };
}

/** localStorage key for one sheet's answers, by its block list (so two sheets never collide). */
export function storageKey(rows) {
  return `easystreet.rating.${rows.map((r) => `${r.seg_id}:${r.direction}`).join("|")}`;
}
