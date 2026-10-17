// Entity-Component-System World. Entities are integer ids. Components are plain
// data objects stored in a Map keyed by component name, each holding a
// Map<entityId, data>. Systems (defined elsewhere) are plain functions that
// query the world each tick. Pure module: no DOM/canvas dependency.

export function createWorld() {
  let nextId = 1;

  // Set of live entity ids.
  const entities = new Set();

  // Map<componentName:string, Map<entityId:number, data:object>>
  const components = new Map();

  /** Allocate a new entity id. */
  function createEntity() {
    const id = nextId++;
    entities.add(id);
    return id;
  }

  /** Destroy an entity and strip all of its components. */
  function destroyEntity(id) {
    if (!entities.has(id)) return;
    entities.delete(id);
    for (const store of components.values()) store.delete(id);
  }

  /** Whether an entity id is currently alive. */
  function hasEntity(id) {
    return entities.has(id);
  }

  /** Attach (or replace) a component of `name` on an entity. Returns the data. */
  function addComponent(id, name, data) {
    let store = components.get(name);
    if (!store) {
      store = new Map();
      components.set(name, store);
    }
    store.set(id, data);
    return data;
  }

  /** Get a component's data for an entity, or undefined. */
  function getComponent(id, name) {
    const store = components.get(name);
    return store ? store.get(id) : undefined;
  }

  /** Whether an entity has a component. */
  function hasComponent(id, name) {
    const store = components.get(name);
    return store ? store.has(id) : false;
  }

  /** Remove a component from an entity. */
  function removeComponent(id, name) {
    const store = components.get(name);
    if (store) store.delete(id);
  }

  /**
   * Query entity ids that possess all of the given component names.
   * @param {...string} names
   * @returns {number[]}
   */
  function query(...names) {
    if (names.length === 0) return Array.from(entities);

    // Start from the smallest component store to minimize iteration.
    let smallest = null;
    for (const name of names) {
      const store = components.get(name);
      if (!store) return []; // No entity can match a missing component.
      if (smallest === null || store.size < smallest.size) smallest = store;
    }

    const result = [];
    for (const id of smallest.keys()) {
      let matches = true;
      for (const name of names) {
        if (!components.get(name).has(id)) {
          matches = false;
          break;
        }
      }
      if (matches) result.push(id);
    }
    return result;
  }

  /** Number of live entities. */
  function entityCount() {
    return entities.size;
  }

  return {
    createEntity,
    destroyEntity,
    hasEntity,
    addComponent,
    getComponent,
    hasComponent,
    removeComponent,
    query,
    entityCount,
  };
}
