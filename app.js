// Easy Street web prototype — MapLibre GL JS + PMTiles, static, no build step (D-009).
//
// Colors each street by the comfort bucket of its *worse* legal direction for the selected
// moped class; segments a moped can't use draw grey (or hide). One-way arrows point the legal
// direction. Scores are precomputed by the pipeline (export.py); the live weights panel (#27)
// will recompute them in the browser, and the inspector (#26) explains them.

import * as maplibregl from "https://unpkg.com/maplibre-gl@6.12.0/dist/maplibre-gl.mjs";
import { Protocol, PMTiles } from "https://unpkg.com/pmtiles@4.5.0/dist/esm/index.js";
import { BUCKETS, HAZARD_COLOR, NOT_ALLOWED, OPEN_STREET_COLOR, bucketFor, scoreProps } from "./core/buckets.js";
import { dirScoreExpr, hourOfWeek, offHours, scoreAt } from "./core/timeofday.js";
import { Inspector } from "./inspector.js";
import { inputsFromTile, scoreInputs } from "./core/score.js";
import { RatingMode } from "./rating.js";
import { WeightsPanel } from "./weights.js";

const DATA_URL = new URL("data/segments.pmtiles", location.href).href;
const PROFILE_URL = new URL("data/moped.json", location.href).href;
const INFO_URL = new URL("data/build-info.json", location.href).href;
const RATINGS_URL = new URL("data/ratings.json", location.href).href;
const NYC = [[-74.26, 40.49], [-73.69, 40.92]];
const NO_SCORE = 999;

const protocol = new Protocol();
maplibregl.addProtocol("pmtiles", protocol.tile);
const archive = new PMTiles(DATA_URL);
protocol.add(archive);

const state = {
  cls: load("cls", "B"),
  showIllegal: load("showIllegal", "1") === "1",
  showHazards: load("showHazards", "1") === "1",
  showSignalized: load("showSignalized", "0") === "1", // most risky crossings are signalized avenue corners
  showConstruction: load("showConstruction", "1") === "1",
  showOpenStreets: load("showOpenStreets", "1") === "1",
  // #51: score bus lanes and busways as they are right now, or as if always in force (plan ahead)
  alwaysRestricted: load("alwaysRestricted", "0") === "1",
};
// The hour of the week the map is drawn for (null: restrictions always in force).
const nowHour = () => (state.alwaysRestricted ? null : hourOfWeek());
let drawnHour = nowHour();

function load(key, fallback) {
  try {
    return localStorage.getItem(`easystreet.${key}`) ?? fallback;
  } catch {
    return fallback;
  }
}
function save(key, value) {
  try {
    localStorage.setItem(`easystreet.${key}`, value);
  } catch {
    /* private window or blocked storage: settings just don't persist */
  }
}

// --- style expressions ----------------------------------------------------------------------

function worse(cls) {
  return ["min", dirScoreExpr(cls, "f", drawnHour, NO_SCORE), dirScoreExpr(cls, "r", drawnHour, NO_SCORE)];
}
// With live weights (#27) each feature carries its rescored worse-direction score in feature-state
// "w"; without them (or before a tile is rescored) the precomputed score is used.
let live = null; // the effective profile from the weights panel, once it has changed
function scoreExpr(cls) {
  return live ? ["coalesce", ["feature-state", "w"], worse(cls)] : worse(cls);
}
function bucketExpr(cls, pick) {
  const e = ["step", scoreExpr(cls)];
  const ordered = [...BUCKETS].sort((a, b) => a.min - b.min);
  e.push(pick(ordered[0]));
  for (const b of ordered.slice(1)) e.push(b.min, pick(b));
  return e;
}
const legal = (cls) => ["<", worse(cls), NO_SCORE];
const lowConfidence = ["any", ["==", ["get", "cBf"], "low"], ["==", ["get", "cBr"], "low"]];
// Zoom must be the outermost input of a width expression, so the per-feature factor goes inside
// each stop: width(zoom) × factor(feature).
const ZOOM_WIDTHS = [11, 0.6, 13, 1.4, 15, 3, 17, 6];
function widthExpr(factor) {
  const e = ["interpolate", ["linear"], ["zoom"]];
  for (let i = 0; i < ZOOM_WIDTHS.length; i += 2) e.push(ZOOM_WIDTHS[i], ["*", ZOOM_WIDTHS[i + 1], factor]);
  return e;
}
const oneLegalDirection = ["!=", ["has", "lgf"], ["has", "lgr"]];

