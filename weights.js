// Live weights panel (#27): the tuning tool.
//
// Edits a copy of the profile — one multiplier per factor group, plus every table value — and
// reports, as you drag, how well the result agrees with the rider's 40 rated blocks: rank
// (Spearman ρ, per tune/test half) and level (does a 2 land in Stressful? #92). The map recolors
// through onChange(profile). "Copy YAML" exports the score section for profiles/moped.yaml.

import { BUCKETS, bucketFor } from "./core/buckets.js";
import { inputsFromTile, scoreInputs } from "./core/score.js";

// Factor groups: which profile entries a multiplier scales, and how to edit them one by one.
const GROUPS = [
  { key: "speed", label: "Speed limit", entries: [["speed_limit_mph", "table", (k) => `${k} mph`]] },
  { key: "lanes", label: "Lanes per direction", entries: [["travel_lanes_per_dir", "table", (k) => (k === "4" ? "4+ lanes" : `${k} lane${k === "1" ? "" : "s"}`)]] },
  { key: "opposing", label: "Lanes coming the other way", entries: [["opposing_lanes", "table", (k) => (k === "4" ? "4+ lanes" : `${k} lane${k === "1" ? "" : "s"}`)]] },
  { key: "lane_width", label: "Lane width", entries: [["lane_width_ft", "bands", (b) => `${b.min}–${b.max} ft${b.only_if_single_lane ? " (single lane)" : ""}`]] },
  { key: "shared_lane", label: "Shared two-way lane", entries: [["shared_lane", "scalar"]] },
  { key: "excess_width", label: "Extra width, one lane each way", entries: [["excess_width_ft", "bands", (b) => `${b.min}+ ft beyond the lanes`]] },
  { key: "bike_lane", label: "Bike lane on your side", entries: [["bike_lane_same_side", "table", (k) => k]] },
  { key: "divided", label: "Divided / median", entries: [["divided", "scalar"]] },
  { key: "trucks", label: "Truck route", entries: [["truck_route", "table", (k) => k]] },
  { key: "bus_route", label: "Bus route", entries: [["bus_route", "scalar"]] },
  { key: "bus_lane", label: "Bus lane on your side", entries: [["bus_lane_same_side", "scalar"]] },
  { key: "volume", label: "Traffic volume", entries: [["aadt", "bands", (b) => `${(b.min / 1000).toFixed(0)}k–${b.max >= 1e6 ? "∞" : `${(b.max / 1000).toFixed(0)}k`}`]] },
  { key: "crashes", label: "Crash density", entries: [["crash_percentile", "bands", (b) => `≥ ${b.min}th percentile`]] },
  { key: "surface", label: "Surface & tracks", entries: [["surface", "table", (k) => k], ["tracks", "scalar"]] },
  { key: "pavement", label: "Pavement", entries: [["pavement_rating", "table", (k) => k]] },
];

const clone = (o) => JSON.parse(JSON.stringify(o));

export function applyMultipliers(profile, mult) {
  const p = clone(profile);
  for (const g of GROUPS) {
    const m = mult[g.key] ?? 1;
    if (m === 1) continue;
    for (const [name, kind] of g.entries) {
      const s = p.score;
      // "+ 0" turns -0 (from × 0) into 0
      if (s[name] == null) continue; // factor absent from this profile
      if (kind === "scalar") s[name] = s[name] * m + 0;
      else if (kind === "table") for (const k of Object.keys(s[name])) s[name][k] = s[name][k] * m + 0;
      else for (const b of s[name]) b.points = b.points * m + 0;
    }
  }
  return p;
}

// --- agreement with the rider ---------------------------------------------------------------

function ranks(xs) {
  const idx = xs.map((v, i) => [v, i]).sort((a, b) => a[0] - b[0]);
  const r = new Array(xs.length);
  for (let i = 0; i < idx.length; ) {
    let j = i;
    while (j + 1 < idx.length && idx[j + 1][0] === idx[i][0]) j++;
    for (let k = i; k <= j; k++) r[idx[k][1]] = (i + j) / 2 + 1; // average rank for ties
    i = j + 1;
  }
  return r;
}

export function spearman(a, b) {
  const ra = ranks(a), rb = ranks(b);
  const n = a.length, ma = ra.reduce((s, v) => s + v, 0) / n, mb = rb.reduce((s, v) => s + v, 0) / n;
  let num = 0, da = 0, db = 0;
  for (let i = 0; i < n; i++) {
    num += (ra[i] - ma) * (rb[i] - mb);
    da += (ra[i] - ma) ** 2;
    db += (rb[i] - mb) ** 2;
  }
  return da && db ? num / Math.sqrt(da * db) : NaN;
}

// Mirror of bucket_off() in pipeline/levels.py: a half rating (4.5) matches either neighbour.
export function bucketOff(predicted, rating) {
  const lo = Math.floor(6 - rating), hi = Math.ceil(6 - rating);
  return predicted < lo ? predicted - lo : predicted > hi ? predicted - hi : 0;
}

