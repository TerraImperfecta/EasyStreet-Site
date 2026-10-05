// Segment inspector (#26): click a street to see why it scores what it scores.
//
// Recomputes the breakdown in the browser with web/core/score.js from the tile's raw attributes
// and the profile (web/data/moped.json), and checks it against the pipeline's precomputed score.

import { BUCKETS, NOT_ALLOWED, bucketFor } from "./core/buckets.js";
import { hourOfWeek, restrictionNow } from "./core/timeofday.js";
import { excessWidth, inputsFromTile, scoreInputs } from "./core/score.js";

const REASONS = {
  wrong_way: "Against a one-way street",
  no_vehicles: "Not open to vehicles",
  "feature:highway": "Highway — mopeds aren't allowed",
  "feature:ramp": "Highway ramp — mopeds aren't allowed",
  "feature:tunnel": "Tunnel — not verified for mopeds",
  "feature:path": "Path or greenway — not for mopeds",
  "feature:park_drive": "Car-free park drive — closed to motor vehicles, mopeds included (Parks rule §1-05)",
  "feature:busway": "Busway — through traffic restricted",
  "bridge:not_allowed": "Bridge closed to mopeds — the Manhattan or Williamsburg Bridge or the Queensboro upper roadway (§4-07), or a highway crossing",
  "crossing:mta_not_allowed": "MTA bridge or tunnel — mopeds aren't allowed (21 NYCRR §1022.1)",
  "crossing:port_authority": "Port Authority crossing to New Jersey — outside the map",
  "bridge:lower_level_unverified": "Bridge level not identified yet — excluded until verified",
  "unverified:other": "Private or unverified street",
  "osm:car_free": "Car-free (OpenStreetMap)",
  "osm:private": "Private road (OpenStreetMap)",
  "osm:motorway": "Highway (OpenStreetMap motorway)",
};

const CLASS_NOTES = {
  A: "Class A: lane penalties and the 30 mph penalty × 0.6 (can use any lane).",
  B: "",
  C: "Class C: speed penalties × 1.4 (top speed 20 mph).",
};

const titleCase = (s) => (s ?? "").toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
const esc = (s) => String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

function factorLabel(key, t, profile) {
  switch (key) {
    case "speed_limit_mph":
      return `${t.spd} mph speed limit`;
    case "travel_lanes_per_dir":
      return t.dir === "two_way" ? `${t.lpd} lanes each way` : `${t.lpd} travel lanes`;
    case "opposing_lanes": {
      const n = t.dir === "two_way" ? (t.lt ?? 0) - (t.lpd ?? 0) : t.lpd;
      return `${n} lane${n === 1 ? "" : "s"} coming the other way${t.dir === "two_way" ? "" : " (divided street)"}`;
    }
    case "lane_width_ft":
      return `~${t.lw} ft lanes (estimate)`;
    case "shared_lane":
      return "Two-way on one shared lane — oncoming cars squeeze past";
    case "excess_width_ft": {
      const xw = excessWidth(t.sw, t.lt, t.pk, profile.score.excess_width_rule);
      return `${t.sw} ft wide — ${Math.round(xw)} ft more than its lane and parking need`;
    }
    case "bike_lane":
      return "Bike lane on your side";
    case "divided":
      return "Divided with a median";
    case "truck_route":
      return `${titleCase(t.trk)} truck route`;
    case "bus_route":
      return "Bus route";
    case "bus_lane":
      return "Bus lane on your side — you ride beside it";
    case "aadt":
      return `~${Number(t.vol).toLocaleString()} vehicles/day (${t.volc === "low" ? "estimated" : "counted"})`;
    case "crash":
      return `Crash density in the top ${t.crp >= 90 ? "10" : "25"}% citywide`;
    case "surface":
      return `${titleCase(t.srf)} surface`;
    case "tracks":
      return "Rail tracks in the roadway";
    case "pavement":
      return `${titleCase(t.pav)} pavement`;
    default:
      return key.replace(/_/g, " ");
  }
}

// Stop signs and signals from OSM (#83). Shown, not scored (D-023); unmapped ≠ absent.
function controlText(t) {
  const parts = [];
  if (t.sne) parts.push(`stop-controlled ${t.sne === 2 ? "at both ends" : "at one end"}`);
  if (t.sge) parts.push(`signal ${t.sge === 2 ? "at both ends" : "at one end"}`);
  return parts.join(" · ") || "none mapped";
}