// --- map ------------------------------------------------------------------------------------

const map = new maplibregl.Map({
  container: "map",
  style: "https://tiles.openfreemap.org/styles/positron", // D-019: no API key
  bounds: NYC,
  fitBoundsOptions: { padding: 20 },
  hash: true, // #zoom/lat/lng in the URL: shareable views; a link with a hash overrides `bounds`
  minZoom: 9,
  maxZoom: 19,
  attributionControl: {
    customAttribution: "NYC DCP LION · NYC DOT · NYPD (NYC Open Data)",
  },
});
window.easyStreet = { map }; // debugging handle
map.on("error", (e) => console.error("map error:", e.error?.message ?? e));
map.addControl(new maplibregl.NavigationControl({ showCompass: false }), "top-right");
map.addControl(new maplibregl.GeolocateControl({ trackUserLocation: true }), "top-right");
map.addControl(new maplibregl.ScaleControl({ unit: "imperial" }), "bottom-right");

function arrowImage() {
  const s = 32;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d");
  g.beginPath();
  g.moveTo(7, 7);
  g.lineTo(26, 16);
  g.lineTo(7, 25);
  g.lineTo(12, 16);
  g.closePath();
  g.lineJoin = "round";
  g.lineWidth = 4;
  g.strokeStyle = "#ffffff";
  g.stroke();
  g.fillStyle = "#1F2833";
  g.fill();
  return g.getImageData(0, 0, s, s);
}

// Overlay icons (#29): a road-work diamond and an Open Streets badge. Shapes, not score colours.
function constructionImage() {
  const s = 40;
  const c = document.createElement("canvas");
  c.width = c.height = s;
  const g = c.getContext("2d");
  g.beginPath();
  g.moveTo(20, 3);
  g.lineTo(37, 20);
  g.lineTo(20, 37);
  g.lineTo(3, 20);
  g.closePath();
  g.fillStyle = "#F9B557";
  g.strokeStyle = HAZARD_COLOR;
  g.lineWidth = 3.5;
  g.lineJoin = "round";
  g.fill();
  g.stroke();
  g.fillStyle = HAZARD_COLOR;
  g.fillRect(18, 10, 4, 13);
  g.fillRect(18, 26, 4, 4);
  return g.getImageData(0, 0, s, s);
}

function openStreetImage() {
  const w = 52, h = 34;
  const c = document.createElement("canvas");
  c.width = w;
  c.height = h;
  const g = c.getContext("2d");
  g.beginPath();
  g.roundRect(2, 2, w - 4, h - 4, 8);
  g.fillStyle = OPEN_STREET_COLOR;
  g.fill();
  g.lineWidth = 3;
  g.strokeStyle = "#ffffff";
  g.stroke();
  g.fillStyle = "#ffffff";
  g.font = "bold 17px system-ui, sans-serif";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText("OS", w / 2, h / 2 + 1);
  return g.getImageData(0, 0, w, h);
}

