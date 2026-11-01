// JS mirror of pipeline/score.py's score_inputs() (D-008). No DOM access.
//
// Python is canonical; this exists so the browser can explain a score (inspector, #26) and
// recompute with live weights (#27). The two must agree exactly — the parity fixture (#28) checks
// it. Rounding is half-up in both (Math.round here, round_half_up there).

const CONF_ORDER = ["none", "low", "medium", "high"];
// Inputs the pipeline treats as medium confidence (OSM-derived); everything else defaults high.
const MEDIUM_INPUTS = { bus_route: "medium", surface: "medium", tracks: "medium" };

const round1 = (v) => Math.round(v * 10 + 1e-9) / 10; // same epsilon as round_half_up

function numKeys(table) {
  return Object.keys(table).map(Number).sort((a, b) => a - b);
}

export function stepPoints(table, value) {
  const keys = numKeys(table);
  const eligible = keys.filter((k) => k <= value);
  return Number(table[eligible.length ? eligible[eligible.length - 1] : keys[0]]);
}

export function laneWidthPoints(rows, width, singleLane) {
  const usable = rows.filter((r) => singleLane || !r.only_if_single_lane);
  for (const r of usable) if (r.min <= width && width < r.max) return Number(r.points);
  const below = usable.filter((r) => r.min <= width);
  return below.length ? Number(below.reduce((a, b) => (b.min > a.min ? b : a)).points) : 0;
}

// Travel lanes coming the other way (#81). Mirror of opposing_lanes() in pipeline/score.py.
export function opposingLanes(dir, lanesTotal, lanesPerDir, divided) {
  if (dir === "two_way" && lanesTotal != null && lanesPerDir != null) return Math.max(lanesTotal - lanesPerDir, 0);
  if (divided && (dir === "with" || dir === "against") && lanesPerDir != null) return lanesPerDir;
  if (dir === "with" || dir === "against") return 0;
  return null;
}

// Two-way street sharing one unmarked lane (#122). Mirror of shared_lane() in score.py.
export function sharedLane(dir, lanesTotal, yieldStreet) {
  if (dir !== "two_way") return false;
  return !!yieldStreet || (lanesTotal != null && Number(lanesTotal) <= 1);
}

// Curb-to-curb width beyond what the lanes use (#104). Mirror of excess_width() in score.py.
export function excessWidth(width, lanesTotal, parking, rule) {
  if (width == null || lanesTotal == null || parking == null) return null;
  return Number(width) - rule.lane_ft * Number(lanesTotal) - rule.parking_ft * Number(parking);
}

function bandPoints(rows, value) {
  for (const r of rows) if (r.min <= value && value < (r.max ?? Infinity)) return Number(r.points);
  return 0;
}

/**
 * Score one legal directed segment for one class. Same inputs as score_inputs():
 * speed_limit_mph, travel_lanes_per_dir, opposing_lanes, street_width_ft, travel_lanes_total,
 * parking_lanes, lane_width_ft, lane_width_conf, bike_lane, divided,
 * truck_route, bus_route, bus_lane, aadt_est, aadt_conf, crash_pct, surface, tracks,
 * pavement_rating, conf. Returns { score, raw, points, confidence }.
 */