function compass(bearing) {
  const names = ["northbound", "northeast", "eastbound", "southeast", "southbound", "southwest", "westbound", "northwest"];
  return names[Math.round((((bearing % 360) + 360) % 360) / 45) % 8];
}

function bearingOf(coords) {
  const [a, b] = [coords[0], coords[coords.length - 1]];
  const r = Math.PI / 180;
  const y = Math.sin((b[0] - a[0]) * r) * Math.cos(b[1] * r);
  const x = Math.cos(a[1] * r) * Math.sin(b[1] * r) - Math.sin(a[1] * r) * Math.cos(b[1] * r) * Math.cos((b[0] - a[0]) * r);
  return (Math.atan2(y, x) / r + 360) % 360;
}

function lineCoords(geometry) {
  return geometry.type === "MultiLineString" ? geometry.coordinates.flat() : geometry.coordinates;
}

function streetView(lat, lng, heading) {
  return `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${lat.toFixed(6)},${lng.toFixed(6)}&heading=${Math.round(heading)}`;
}

export class Inspector {
  constructor(el, { profile, info }) {
    this.el = el;
    this.profile = profile;
    this.info = info;
  }

  close() {
    this.el.hidden = true;
  }

  show(feature, cls) {
    const t = feature.properties;
    const coords = lineCoords(feature.geometry);
    const mid = coords[Math.floor(coords.length / 2)];
    const fwdBearing = bearingOf(coords);
    const dirs = [
      { key: "f", label: compass(fwdBearing), heading: fwdBearing, legal: !!t.lgf, reason: t.rsf, stop: !!t.spf },
      { key: "r", label: compass(fwdBearing + 180), heading: (fwdBearing + 180) % 360, legal: !!t.lgr, reason: t.rsr, stop: !!t.spr },
    ];
    // A two-way street with the same verdict both ways reads better as one block.
    const sections = dirs.map((d) => this.direction(t, d, cls, mid));

    const facts = [
      ["Speed limit", t.spd != null ? `${t.spd} mph` : "unknown"],
      ["Travel lanes", t.lt != null ? `${t.lt} total${t.dir === "two_way" ? ` (${t.lpd} each way)` : ", one-way"}` : "unknown"],
      ["Street width", t.sw != null ? `${t.sw} ft curb to curb${t.pk != null ? ` · ${t.pk} parking lane${t.pk === 1 ? "" : "s"}` : ""}` : "unknown"],
      ["Lane width", t.lw != null ? `~${t.lw} ft · ${t.lwc} confidence${t.yld ? " · yield street" : ""}` : "unknown"],
      ["Bike lane", `${t.bkf ?? "none"} / ${t.bkr ?? "none"}`],
      ["Buses", [t.bwy && "busway", t.buf && "bus lane", t.bur && "bus lane (other way)", t.bus && "bus route"].filter(Boolean).join(" · ") || "none"],
      ["Truck route", t.trk ?? "none"],
      ["Traffic", t.vol != null ? `~${Number(t.vol).toLocaleString()}/day (${t.volc === "low" ? "estimated from road type" : "DOT count"})` : "unknown"],
      ["Crashes", t.crp != null ? `${t.crp}th percentile citywide` : "none recorded"],
      ["Traffic control", controlText(t)],
      ["Pavement", t.pav ?? "unknown"],
      ["Surface", t.srf ?? "unknown"],
    ];
    if (t.con) facts.push(["Construction", t.cnn ?? "active street closure"]);
    if (t.oss) facts.push([t.oss === "now" ? "Open Street" : "Open Street (last season)", t.osn ?? ""]);

    const src = this.info?.sources ?? {};
    const lion = src.lion ? `LION ${src.lion.release ?? ""} (${src.lion.fetched})` : "LION";
    const crashes = src.crashes?.window ? `crashes ${src.crashes.window[0]} – ${src.crashes.window[1]}` : "";
    this.el.innerHTML = `
      <button class="close" aria-label="Close">×</button>
      <h2>${esc(titleCase(t.name))}</h2>
      <div class="sub">${esc(titleCase(t.feat))} · ${t.dir === "two_way" ? "two-way" : t.dir === "none" ? "no vehicles" : "one-way"} · Class ${cls}</div>
      ${sections.join("")}
      ${CLASS_NOTES[cls] ? `<div class="note">${CLASS_NOTES[cls]}</div>` : ""}
      <h3>The street</h3>
      <table class="facts">${facts.map(([k, v]) => `<tr><td>${k}</td><td>${esc(v)}</td></tr>`).join("")}</table>
      <div class="links">
        <a href="https://www.openstreetmap.org/?mlat=${mid[1].toFixed(6)}&mlon=${mid[0].toFixed(6)}#map=18/${mid[1].toFixed(6)}/${mid[0].toFixed(6)}" target="_blank" rel="noopener">OpenStreetMap</a>
        <span class="muted">· segment ${esc(t.id)}</span>
      </div>
      <div class="sources">Data: ${esc(lion)} · NYC DOT layers (${esc(src.speed_limits?.fetched ?? "?")}) · ${esc(crashes)} · OSM (${esc(src.osm?.fetched ?? "?")}) · profile ${esc(this.info?.profile ?? "")} v${esc(this.info?.profileVersion ?? "")}</div>`;
    this.el.querySelector(".close").onclick = () => this.close();
    this.el.hidden = false;
    this.el.scrollTop = 0;
  }