map.on("load", () => {
  map.addImage("es-arrow", arrowImage(), { pixelRatio: 2 });
  map.addImage("es-construction", constructionImage(), { pixelRatio: 2 });
  map.addImage("es-open-street", openStreetImage(), { pixelRatio: 2 });
  map.addSource("segments", {
    type: "vector",
    url: `pmtiles://${DATA_URL}`,
    promoteId: "id",
  });
  // Draw under the basemap's labels so street names stay readable.
  const beforeLabels = map.getStyle().layers.find((l) => l.type === "symbol")?.id;

  // Open Streets (#29): a translucent band under the street — solid if approved now, dashed if
  // only last season's approval is published.
  for (const [id, status, dash] of [["open-streets-now", "now", null], ["open-streets-last", "last season", [1, 1]]]) {
    map.addLayer(
      {
        id,
        type: "line",
        source: "segments",
        "source-layer": "segments",
        minzoom: 12,
        filter: ["==", ["get", "oss"], status],
        layout: { visibility: state.showOpenStreets ? "visible" : "none" },
        paint: {
          "line-color": OPEN_STREET_COLOR,
          "line-opacity": status === "now" ? 0.4 : 0.3,
          "line-width": widthExpr(5),
          ...(dash ? { "line-dasharray": dash } : {}),
        },
      },
      beforeLabels,
    );
  }
  map.addLayer(
    {
      id: "not-allowed",
      type: "line",
      source: "segments",
      "source-layer": "segments",
      paint: {
        "line-color": NOT_ALLOWED.color,
        "line-opacity": 0.35,
        "line-width": widthExpr(0.7),
      },
    },
    beforeLabels,
  );
  for (const [id, conf] of [
    ["calm-solid", ["!", lowConfidence]],
    ["calm-dashed", lowConfidence],
  ]) {
    map.addLayer(
      {
        id,
        type: "line",
        source: "segments",
        "source-layer": "segments",
        layout: { "line-cap": id.endsWith("solid") ? "round" : "butt" },
        paint: {
          "line-width": widthExpr(bucketExpr(state.cls, (b) => b.width)),
          "line-color": bucketExpr(state.cls, (b) => b.color),
          ...(id.endsWith("dashed") ? { "line-dasharray": [2, 1.5] } : {}),
        },
        filter: ["all", conf],
      },
      beforeLabels,
    );
  }
  map.addLayer({
    id: "arrows",
    type: "symbol",
    source: "segments",
    "source-layer": "segments",
    minzoom: 15,
    layout: {
      "symbol-placement": "line",
      "symbol-spacing": 70,
      "icon-image": "es-arrow",
      "icon-size": ["interpolate", ["linear"], ["zoom"], 15, 0.7, 18, 1.2],
      "icon-allow-overlap": true,
      // Geometry runs in the digitized direction; flip the arrow when only "rev" is legal.
      "icon-rotate": ["case", ["has", "lgr"], 180, 0],
    },
  });
  map.addLayer({
    id: "construction",
    type: "symbol",
    source: "segments",
    "source-layer": "segments",
    minzoom: 13,
    filter: ["has", "con"],
    layout: {
      visibility: state.showConstruction ? "visible" : "none",
      "symbol-placement": "line-center",
      "icon-image": "es-construction",
      "icon-size": ["interpolate", ["linear"], ["zoom"], 13, 0.6, 17, 1],
      "icon-allow-overlap": true,
    },
  });
  map.addLayer({
    id: "open-street-badges",
    type: "symbol",
    source: "segments",
    "source-layer": "segments",
    minzoom: 14,
    filter: ["has", "oss"],
    layout: {
      visibility: state.showOpenStreets ? "visible" : "none",
      "symbol-placement": "line-center",
      "icon-image": "es-open-street",
      "icon-size": ["interpolate", ["linear"], ["zoom"], 14, 0.55, 17, 0.9],
    },
  });
  // Hazard intersections (#23): a calm street meets a fast or wide one. Markers only, not scored.
  map.addLayer({
    id: "hazards",
    type: "circle",
    source: "segments",
    "source-layer": "hazards",
    minzoom: 12,
    filter: hazardFilter(),
    layout: { visibility: state.showHazards ? "visible" : "none" },
    paint: {
      "circle-radius": ["interpolate", ["linear"], ["zoom"], 12, 2.5, 16, 6],
      "circle-color": ["case", ["has", "sig"], "#ffffff", HAZARD_COLOR],
      "circle-stroke-color": HAZARD_COLOR,
      "circle-stroke-width": ["interpolate", ["linear"], ["zoom"], 12, 1, 16, 2],
    },
  });
  map.addLayer({
    id: "selected",
    type: "line",
    source: "segments",
    "source-layer": "segments",
    filter: ["==", ["get", "id"], ""],
    paint: { "line-color": "#1E8A6E", "line-opacity": 0.45, "line-width": widthExpr(4) },
  });
  applyClass();
  hoverLabel();
  dataAsOf();
  inspectOnClick();
});

