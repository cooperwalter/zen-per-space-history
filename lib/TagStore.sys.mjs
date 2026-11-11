export const KINDS = Object.freeze(["page", "origin", "term"]);

const MASK_BITS = 31;

function popcount(mask) {
  let value = mask;
  let count = 0;
  while (value) {
    value &= value - 1;
    count++;
  }
  return count;
}

export class TagStore {
  #maps = { page: new Map(), origin: new Map(), term: new Map() };
  #rows = { page: 0, origin: 0, term: 0 };
  #pairs = [];
  #pairIndex = new Map();
  #scopeCache = new Map();

  #map(kind) {
    const map = this.#maps[kind];
    if (!map) {
      throw new Error(`Unknown tag kind: ${kind}`);
    }
    return map;
  }

  #intern(userContextId, spaceId) {
    const pairKey = `${userContextId}|${spaceId}`;
    let index = this.#pairIndex.get(pairKey);
    if (index === undefined) {
      index = this.#pairs.length;
      this.#pairs.push({ userContextId, spaceId });
      this.#pairIndex.set(pairKey, index);
      this.#scopeCache.clear();
    }
    return index;
  }

  #lookup(userContextId, spaceId) {
    return this.#pairIndex.get(`${userContextId}|${spaceId}`);
  }

  #matcher(scope) {
    const cacheKey = `${scope.dim}:${scope.id}`;
    let matcher = this.#scopeCache.get(cacheKey);
    if (!matcher) {
      let mask = 0;
      const indexes = new Set();
      this.#pairs.forEach((pair, index) => {
        const matches = scope.dim === "s" ? pair.spaceId === scope.id : pair.userContextId === scope.id;
        if (matches) {
          indexes.add(index);
          if (index < MASK_BITS) {
            mask |= 1 << index;
          }
        }
      });
      matcher = { mask, indexes };
      this.#scopeCache.set(cacheKey, matcher);
    }
    return matcher;
  }

  static #normalizeSpace(spaceId) {
    return spaceId == null ? "" : String(spaceId);
  }

  has(kind, key, scope) {
    const entry = this.#map(kind).get(key);
    if (entry === undefined) {
      return false;
    }
    const matcher = this.#matcher(scope);
    if (typeof entry === "number") {
      return (entry & matcher.mask) !== 0;
    }
    for (const index of entry) {
      if (matcher.indexes.has(index)) {
        return true;
      }
    }
    return false;
  }

  hasAny(kind, key) {
    return this.#map(kind).has(key);
  }

  add(kind, key, userContextId, spaceId) {
    const map = this.#map(kind);
    const index = this.#intern(userContextId, TagStore.#normalizeSpace(spaceId));
    const entry = map.get(key);
    if (typeof entry === "object") {
      if (entry.has(index)) {
        return false;
      }
      entry.add(index);
      this.#rows[kind]++;
      return true;
    }
    const mask = entry ?? 0;
    if (index < MASK_BITS) {
      const bit = 1 << index;
      if (mask & bit) {
        return false;
      }
      map.set(key, mask | bit);
      this.#rows[kind]++;
      return true;
    }
    const set = new Set();
    for (let bitIndex = 0; bitIndex < MASK_BITS; bitIndex++) {
      if (mask & (1 << bitIndex)) {
        set.add(bitIndex);
      }
    }
    set.add(index);
    map.set(key, set);
    this.#rows[kind]++;
    return true;
  }

  removeKey(kind, key) {
    const map = this.#map(kind);
    const entry = map.get(key);
    if (entry === undefined) {
      return false;
    }
    this.#rows[kind] -= typeof entry === "number" ? popcount(entry) : entry.size;
    map.delete(key);
    return true;
  }

  removeTag(kind, key, userContextId, spaceId) {
    const map = this.#map(kind);
    const entry = map.get(key);
    const index = this.#lookup(userContextId, TagStore.#normalizeSpace(spaceId));
    if (entry === undefined || index === undefined) {
      return false;
    }
    if (typeof entry === "number") {
      const bit = index < MASK_BITS ? 1 << index : 0;
      if (!(entry & bit)) {
        return false;
      }
      const next = entry & ~bit;
      if (next) {
        map.set(key, next);
      } else {
        map.delete(key);
      }
    } else {
      if (!entry.delete(index)) {
        return false;
      }
      if (!entry.size) {
        map.delete(key);
      }
    }
    this.#rows[kind]--;
    return true;
  }

  removeScope(dim, id) {
    const matcher = this.#matcher({ dim, id });
    if (!matcher.indexes.size) {
      return 0;
    }
    let removed = 0;
    for (const kind of KINDS) {
      const map = this.#maps[kind];
      let removedOfKind = 0;
      for (const [key, entry] of map) {
        if (typeof entry === "number") {
          const hit = entry & matcher.mask;
          if (!hit) {
            continue;
          }
          removedOfKind += popcount(hit);
          const next = entry & ~matcher.mask;
          if (next) {
            map.set(key, next);
          } else {
            map.delete(key);
          }
        } else {
          for (const index of matcher.indexes) {
            if (entry.delete(index)) {
              removedOfKind++;
            }
          }
          if (!entry.size) {
            map.delete(key);
          }
        }
      }
      this.#rows[kind] -= removedOfKind;
      removed += removedOfKind;
    }
    return removed;
  }

  clear() {
    for (const kind of KINDS) {
      this.#maps[kind].clear();
      this.#rows[kind] = 0;
    }
  }

  scopesOf(kind, key) {
    const entry = this.#map(kind).get(key);
    if (entry === undefined) {
      return [];
    }
    const indexes = [];
    if (typeof entry === "number") {
      for (let bitIndex = 0; bitIndex < MASK_BITS; bitIndex++) {
        if (entry & (1 << bitIndex)) {
          indexes.push(bitIndex);
        }
      }
    } else {
      indexes.push(...[...entry].sort((a, b) => a - b));
    }
    return indexes.map((index) => ({ ...this.#pairs[index] }));
  }

  keys(kind) {
    return this.#map(kind).keys();
  }

  size(kind) {
    return this.#map(kind).size;
  }

  rowCount(kind) {
    this.#map(kind);
    return this.#rows[kind];
  }

  stats() {
    return {
      pages: this.#maps.page.size,
      origins: this.#maps.origin.size,
      terms: this.#maps.term.size,
      rows: { ...this.#rows },
      scopes: this.#pairs.map((pair) => ({ ...pair })),
    };
  }
}
