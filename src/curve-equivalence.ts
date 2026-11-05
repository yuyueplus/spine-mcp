import type { JsonObject } from './document.js';

/** Constant native normalization is checked over the entire Bezier value
 * convex hull. Matching endpoints alone must not hide an overshoot. */
export function equivalentNativeCurve(left: JsonObject, nextLeft: JsonObject | undefined, right: JsonObject, nextRight: JsonObject | undefined, values: (key: JsonObject) => number[], equal: (a: unknown, b: unknown) => boolean) {
  const no = { equivalent: false, normalizedComponents: 0, maxValueBound: 0 };
  if (!nextLeft || !nextRight) return no;
  const a = values(left), b = values(nextLeft), c = values(right), d = values(nextRight);
  if (!a.length || [b, c, d].some(v => v.length !== a.length) || ![...a, ...b, ...c, ...d].every(Number.isFinite)) return no;
  const controls = (curve: unknown, i: number, start: number, end: number): number[] | null => {
    if (curve === undefined) return [start, end];
    if (curve === 'stepped') return [start];
    if (!Array.isArray(curve) || curve.length !== a.length * 4 || !curve.every(v => typeof v === 'number' && Number.isFinite(v))) return null;
    return [start, curve[i * 4 + 1], curve[i * 4 + 3], end];
  };
  let normalizedComponents = 0, maxValueBound = 0;
  for (let i = 0; i < a.length; i++) {
    const lc = left.curve, rc = right.curve;
    if (Array.isArray(lc) && Array.isArray(rc) && lc.length === a.length * 4 && rc.length === a.length * 4 && equal(lc.slice(i * 4, i * 4 + 4), rc.slice(i * 4, i * 4 + 4))) continue;
    if (lc === rc && !Array.isArray(lc)) continue;
    const l = controls(lc, i, a[i]!, b[i]!), r = controls(rc, i, c[i]!, d[i]!);
    if (!l || !r) return no;
    const bound = Math.max(...l, ...r) - Math.min(...l, ...r);
    // Native constant simplification may move an ordinate by one scalar
    // precision on each side. This separate, reported bound is at most twice
    // the scalar tolerance; it does not relax endpoints or nonconstant curves.
    const tolerance = 2e-5 * Math.max(1, Math.abs(a[i]!), Math.abs(b[i]!), Math.abs(c[i]!), Math.abs(d[i]!));
    if (bound > tolerance) return no;
    normalizedComponents++; maxValueBound = Math.max(maxValueBound, bound);
  }
  return { equivalent: true, normalizedComponents, maxValueBound };
}