let inspector;
let weights;
async function inspectOnClick() {
  const [profile, info, ratings] = await Promise.all([
    fetch(PROFILE_URL).then((r) => r.json()),
    fetch(INFO_URL).then((r) => (r.ok ? r.json() : null)).catch(() => null),
    fetch(RATINGS_URL).then((r) => (r.ok ? r.json() : [])).catch(() => []),
  ]);
  inspector = new Inspector(document.getElementById("inspector"), { profile, info });
  setupWeights(profile, ratings);
  const layers = ["calm-solid", "calm-dashed", "not-allowed"];
  map.on("click", (e) => {
    if (rating.active) return; // #100: rating is blind, and the block stays highlighted
    const box = [[e.point.x - 4, e.point.y - 4], [e.point.x + 4, e.point.y + 4]];
    const f = map.queryRenderedFeatures(box, { layers })[0];
    if (!f) {
      inspector.close();
      map.setFilter("selected", ["==", ["get", "id"], ""]);
      return;
    }
    map.setFilter("selected", ["==", ["get", "id"], f.properties.id]);
    inspector.show(f, state.cls);
    selectedFeature = f;
  });
  document.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      inspector.close();
      map.setFilter("selected", ["==", ["get", "id"], ""]);
    }
  });
}
let selectedFeature = null;

// --- live weights (#27) ---------------------------------------------------------------------

function setupWeights(profile, ratings) {
  const el = document.getElementById("weights");
  weights = new WeightsPanel(el, {
    profile,
    ratings,
    getClass: () => state.cls,
    onChange: (p) => {
      const first = !live;
      live = p;
      inspector.profile = p;
      if (first) applyClass(); // switch the paint to read feature-state
      rescoreLoaded();
      if (selectedFeature && !document.getElementById("inspector").hidden) inspector.show(selectedFeature, state.cls);
    },
  });
  document.getElementById("tune").onclick = () => {
    el.hidden = !el.hidden;
  };
  map.on("sourcedata", (e) => {
    if (live && e.sourceId === "segments" && e.isSourceLoaded) rescoreSoon();
  });
}

let rescoreTimer;
function rescoreSoon() {
  clearTimeout(rescoreTimer);
  rescoreTimer = setTimeout(rescoreLoaded, 150);
}

// Rescore every loaded feature with the live profile and push it in as feature-state.
function rescoreLoaded() {
  if (!live) return;
  const cls = state.cls;
  const seen = new Set();
  for (const f of map.querySourceFeatures("segments", { sourceLayer: "segments" })) {
    const t = f.properties;
    if (seen.has(t.id)) continue;
    seen.add(t.id);
    let w = null;
    for (const d of ["f", "r"]) {
      const off = offHours(t, d, drawnHour); // #51: outside bus lane / busway hours
      if (t[off ? `o${cls}${d}` : `s${cls}${d}`] == null) continue; // not legal that way now
      const inputs = inputsFromTile(t, d);
      if (off) inputs.bus_lane = false;
      const s = scoreInputs(inputs, cls, live).score;
      w = w == null ? s : Math.min(w, s);
    }
    if (w != null) map.setFeatureState({ source: "segments", sourceLayer: "segments", id: t.id }, { w });
  }
}

function applyClass() {
  const cls = state.cls;
  for (const id of ["calm-solid", "calm-dashed"]) {
    const conf = id.endsWith("solid") ? ["!", lowConfidence] : lowConfidence;
    map.setFilter(id, ["all", legal(cls), conf]);
    map.setPaintProperty(id, "line-color", bucketExpr(cls, (b) => b.color));
    map.setPaintProperty(id, "line-width", widthExpr(bucketExpr(cls, (b) => b.width)));
  }
  map.setFilter("not-allowed", ["!", legal(cls)]);
  map.setLayoutProperty("not-allowed", "visibility", state.showIllegal ? "visible" : "none");
  map.setFilter("arrows", ["all", legal(cls), oneLegalDirection]);
  if (live) rescoreLoaded();
}

// --- small hover label (the full inspector is #26) -----------------------------------------

// Beside the cursor, flipped left/up when it would run off the map.
function placeTip(tip, pt) {
  tip.hidden = false;
  const { clientWidth: w, clientHeight: h } = map.getContainer();
  const x = pt.x + 14 + tip.offsetWidth > w ? pt.x - 14 - tip.offsetWidth : pt.x + 14;
  const y = pt.y + 14 + tip.offsetHeight > h ? pt.y - 14 - tip.offsetHeight : pt.y + 14;
  tip.style.left = `${Math.max(4, x)}px`;
  tip.style.top = `${Math.max(4, y)}px`;
}

