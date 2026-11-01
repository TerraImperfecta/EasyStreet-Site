// Display buckets (SCORING §3). No DOM access: shared by the map and, later, web/core/score.js.
//
// Colors are brand/tokens color.map.light (#24, D-026): checked for colour-blind safety by
// brand/tools/check_palette.py; pipeline/tests/test_palette.py keeps this file in sync. Width is a
// second channel so the map never relies on colour alone: calmer streets draw thicker.

export const BUCKETS = [
  { bucket: 1, min: 80, label: "Calm", color: "#2D64A3", width: 1.6 },
  { bucket: 2, min: 60, label: "Comfortable", color: "#1EB5E6", width: 1.35 },
  { bucket: 3, min: 40, label: "Okay", color: "#F9B557", width: 1.1 },
  { bucket: 4, min: 20, label: "Stressful", color: "#C9610D", width: 0.9 },
  { bucket: 5, min: 0, label: "Avoid", color: "#8E0B48", width: 0.8 },
];

export const NOT_ALLOWED = { label: "Not allowed for mopeds", color: "#8A8F98" };
export const HAZARD_COLOR = "#1F2833"; // hazard-crossing markers (#23): navy, a shape not a score
export const OPEN_STREET_COLOR = "#7B4FA6"; // Open Streets overlay band and badge (#29)

export function bucketFor(score) {
  if (score == null) return null;
  return BUCKETS.find((b) => score >= b.min) ?? BUCKETS[BUCKETS.length - 1];
}

// Scores per class and direction are stored as s{A,B,C}{f,r}; absent means not legal that way.
export function scoreProps(cls) {
  return { fwd: `s${cls}f`, rev: `s${cls}r` };
}