export function agreement(ratings, profile, cls = "B") {
  const rows = ratings.map((r) => {
    const s = scoreInputs(inputsFromTile(r.props, r.dir), cls, profile);
    const predicted = bucketFor(s.score).bucket; // 1 Calm … 5 Avoid
    const expected = 6 - r.rating; // rating 5 ↔ Calm (bucket 1) … rating 1 ↔ Avoid (bucket 5)
    return { ...r, score: s.score, raw: s.raw, predicted, expected, off: bucketOff(predicted, r.rating) };
  });
  const rho = (split) => {
    const x = split ? rows.filter((r) => r.split === split) : rows;
    return spearman(x.map((r) => r.rating), x.map((r) => r.score));
  };
  return {
    rows,
    rhoTune: rho("tune"),
    rhoTest: rho("test"),
    rhoAll: rho(null),
    exact: rows.filter((r) => r.off === 0).length / rows.length,
    within1: rows.filter((r) => Math.abs(r.off) <= 1).length / rows.length,
    meanAbs: rows.reduce((s, r) => s + Math.abs(r.off), 0) / rows.length,
    bias: rows.reduce((s, r) => s + r.off, 0) / rows.length, // + = harsher than the rider (#92)
  };
}

function sheetCounts(rows) {
  const n = {};
  for (const r of rows) n[r.sheet ?? "g5"] = (n[r.sheet ?? "g5"] ?? 0) + 1;
  return Object.entries(n).map(([k, v]) => `${k} ${v}`).join(", ");
}

// --- YAML export ----------------------------------------------------------------------------

const num = (v) => (Number.isInteger(v) ? String(v) : String(Math.round(v * 10) / 10));

export function scoreYaml(profile, note) {
  const s = profile.score;
  const out = [`# ${note}`, "score:", `  start: ${s.start}`, `  clamp: [${s.clamp.join(", ")}]`, ""];
  const table = (name) => {
    out.push(`  ${name}:`);
    for (const [k, v] of Object.entries(s[name])) out.push(`    ${k}: ${num(v)}`);
  };
  const bands = (name) => {
    out.push(`  ${name}:`);
    for (const b of s[name]) {
      const parts = Object.entries(b).map(([k, v]) => `${k}: ${typeof v === "number" ? num(v) : v}`);
      out.push(`    - {${parts.join(", ")}}`);
    }
  };
  table("speed_limit_mph");
  table("travel_lanes_per_dir");
  if (s.opposing_lanes) table("opposing_lanes");
  bands("lane_width_ft");
  if (s.shared_lane != null) out.push(`  shared_lane: ${num(s.shared_lane)}`);
  if (s.excess_width_ft) {
    bands("excess_width_ft");
    const r = s.excess_width_rule;
    out.push(`  excess_width_rule: {lane_ft: ${num(r.lane_ft)}, parking_ft: ${num(r.parking_ft)}, max_lanes_per_dir: ${num(r.max_lanes_per_dir)}}`);
  }
  table("bike_lane_same_side");
  out.push(`  divided: ${num(s.divided)}`);
  table("truck_route");
  out.push(`  bus_route: ${num(s.bus_route)}`, `  bus_lane_same_side: ${num(s.bus_lane_same_side)}`);
  bands("aadt");
  out.push(`  aadt_inferred_multiplier: ${num(s.aadt_inferred_multiplier)}`);
  bands("crash_percentile");
  table("surface");
  out.push(`  tracks: ${num(s.tracks)}`);
  table("pavement_rating");
  return out.join("\n") + "\n";
}

// --- the panel ------------------------------------------------------------------------------

export class WeightsPanel {
  constructor(el, { profile, ratings, onChange, getClass }) {
    this.el = el;
    this.base = clone(profile);
    this.edited = clone(profile);
    this.mult = Object.fromEntries(GROUPS.map((g) => [g.key, 1]));
    this.ratings = ratings ?? [];
    this.onChange = onChange;
    this.getClass = getClass;
    this.render();
  }

  effective() {
    return applyMultipliers(this.edited, this.mult);
  }

  changed() {
    clearTimeout(this.t);
    this.t = setTimeout(() => {
      const p = this.effective();
      this.onChange(p);
      this.renderAgreement(p);
    }, 120);
  }

  reset() {
    this.edited = clone(this.base);
    this.mult = Object.fromEntries(GROUPS.map((g) => [g.key, 1]));
    this.render();
    this.changed();
  }

