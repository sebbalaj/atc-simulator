// Component definitions for the ATC ECS. Components are plain data. String
// constants name each component type (used as the key in the World). Factory
// functions build well-formed, defaulted data objects. Pure module: later
// features (aircraft, economy, weather) extend usage but these shapes are the
// foundation. No DOM/canvas dependency.

/** Canonical component name constants. */
export const Components = Object.freeze({
  Transform: "Transform",
  Velocity: "Velocity",
  Aircraft: "Aircraft",
  Path: "Path",
  Hitbox: "Hitbox",
  Render: "Render",
  Fuel: "Fuel",
  Label: "Label",
});

/** Position and heading (radians). */
export function Transform(x = 0, y = 0, heading = 0) {
  return { x, y, heading };
}

/** Scalar speed in world units per second (direction comes from heading/path). */
export function Velocity(speed = 0) {
  return { speed };
}

/**
 * Aircraft classification and flight attributes. `kind` is one of the game's
 * aircraft classes (e.g. "light", "jet", "heli", "military"); later features
 * fill in turn radius, wake, passenger counts, etc.
 */
export function Aircraft(kind = "light", opts = {}) {
  return {
    kind,
    turnRadius: opts.turnRadius ?? 40,
    wake: opts.wake ?? 0,
    passengers: opts.passengers ?? 0,
    state: opts.state ?? "inbound", // inbound | holding | landing | landed
    emergency: opts.emergency ?? null, // null | "mayday" | "fuel" | "medical"
  };
}

/**
 * A drawn flight path. `points` are control points; `progress` is arc-length
 * distance traveled; `locked` indicates a cleared approach snapped to a runway.
 * `built` caches the arc-length polyline (filled by the path system).
 */
export function Path(points = [], opts = {}) {
  return {
    points,
    progress: opts.progress ?? 0,
    locked: opts.locked ?? false,
    built: opts.built ?? null,
    // True when the route is a holding-pattern orbit (burns fuel, not a landing).
    holding: opts.holding ?? false,
    completed: opts.completed ?? false,
  };
}

/** Circular collision radius in world units. */
export function Hitbox(radius = 8) {
  return { radius };
}

/** Rendering hints (shape, color, size). Consumed by the render system. */
export function Render(opts = {}) {
  return {
    shape: opts.shape ?? "triangle",
    color: opts.color ?? "#39ff14",
    size: opts.size ?? 8,
    blink: opts.blink ?? false,
  };
}

/** Fuel reserve. `remaining`/`capacity` measured in seconds of flight. */
export function Fuel(capacity = 120, opts = {}) {
  return {
    capacity,
    remaining: opts.remaining ?? capacity,
    critical: opts.critical ?? false,
  };
}

/** Human-readable callsign / flight id for flight strips and labels. */
export function Label(callsign = "") {
  return { callsign };
}
