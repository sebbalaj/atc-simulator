// Uniform-grid spatial hash for broad-phase collision detection. Buckets entity
// ids into fixed-size cells; queryNeighbors returns candidate ids within the
// cells overlapping a query circle (broad phase: a precise distance test should
// follow in the caller). Pure module, no DOM dependency.

export function createSpatialHash(cellSize = 64) {
  if (cellSize <= 0) throw new Error("cellSize must be positive");

  // Map<cellKey:string, number[] of ids>
  const cells = new Map();

  function keyFor(cx, cy) {
    return cx + "," + cy;
  }

  function cellCoord(v) {
    return Math.floor(v / cellSize);
  }

  /** Insert an entity id at world position (x, y). */
  function insert(id, x, y) {
    const key = keyFor(cellCoord(x), cellCoord(y));
    let bucket = cells.get(key);
    if (!bucket) {
      bucket = [];
      cells.set(key, bucket);
    }
    bucket.push(id);
  }

  /** Remove all entries. Call once per tick before re-inserting. */
  function clear() {
    cells.clear();
  }

  /**
   * Return candidate ids near (x, y) within `radius`. This is a broad-phase
   * query: it returns every id stored in any cell overlapping the query circle.
   * Candidates may lie slightly outside `radius`; callers do the exact test.
   */
  function queryNeighbors(x, y, radius) {
    const minCx = cellCoord(x - radius);
    const maxCx = cellCoord(x + radius);
    const minCy = cellCoord(y - radius);
    const maxCy = cellCoord(y + radius);

    const result = [];
    for (let cx = minCx; cx <= maxCx; cx++) {
      for (let cy = minCy; cy <= maxCy; cy++) {
        const bucket = cells.get(keyFor(cx, cy));
        if (bucket) {
          for (let i = 0; i < bucket.length; i++) result.push(bucket[i]);
        }
      }
    }
    return result;
  }

  return { insert, clear, queryNeighbors, cellSize };
}
