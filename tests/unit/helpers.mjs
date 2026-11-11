import { DatabaseSync } from "node:sqlite";
import { TagStore } from "../../lib/TagStore.sys.mjs";
import { createFilter } from "../../lib/Filter.sys.mjs";
import { createScopeResolver } from "../../lib/ScopeResolver.sys.mjs";
import { TagDb } from "../../lib/TagDb.sys.mjs";

export const RESULT_SOURCE = Object.freeze({
  BOOKMARKS: 1,
  HISTORY: 2,
  SEARCH: 3,
  TABS: 4,
  OTHER_LOCAL: 5,
  OTHER_NETWORK: 6,
  ADDON: 7,
  ACTIONS: 8,
});

export const RESULT_TYPE = Object.freeze({
  TAB_SWITCH: 1,
  SEARCH: 2,
  URL: 3,
  KEYWORD: 4,
});

export const DEFAULT_CONFIG = Object.freeze({
  enabled: true,
  scope: "container",
  untaggedVisibility: "everywhere",
  filterHistory: true,
  filterAutofill: true,
  filterSearchHistory: true,
  tagging: true,
  debug: false,
});

export function makeStore() {
  return new TagStore();
}

export function makeFilter({ store = makeStore(), config = {}, ready = true, windowInfo = null } = {}) {
  const fullConfig = { ...DEFAULT_CONFIG, ...config };
  const resolver = createScopeResolver({
    getConfig: () => fullConfig,
    getWindowInfo: () => windowInfo,
  });
  const filter = createFilter({
    getStore: () => store,
    getConfig: () => fullConfig,
    resolveScope: (context, owner) => resolver.current(context, owner),
    isReady: () => ready,
    RESULT_SOURCE,
    RESULT_TYPE,
  });
  return { filter, store, config: fullConfig };
}

export function makeContext(overrides = {}) {
  return { userContextId: 0, isPrivate: false, ...overrides };
}

export function makeHistoryResult(url, overrides = {}) {
  return {
    type: RESULT_TYPE.URL,
    source: RESULT_SOURCE.HISTORY,
    payload: { url },
    ...overrides,
  };
}

export function makeAutofillResult(url, autofillType) {
  return {
    type: RESULT_TYPE.URL,
    source: RESULT_SOURCE.HISTORY,
    heuristic: true,
    autofill: { type: autofillType, value: url },
    payload: { url },
  };
}

export function makeSearchHistoryResult(payload) {
  return {
    type: RESULT_TYPE.SEARCH,
    source: RESULT_SOURCE.HISTORY,
    payload,
  };
}

export const PROVIDER = Object.freeze({ name: "TestProvider" });

class FakeRow {
  #row;
  constructor(row) {
    this.#row = row;
  }
  getResultByName(name) {
    return this.#row[name];
  }
}

export class FakeConnection {
  constructor(path = ":memory:") {
    this.db = new DatabaseSync(path);
    this.closed = false;
    this.statements = 0;
  }

  async execute(sql, params) {
    this.statements++;
    const statement = this.db.prepare(sql);
    const rows = params === undefined ? statement.all() : Array.isArray(params) ? statement.all(...params) : statement.all(params);
    return rows.map((row) => new FakeRow(row));
  }

  async executeCached(sql, params) {
    return this.execute(sql, params);
  }

  async executeTransaction(callback) {
    this.db.exec("BEGIN IMMEDIATE");
    try {
      const value = await callback();
      this.db.exec("COMMIT");
      return value;
    } catch (error) {
      this.db.exec("ROLLBACK");
      throw error;
    }
  }

  async close() {
    this.closed = true;
    this.db.close();
  }

  rows(sql) {
    return this.db.prepare(sql).all().map((row) => ({ ...row }));
  }
}

export function makeFakeTimers() {
  let nextId = 1;
  const pending = new Map();
  return {
    setTimeout(callback, delayMs) {
      const id = nextId++;
      pending.set(id, { callback, delayMs });
      return id;
    },
    clearTimeout(id) {
      pending.delete(id);
    },
    pendingDelays() {
      return [...pending.values()].map((timer) => timer.delayMs);
    },
    async fireAll() {
      const timers = [...pending.values()];
      pending.clear();
      for (const timer of timers) {
        await timer.callback();
      }
    },
  };
}

export async function makeDb({ conn = new FakeConnection(), timers = makeFakeTimers(), ...options } = {}) {
  const errors = [];
  const db = new TagDb({
    conn,
    setTimeout: timers.setTimeout,
    clearTimeout: timers.clearTimeout,
    onError: (error) => errors.push(error),
    ...options,
  });
  await db.init();
  return { db, conn, timers, errors };
}
