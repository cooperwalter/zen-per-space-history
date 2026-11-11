import { createPerSpaceHistory } from "../../lib/Core.sys.mjs";
import { FakeConnection, RESULT_SOURCE, RESULT_TYPE } from "./helpers.mjs";

export function makeFakeUrlbar() {
  class FakeQuery {
    constructor(context = {}) {
      this.context = { userContextId: 0, isPrivate: false, pendingHeuristicProviders: new Set(), ...context };
      this.added = [];
    }

    add(provider, result) {
      this.context.pendingHeuristicProviders.delete(provider.name);
      if (this.canceled) {
        return;
      }
      this.added.push(result);
    }
  }
  const stockAdd = FakeQuery.prototype.add;
  const providers = [{ name: "FakeProvider" }];
  const ProvidersManager = { getInstanceForSap: () => ({ providers }) };
  return { Query: FakeQuery, ProvidersManager, RESULT_SOURCE, RESULT_TYPE, stockAdd };
}

export function makeFakeWindow({ isPrivate = false, spaces = ["space-a", "space-b"] } = {}) {
  return { isPrivate, spaces, handlers: null, detached: false };
}

export function makeFakeCompat(options = {}) {
  const urlbar = "urlbar" in options ? options.urlbar : makeFakeUrlbar();
  const prefValues = new Map(Object.entries(options.prefs ?? {}));
  const prefDefaults = new Map();
  const prefObservers = new Set();
  const timers = new Map();
  let nextTimer = 1;
  const state = {
    urlbar,
    now: options.now ?? 1_000_000_000_000,
    historyEnabled: true,
    formHistoryTerms: null,
    formHistoryRemoved: null,
    connections: [],
    openFailures: options.openFailures ?? 0,
    quarantined: [],
    quarantineRemovals: 0,
    noticeVisible: true,
    windowLookups: [],
    notifications: [],
    placesHandlers: null,
    containerDeleted: null,
    idleCallback: null,
    idleSeconds: null,
    blockers: [],
    blockerRemovals: 0,
    existingUrls: null,
    visitedPages: [],
    searchEngines: { "search.example": "q" },
    activeInfo: { userContextId: 0, spaceId: "space-a" },
    openWindows: [],
    removedObservers: 0,
  };

  const compat = {
    loadUrlbar() {
      if (options.loadUrlbarThrows) {
        throw new Error("module moved");
      }
      return state.urlbar;
    },
    prefs: {
      setDefaults(defaults) {
        for (const [name, value] of Object.entries(defaults)) {
          prefDefaults.set(name, value);
        }
      },
      get(name, fallback) {
        if (prefValues.has(name)) {
          return prefValues.get(name);
        }
        return prefDefaults.has(name) ? prefDefaults.get(name) : fallback;
      },
      observe(callback) {
        prefObservers.add(callback);
        return () => {
          prefObservers.delete(callback);
          state.removedObservers++;
        };
      },
      historyEnabled: () => state.historyEnabled,
    },
    db: {
      path: () => "/profile/per-space-history.sqlite",
      async open() {
        if (state.openFailures > 0) {
          state.openFailures--;
          throw new Error(options.openError ?? "file is not a database");
        }
        const conn = options.sharedConnection ?? new FakeConnection();
        if (options.sharedConnection) {
          conn.close = async () => {
            conn.closed = true;
          };
        }
        state.connections.push(conn);
        return conn;
      },
      shouldQuarantine: (error) => /not a database|corrupt|locked/.test(error.message),
      async quarantine(path) {
        state.quarantined.push(path);
        return `${path}.corrupt`;
      },
      async removeQuarantined() {
        state.quarantineRemovals++;
      },
    },
    timers: {
      setTimeout(callback, delayMs) {
        const id = nextTimer++;
        timers.set(id, { callback, delayMs });
        return id;
      },
      clearTimeout(id) {
        timers.delete(id);
      },
    },
    places: {
      observe(handlers) {
        state.placesHandlers = handlers;
        return () => {
          state.placesHandlers = null;
          state.removedObservers++;
        };
      },
      async existingUrls(urls) {
        return state.existingUrls ? new Set(urls.filter((url) => state.existingUrls.has(url))) : new Set(urls);
      },
      async visitedPages() {
        return state.visitedPages;
      },
    },
    formHistory: {
      observeRemoved(callback) {
        state.formHistoryRemoved = callback;
        return () => {
          state.formHistoryRemoved = null;
          state.removedObservers++;
        };
      },
      async searchTerms() {
        return state.formHistoryTerms;
      },
    },
    search: {
      parse(url) {
        const parsed = new URL(url);
        const param = state.searchEngines[parsed.hostname];
        const term = param ? parsed.searchParams.get(param) : null;
        return term ? { term, engineId: parsed.hostname } : null;
      },
    },
    containers: {
      observeDeleted(callback) {
        state.containerDeleted = callback;
        return () => {
          state.containerDeleted = null;
          state.removedObservers++;
        };
      },
    },
    idle: {
      observe(seconds, callback) {
        state.idleSeconds = seconds;
        state.idleCallback = callback;
        return () => {
          state.idleCallback = null;
          state.removedObservers++;
        };
      },
    },
    shutdown: {
      addBlocker(name, callback) {
        state.blockers.push({ name, callback });
        return () => {
          state.blockerRemovals++;
          state.blockers = state.blockers.filter((blocker) => blocker.callback !== callback);
        };
      },
    },
    windows: {
      attach(window, handlers) {
        if (window.isPrivate) {
          return () => {};
        }
        window.handlers = handlers;
        window.detached = false;
        return () => {
          window.handlers = null;
          window.detached = true;
        };
      },
      info(owner) {
        state.windowLookups.push(owner);
        return state.activeInfo;
      },
      spaceIds: (window) => window.spaces,
      openBrowserWindows: () => state.openWindows,
    },
    notify(message) {
      if (!state.noticeVisible) {
        return false;
      }
      state.notifications.push(message);
      return true;
    },
    now: () => state.now,
  };

  const control = {
    state,
    setPref(name, value) {
      prefValues.set(name, value);
      for (const observer of [...prefObservers]) {
        observer(name);
      }
    },
    timerDelays: () => [...timers.values()].map((timer) => timer.delayMs),
    async fireTimers(delayMs) {
      const due = [...timers.entries()].filter(([, timer]) => delayMs === undefined || timer.delayMs === delayMs);
      for (const [id, timer] of due) {
        timers.delete(id);
        await timer.callback();
      }
    },
    connection: () => state.connections.at(-1),
    rows(sql) {
      return state.connections.at(-1).rows(sql);
    },
  };

  return { compat, control };
}

export async function makeRunningMod(options = {}) {
  const { compat, control } = makeFakeCompat(options);
  const mod = createPerSpaceHistory(compat);
  await mod.init();
  return { mod, compat, control, urlbar: control.state.urlbar };
}

export async function settle() {
  for (let turn = 0; turn < 20; turn++) {
    await new Promise((resolve) => setImmediate(resolve));
  }
}
