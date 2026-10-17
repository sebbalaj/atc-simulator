// Pure 2D vector math. Operates on plain {x, y} objects and returns new objects
// (except scalar-returning helpers). Zero DOM/canvas dependencies so this module
// is fully unit-testable under Node.

/** Create a vector. */
export function vec2(x = 0, y = 0) {
  return { x, y };
}

/** a + b */
export function add(a, b) {
  return { x: a.x + b.x, y: a.y + b.y };
}

/** a - b */
export function sub(a, b) {
  return { x: a.x - b.x, y: a.y - b.y };
}

/** a * s (scalar) */
export function scale(a, s) {
  return { x: a.x * s, y: a.y * s };
}

/** Euclidean length of a. */
export function length(a) {
  return Math.hypot(a.x, a.y);
}

/** Squared length (cheaper, avoids sqrt). */
export function lengthSq(a) {
  return a.x * a.x + a.y * a.y;
}

/** Unit vector in the direction of a. Returns {0,0} for the zero vector. */
export function normalize(a) {
  const len = Math.hypot(a.x, a.y);
  if (len === 0) return { x: 0, y: 0 };
  return { x: a.x / len, y: a.y / len };
}

/** Distance between a and b. */
export function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

/** Squared distance between a and b. */
export function distanceSq(a, b) {
  const dx = a.x - b.x;
  const dy = a.y - b.y;
  return dx * dx + dy * dy;
}

/** Dot product. */
export function dot(a, b) {
  return a.x * b.x + a.y * b.y;
}

/** Angle of vector a in radians, measured from +x axis. */
export function angle(a) {
  return Math.atan2(a.y, a.x);
}

/** Angle in radians from a to b. */
export function angleBetween(a, b) {
  return Math.atan2(b.y - a.y, b.x - a.x);
}

/** Linear interpolation between a and b by t in [0,1]. */
export function lerp(a, b, t) {
  return { x: a.x + (b.x - a.x) * t, y: a.y + (b.y - a.y) * t };
}

/** Rotate vector a by angle (radians) around the origin. */
export function rotate(a, radians) {
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  return { x: a.x * cos - a.y * sin, y: a.x * sin + a.y * cos };
}

/** Return a copy of the vector. */
export function clone(a) {
  return { x: a.x, y: a.y };
}