  // #51: a part-time bus lane or busway — when it's in force, whether it is now, and the score
  // outside it.
  timeNote(t, d, cls) {
    const now = restrictionNow(t, d.key, hourOfWeek());
    if (!now) return "";
    const what = t.bwy ? "Busway" : "Bus lane";
    const hours = t.blh ? ` (${esc(t.blh)})` : "";
    const off = t[`o${cls}${d.key}`];
    const outside = off == null ? "still not open to mopeds" : `scores ${off} (${bucketFor(off).label})`;
    return `<div class="note">${what} hours${hours} — ${now === "on" ? "in force now" : "not in force now"}. Outside them this way ${outside}.</div>`;
  }

  direction(t, d, cls, mid) {
    const head = `<h3>${titleCase(d.label)}</h3>`;
    if (!d.legal) {
      return `<section class="dir">${head}<div class="verdict no"><span class="chip" style="background:${NOT_ALLOWED.color}"></span>${esc(REASONS[d.reason] ?? d.reason ?? NOT_ALLOWED.label)}</div>${this.timeNote(t, d, cls)}</section>`;
    }
    const r = scoreInputs(inputsFromTile(t, d.key), cls, this.profile);
    const b = bucketFor(r.score);
    const pipeline = t[`s${cls}${d.key}`];
    const rows = Object.entries(r.points)
      .sort((a, z) => a[1] - z[1])
      .map(([k, v]) => `<tr><td>${esc(factorLabel(k, t, this.profile))}</td><td class="${v < 0 ? "neg" : "pos"}">${v > 0 ? "+" : ""}${v}</td></tr>`);
    const raw = r.raw < 0 ? ` <span class="muted" title="Unclamped total: lower is worse, even below 0">raw ${r.raw}</span>` : "";
    const mismatch =
      pipeline != null && pipeline !== r.score
        ? `<div class="warn">Pipeline score is ${pipeline}; the browser computed ${r.score}. Parity bug — see #28.</div>`
        : "";
    return `<section class="dir">${head}
      <div class="verdict"><span class="big" style="color:${b.color}">${r.score}</span>
        <span class="chip" style="background:${b.color}"></span><b>${b.label}</b>${raw}
        <span class="muted">· ${r.confidence} confidence</span></div>
      <table class="breakdown"><tr><td>Start</td><td>100</td></tr>${rows.join("") || `<tr><td colspan="2" class="muted">No penalties</td></tr>`}</table>
      ${mismatch}
      ${this.timeNote(t, d, cls)}
      ${d.stop ? `<div class="note">Stop sign at the end of the block this way.</div>` : ""}
      <a class="sv" href="${streetView(mid[1], mid[0], d.heading)}" target="_blank" rel="noopener">Street View, ${d.label}</a>
    </section>`;
  }
}

export { BUCKETS };