function overlayText(f) {
  const p = f.properties;
  if (f.layer.id === "construction") {
    return `<b>Construction</b> · ${titleCase(p.name ?? "")}<br>${p.cnn ?? "active street closure"}`;
  }
  if (f.layer.id === "open-street-badges") return `<b>${openStreetTitle(p)}</b> · ${titleCase(p.name ?? "")}<br>${p.osn ?? ""}`;
  return hazardText(p);
}

function openStreetTitle(p) {
  if (p.oss !== "now") return "Open Street last season — check this year";
  // #51: its weekly hours, in New York time
  if (typeof p.osh !== "string") return "Open Street";
  return p.osh[hourOfWeek()] === "1" ? "Open Street — in effect now" : "Open Street — not in effect right now";
}

// Signalized crossings are hidden unless asked for: in Manhattan nearly every side street meets a
// 3+ lane avenue at a light, and those markers buried the unsignalized ones.
function hazardFilter() {
  return state.showSignalized ? null : ["!", ["has", "sig"]];
}

function hazardText(p) {
  const fast = [p.fspd != null ? `${p.fspd} mph` : null, p.flpd != null ? `${p.flpd} lanes each way` : null]
    .filter(Boolean)
    .join(", ");
  const control = p.sig ? "signalized" : p.stp ? "stop sign, no signal" : "no signal mapped";
  return `<b>Risky crossing</b><br>${titleCase(p.cs ?? "")} meets ${titleCase(p.fs ?? "")}${fast ? ` (${fast})` : ""}<br>${control}`;
}

function hoverLabel() {
  const tip = document.getElementById("tip");
  const layers = ["calm-solid", "calm-dashed", "not-allowed"];
  map.on("mousemove", (e) => {
    const overlayLayers = [
      ...(state.showHazards ? ["hazards"] : []),
      ...(state.showConstruction ? ["construction"] : []),
      ...(state.showOpenStreets ? ["open-street-badges"] : []),
    ];
    const h = overlayLayers.length ? map.queryRenderedFeatures(e.point, { layers: overlayLayers })[0] : null;
    if (h) {
      map.getCanvas().style.cursor = "";
      tip.innerHTML = overlayText(h);
      placeTip(tip, e.point);
      return;
    }
    const f = map.queryRenderedFeatures(e.point, { layers })[0];
    map.getCanvas().style.cursor = f ? "pointer" : "";
    if (!f) {
      tip.hidden = true;
      return;
    }
    const p = f.properties;
    let scores = ["f", "r"].map((d) => scoreAt(p, state.cls, d, drawnHour)).filter((v) => v != null);
    const liveW = live ? map.getFeatureState({ source: "segments", sourceLayer: "segments", id: p.id })?.w : null;
    if (liveW != null) scores = [liveW];
    const b = scores.length ? bucketFor(Math.min(...scores)) : null;
    tip.innerHTML = `<b>${titleCase(p.name ?? "")}</b><br>${
      b ? `${b.label} · ${Math.min(...scores)}${p.cBf === "low" || p.cBr === "low" ? " · low confidence" : ""}` : NOT_ALLOWED.label
    }`;
    placeTip(tip, e.point);
  });
  map.getCanvas().addEventListener("mouseleave", () => (tip.hidden = true));
}

function titleCase(s) {
  return s.toLowerCase().replace(/\b([a-z])/g, (m) => m.toUpperCase());
}

async function dataAsOf() {
  const el = document.getElementById("asof");
  try {
    const meta = await archive.getMetadata();
    const info = JSON.parse(meta.description ?? "{}");
    el.textContent = `Data as of ${info.asOf ?? "?"} · ${info.profile ?? ""}`;
  } catch {
    el.textContent = "Data date unavailable";
  }
}

// --- controls -------------------------------------------------------------------------------

