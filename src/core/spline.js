// Catmull-Rom spline utilities for the touch-drawn flight paths. Includes an
// arc-length reparameterization so an aircraft can move at a constant speed
// along the path regardless of control-point spacing. Pure module.

/**
 * Sample a Catmull-Rom spline defined by `points` at parameter t in [0, 1].
 * The curve passes through every control point. Endpoints are duplicated so the
 * first and last segments are well defined.
 * @param {{x:number,y:number}[]} points
 * @param {number} t global parameter in [0,1]
 * @returns {{x:number,y:number}}
 */
export function sampleSpline(points, t) {
  const n = points.length;
  if (n === 0) return { x: 0, y: 0 };
  if (n === 1) return { x: points[0].x, y: points[0].y };
  if (n === 2) {
    // Straight line interpolation for two points.
    return {
      x: points[0].x + (points[1].x - points[0].x) * t,
      y: points[0].y + (points[1].y - points[0].y) * t,
    };
  }

  const clamped = Math.max(0, Math.min(1, t));
  const segments = n - 1;
  const scaled = clamped * segments;
  let i = Math.floor(scaled);
  if (i >= segments) i = segments - 1;
  const localT = scaled - i;

  const p0 = points[Math.max(0, i - 1)];
  const p1 = points[i];
  const p2 = points[i + 1];
  const p3 = points[Math.min(n - 1, i + 2)];

  return catmullRom(p0, p1, p2, p3, localT);
}

/** Catmull-Rom interpolation for a single segment (p1 -> p2). */
function catmullRom(p0, p1, p2, p3, t) {
  const t2 = t * t;
  const t3 = t2 * t;
  return {
    x:
      0.5 *
      (2 * p1.x +
        (-p0.x + p2.x) * t +
        (2 * p0.x - 5 * p1.x + 4 * p2.x - p3.x) * t2 +
        (-p0.x + 3 * p1.x - 3 * p2.x + p3.x) * t3),
    y:
      0.5 *
      (2 * p1.y +
        (-p0.y + p2.y) * t +
        (2 * p0.y - 5 * p1.y + 4 * p2.y - p3.y) * t2 +
        (-p0.y + 3 * p1.y - 3 * p2.y + p3.y) * t3),
  };
}

/**
 * Build a dense polyline from control points together with cumulative arc
 * lengths, enabling constant-speed traversal. The polyline samples the smooth
 * Catmull-Rom curve.
 * @param {{x:number,y:number}[]} points control points
 * @param {number} samplesPerSegment resolution per segment
 * @returns {{points:{x:number,y:number}[], cumulative:number[], length:number}}
 */
export function buildPath(points, samplesPerSegment = 16) {
  if (!points || points.length === 0) {
    return { points: [], cumulative: [], length: 0 };
  }
  if (points.length === 1) {
    const p = { x: points[0].x, y: points[0].y };
    return { points: [p], cumulative: [0], length: 0 };
  }

  const segments = points.length - 1;
  const totalSamples = segments * samplesPerSegment;
  const poly = [];
  const cumulative = [];
  let accumulated = 0;

  for (let s = 0; s <= totalSamples; s++) {
    const t = s / totalSamples;
    const pt = sampleSpline(points, t);
    if (poly.length > 0) {
      const prev = poly[poly.length - 1];
      accumulated += Math.hypot(pt.x - prev.x, pt.y - prev.y);
    }
    poly.push(pt);
    cumulative.push(accumulated);
  }

  return { points: poly, cumulative, length: accumulated };
}

/**
 * Find the point along a built path at a given arc-length distance. Distances
 * are clamped to the path's [0, length] range.
 * @param {{points:{x:number,y:number}[], cumulative:number[], length:number}} path
 * @param {number} dist arc length from the start
 * @returns {{x:number,y:number}}
 */
export function pointAtDistance(path, dist) {
  const { points, cumulative, length } = path;
  if (!points || points.length === 0) return { x: 0, y: 0 };
  if (points.length === 1) return { x: points[0].x, y: points[0].y };

  const d = Math.max(0, Math.min(length, dist));

  // Binary search for the segment whose cumulative length brackets d.
  let lo = 0;
  let hi = cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (cumulative[mid] < d) lo = mid + 1;
    else hi = mid;
  }

  const i = Math.max(1, lo);
  const segStart = cumulative[i - 1];
  const segEnd = cumulative[i];
  const segLen = segEnd - segStart;
  const localT = segLen > 0 ? (d - segStart) / segLen : 0;

  const a = points[i - 1];
  const b = points[i];
  return {
    x: a.x + (b.x - a.x) * localT,
    y: a.y + (b.y - a.y) * localT,
  };
}