export function scoreInputs(x, cls, profile) {
  const p = profile.score;
  const mods = profile.class_modifiers?.[cls] ?? {};
  const confIn = {
    lane_width_ft: x.lane_width_conf ?? "high",
    aadt: x.aadt_conf ?? "high",
    ...MEDIUM_INPUTS,
    ...(x.conf ?? {}),
  };
  const pts = {};

  if (x.speed_limit_mph != null) {
    const mph = Number(x.speed_limit_mph);
    const v = stepPoints(p.speed_limit_mph, mph);
    let m = mods.speed_limit_mph ?? 1;
    if (typeof m === "object") {
      const key = numKeys(p.speed_limit_mph).filter((k) => k <= mph).pop();
      m = m[key] ?? 1;
    }
    pts.speed_limit_mph = v * m;
  }
  // Half lanes round up (#106): 1.5 per direction alternates 2-1 / 1-2, two lanes on some side.
  if (x.travel_lanes_per_dir != null) {
    const lanes = Math.min(Math.max(Number(x.travel_lanes_per_dir), 1), 4);
    pts.travel_lanes_per_dir =
      stepPoints(p.travel_lanes_per_dir, Math.round(lanes + 1e-9)) * Number(mods.travel_lanes_per_dir ?? 1);
  }
  if (p.opposing_lanes && x.opposing_lanes != null) {
    pts.opposing_lanes = stepPoints(p.opposing_lanes, Math.round(Math.min(Number(x.opposing_lanes), 4) + 1e-9));
  }
  if (p.shared_lane != null && x.shared_lane) {
    pts.shared_lane = Number(p.shared_lane); // replaces the narrow-lane bonus (D-031)
  } else if (x.lane_width_ft != null && confIn.lane_width_ft !== "none") {
    const single = (x.travel_lanes_per_dir || 1) <= 1;
    pts.lane_width_ft = laneWidthPoints(p.lane_width_ft, Number(x.lane_width_ft), single) * Number(mods.lane_width_ft ?? 1);
  }
  if (p.excess_width_ft) {
    const rule = p.excess_width_rule;
    const xw = excessWidth(x.street_width_ft ?? null, x.travel_lanes_total ?? null, x.parking_lanes ?? null, rule);
    const lanes = Math.round(Math.max(Number(x.travel_lanes_per_dir || 1), 1) + 1e-9);
    if (xw != null && lanes <= rule.max_lanes_per_dir) pts.excess_width_ft = bandPoints(p.excess_width_ft, xw);
  }
  if (x.bike_lane) pts.bike_lane = Number(p.bike_lane_same_side[x.bike_lane] ?? 0);
  if (x.divided) pts.divided = Number(p.divided);
  if (x.truck_route) pts.truck_route = Number(p.truck_route[x.truck_route] ?? 0);
  if (x.bus_route) pts.bus_route = Number(p.bus_route);
  if (x.bus_lane) pts.bus_lane = Number(p.bus_lane_same_side);
  if (x.aadt_est != null) {
    let v = bandPoints(p.aadt, Number(x.aadt_est));
    if (confIn.aadt === "low") v *= Number(p.aadt_inferred_multiplier);
    pts.aadt = v;
  }
  if (x.crash_pct != null) {
    for (const band of [...p.crash_percentile].sort((a, b) => b.min - a.min)) {
      if (x.crash_pct >= band.min) {
        pts.crash = Number(band.points);
        break;
      }
    }
  }
  if (x.surface) pts.surface = Number(p.surface[x.surface] ?? 0);
  if (x.tracks) pts.tracks = Number(p.tracks);
  if (x.pavement_rating) pts.pavement = Number(p.pavement_rating[x.pavement_rating] ?? 0);

  const points = {};
  for (const [k, v] of Object.entries(pts)) if (v !== 0) points[k] = round1(v);
  const [lo, hi] = p.clamp;
  const total = p.start + Object.values(points).reduce((a, b) => a + b, 0);
  const score = Math.round(Math.min(Math.max(total, lo), hi) + 1e-9);

  const threshold = profile.confidence.contributor_threshold;
  const contributing = Object.entries(points)
    .filter(([, v]) => Math.abs(v) >= threshold)
    .map(([k]) => confIn[k] ?? "high");
  const confidence = contributing.length
    ? contributing.reduce((a, b) => (CONF_ORDER.indexOf(b) < CONF_ORDER.indexOf(a) ? b : a))
    : "high";
  // raw is the unclamped total: below 0 it still ranks the least-bad of several Avoid options (#92).
  return { score, raw: Math.round(total + 1e-9), points, confidence };
}

/** Tile properties (export.py's short keys) -> score inputs for one direction ("f" | "r"). */
export function inputsFromTile(t, dir) {
  return {
    opposing_lanes: opposingLanes(t.dir, t.lt ?? null, t.lpd ?? null, !!t.div),
    street_width_ft: t.sw ?? null,
    travel_lanes_total: t.lt ?? null,
    parking_lanes: t.pk ?? null,
    speed_limit_mph: t.spd ?? null,
    travel_lanes_per_dir: t.lpd ?? null,
    lane_width_ft: t.lw ?? null,
    lane_width_conf: t.lwc ?? null,
    shared_lane: sharedLane(t.dir, t.lt ?? null, t.yld),
    bike_lane: (dir === "f" ? t.bkf : t.bkr) ?? "none",
    divided: !!t.div,
    truck_route: t.trk ?? "none",
    bus_route: !!t.bus,
    bus_lane: !!(dir === "f" ? t.buf : t.bur),
    aadt_est: t.vol ?? null,
    aadt_conf: t.volc ?? null,
    crash_pct: t.crp ?? null,
    surface: t.srf ?? null,
    tracks: !!t.trx,
    pavement_rating: t.pav ?? "unknown",
  };
}