function legend() {
  const rows = BUCKETS.map(
    (b) =>
      `<div class="row"><span class="sw" style="background:${b.color};height:${Math.round(b.width * 3)}px"></span>${b.label}<span class="range">${b.min}${b.min === 80 ? "–100" : `–${b.min + 19}`}</span></div>`,
  );
  rows.push(
    `<div class="row"><span class="sw dash"></span>Low confidence</div>`,
    `<div class="row"><span class="sw" style="background:${NOT_ALLOWED.color};opacity:.5"></span>${NOT_ALLOWED.label}</div>`,
    `<div class="row"><span class="chip"><span class="diamond"></span></span>Construction</div>`,
    `<div class="row"><span class="chip"><span class="sw" style="background:${OPEN_STREET_COLOR};opacity:.45;height:8px;box-shadow:none"></span></span>Open Street</div>`,
    `<div class="row"><span class="chip"><span class="dot" style="background:${HAZARD_COLOR};border-color:${HAZARD_COLOR}"></span></span>Risky crossing, no signal</div>`,
    `<div class="row"><span class="chip"><span class="dot" style="border-color:${HAZARD_COLOR}"></span></span>Risky crossing, signalized</div>`,
  );
  document.getElementById("legend").innerHTML = rows.join("");
}

for (const input of document.querySelectorAll('input[name="cls"]')) {
  input.checked = input.value === state.cls;
  input.addEventListener("change", () => {
    state.cls = input.value;
    save("cls", state.cls);
    if (map.loaded()) applyClass();
    if (inspector && selectedFeature && !document.getElementById("inspector").hidden) {
      inspector.show(selectedFeature, state.cls);
    }
  });
}
for (const [id, key, layers] of [
  ["showConstruction", "showConstruction", ["construction"]],
  ["showOpenStreets", "showOpenStreets", ["open-streets-now", "open-streets-last", "open-street-badges"]],
]) {
  const el = document.getElementById(id);
  el.checked = state[key];
  el.addEventListener("change", () => {
    state[key] = el.checked;
    save(key, el.checked ? "1" : "0");
    for (const l of layers) if (map.getLayer(l)) map.setLayoutProperty(l, "visibility", el.checked ? "visible" : "none");
  });
}
const hazardToggle = document.getElementById("showHazards");
const signalizedToggle = document.getElementById("showSignalized");
hazardToggle.checked = state.showHazards;
signalizedToggle.checked = state.showSignalized;
signalizedToggle.disabled = !state.showHazards;
hazardToggle.addEventListener("change", () => {
  state.showHazards = hazardToggle.checked;
  signalizedToggle.disabled = !state.showHazards;
  save("showHazards", state.showHazards ? "1" : "0");
  if (map.getLayer("hazards")) map.setLayoutProperty("hazards", "visibility", state.showHazards ? "visible" : "none");
});
signalizedToggle.addEventListener("change", () => {
  state.showSignalized = signalizedToggle.checked;
  save("showSignalized", state.showSignalized ? "1" : "0");
  if (map.getLayer("hazards")) map.setFilter("hazards", hazardFilter());
});
// Rating mode (#100): load a sheet CSV and step through it blind.
const rating = new RatingMode(document.getElementById("rating"), map);
const rateFile = document.getElementById("rateFile");
document.getElementById("rate").addEventListener("click", () => rateFile.click());
rateFile.addEventListener("change", () => {
  if (rateFile.files[0]) rating.open(rateFile.files[0]);
  rateFile.value = "";
});
document.addEventListener("easystreet:rating-closed", () => {
  if (map.loaded()) applyClass();
});

const restrictedToggle = document.getElementById("alwaysRestricted");
restrictedToggle.checked = state.alwaysRestricted;
restrictedToggle.addEventListener("change", () => {
  state.alwaysRestricted = restrictedToggle.checked;
  save("alwaysRestricted", state.alwaysRestricted ? "1" : "0");
  redrawForTime();
});
// Bus lane hours change on the hour: redraw when the hour of the week rolls over.
function redrawForTime() {
  drawnHour = nowHour();
  if (map.loaded()) applyClass();
}
setInterval(() => {
  if (nowHour() !== drawnHour) redrawForTime();
}, 60_000);
const illegalToggle = document.getElementById("showIllegal");
illegalToggle.checked = state.showIllegal;
illegalToggle.addEventListener("change", () => {
  state.showIllegal = illegalToggle.checked;
  save("showIllegal", state.showIllegal ? "1" : "0");
  if (map.loaded()) applyClass();
});
legend();