  render() {
    const s = this.edited.score;
    const groups = GROUPS.map((g) => {
      const values = g.entries
        .map(([name, kind, label]) => {
          if (kind === "scalar")
            return this.valueRow(`${name}`, name.replace(/_/g, " "), s[name], [name]);
          if (s[name] == null) return "";
          if (kind === "table")
            return Object.entries(s[name]).map(([k, v]) => this.valueRow(`${name}.${k}`, label(k), v, [name, k])).join("");
          return s[name].map((b, i) => this.valueRow(`${name}.${i}`, label(b), b.points, [name, i, "points"])).join("");
        })
        .join("");
      return `<div class="grp">
        <label class="mult"><span>${g.label}</span>
          <input type="range" min="0" max="2" step="0.1" value="${this.mult[g.key]}" data-mult="${g.key}">
          <output>×${this.mult[g.key].toFixed(1)}</output></label>
        <details><summary>values</summary>${values}</details></div>`;
    }).join("");
    this.el.innerHTML = `
      <div class="wp-head"><b>Tune weights</b><button class="close" aria-label="Close">×</button></div>
      <div id="wp-agree" class="agree"></div>
      <div class="wp-groups">${groups}</div>
      <div class="wp-actions">
        <button data-act="reset">Reset</button>
        <button data-act="copy">Copy YAML</button>
        <button data-act="download">Download</button>
      </div>
      <div class="hint">Multipliers scale a whole factor; "values" edits single entries. The map,
        the inspector and the agreement update as you drag (Class ${this.getClass()}).</div>`;
    this.el.querySelector(".close").onclick = () => (this.el.hidden = true);
    for (const r of this.el.querySelectorAll("input[data-mult]")) {
      r.addEventListener("input", () => {
        this.mult[r.dataset.mult] = Number(r.value);
        r.nextElementSibling.value = `×${Number(r.value).toFixed(1)}`;
        this.changed();
      });
    }
    for (const r of this.el.querySelectorAll("input[data-path]")) {
      r.addEventListener("input", () => {
        const path = JSON.parse(r.dataset.path);
        let o = this.edited.score;
        for (const k of path.slice(0, -1)) o = o[k];
        o[path[path.length - 1]] = Number(r.value);
        r.nextElementSibling.value = r.value;
        this.changed();
      });
    }
    this.el.querySelector('[data-act="reset"]').onclick = () => this.reset();
    this.el.querySelector('[data-act="copy"]').onclick = () => this.copyYaml();
    this.el.querySelector('[data-act="download"]').onclick = () => this.downloadYaml();
    this.renderAgreement(this.effective());
  }

  valueRow(id, label, value, path) {
    return `<label class="val"><span>${label}</span>
      <input type="range" min="-120" max="20" step="1" value="${value}" data-path='${JSON.stringify(path)}'>
      <output>${num(value)}</output></label>`;
  }

  renderAgreement(profile) {
    const box = this.el.querySelector("#wp-agree");
    if (!box) return;
    if (!this.ratings.length) {
      box.textContent = "No ratings loaded (reports/*ratings*.csv → export).";
      return;
    }
    const a = agreement(this.ratings, profile, "B");
    const f = (v) => (Number.isNaN(v) ? "–" : v.toFixed(2));
    const misses = a.rows
      .filter((r) => Math.abs(r.off) >= 2)
      .sort((x, y) => Math.abs(y.off) - Math.abs(x.off))
      .slice(0, 6)
      .map((r) => `<li>${r.street} · rated ${r.rating}, scores ${r.score}${r.raw < 0 ? ` (raw ${r.raw})` : ""} — ${BUCKETS[r.predicted - 1].label}</li>`)
      .join("");
    box.innerHTML = `
      <div class="metrics">
        <div><span>ρ tune</span><b>${f(a.rhoTune)}</b></div>
        <div><span>ρ test</span><b>${f(a.rhoTest)}</b></div>
        <div><span>ρ all</span><b>${f(a.rhoAll)}</b></div>
        <div><span>bucket exact</span><b>${Math.round(a.exact * 100)}%</b></div>
        <div><span>within 1</span><b>${Math.round(a.within1 * 100)}%</b></div>
        <div><span>bias</span><b>${a.bias >= 0 ? "+" : ""}${f(a.bias)}</b></div>
      </div>
      <div class="hint">Your ${a.rows.length} rated blocks (${sheetCounts(a.rows)}), Class B. ρ tune/test = the G5 halves; ρ all = every sheet. Bucket = level (rating 5 ↔ Calm … 1 ↔ Avoid); bias + = harsher than you.</div>
      ${misses ? `<details><summary>Biggest misses</summary><ul>${misses}</ul></details>` : ""}`;
  }

  yaml() {
    const changed = GROUPS.filter((g) => this.mult[g.key] !== 1).map((g) => `${g.key} ×${this.mult[g.key]}`);
    const note = `From the weights panel ${new Date().toISOString().slice(0, 10)}, base profile v${this.base.version}${changed.length ? ` with ${changed.join(", ")}` : ""}`;
    return scoreYaml(this.effective(), note);
  }

  async copyYaml() {
    try {
      await navigator.clipboard.writeText(this.yaml());
      this.flash("Copied");
    } catch {
      this.downloadYaml();
    }
  }

  downloadYaml() {
    const url = URL.createObjectURL(new Blob([this.yaml()], { type: "text/yaml" }));
    Object.assign(document.createElement("a"), { href: url, download: "moped-score.yaml" }).click();
    URL.revokeObjectURL(url);
  }

  flash(text) {
    const b = this.el.querySelector('[data-act="copy"]');
    const old = b.textContent;
    b.textContent = text;
    setTimeout(() => (b.textContent = old), 1200);
  }
}
