const PREF_BRANCH = "zen.perSpaceHistory.";
const DB_FILE = "per-space-history.sqlite";
const BROWSER_WINDOW = "navigator:browser";
const SPACES_EVENT = "ZenWorkspaceDataChanged";
const SPACE_ATTRIBUTE = "zen-workspace-id";
const CONTAINER_DELETED_TOPIC = "contextual-identity-deleted";
const DELAYED_STARTUP_TOPIC = "browser-delayed-startup-finished";

const URLBAR_MANAGER_URLS = [
  "moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs",
  "resource:///modules/UrlbarProvidersManager.sys.mjs",
];
const URLBAR_CONSTANT_SOURCES = [
  ["chrome://browser/content/urlbar/UrlbarShared.mjs", "UrlbarShared"],
  ["moz-src:///browser/components/urlbar/UrlbarUtils.sys.mjs", "UrlbarUtils"],
  ["resource:///modules/UrlbarUtils.sys.mjs", "UrlbarUtils"],
];
const SEARCH_SERVICE_URLS = [
  "moz-src:///toolkit/components/search/SearchService.sys.mjs",
  "resource://gre/modules/SearchService.sys.mjs",
];

function importFirst(urls) {
  for (const url of urls) {
    try {
      return ChromeUtils.importESModule(url);
    } catch {}
  }
  return null;
}

const lazy = {};
ChromeUtils.defineESModuleGetters(lazy, {
  AsyncShutdown: "resource://gre/modules/AsyncShutdown.sys.mjs",
  PlacesUtils: "resource://gre/modules/PlacesUtils.sys.mjs",
  PrivateBrowsingUtils: "resource://gre/modules/PrivateBrowsingUtils.sys.mjs",
  Sqlite: "resource://gre/modules/Sqlite.sys.mjs",
  clearTimeout: "resource://gre/modules/Timer.sys.mjs",
  setTimeout: "resource://gre/modules/Timer.sys.mjs",
});

export function loadUrlbar() {
  const manager = importFirst(URLBAR_MANAGER_URLS);
  if (!manager) {
    return null;
  }
  let constants = null;
  for (const [url, exportName] of URLBAR_CONSTANT_SOURCES) {
    const candidate = importFirst([url])?.[exportName];
    if (candidate?.RESULT_SOURCE && candidate?.RESULT_TYPE) {
      constants = candidate;
      break;
    }
  }
  return {
    Query: manager.Query,
    ProvidersManager: manager.ProvidersManager,
    RESULT_SOURCE: constants?.RESULT_SOURCE ?? null,
    RESULT_TYPE: constants?.RESULT_TYPE ?? null,
  };
}

export const prefs = {
  setDefaults(defaults) {
    const branch = Services.prefs.getDefaultBranch(PREF_BRANCH);
    for (const [name, value] of Object.entries(defaults)) {
      if (typeof value === "boolean") {
        branch.setBoolPref(name, value);
      } else {
        branch.setStringPref(name, String(value));
      }
    }
  },

  get(name, fallback) {
    try {
      if (typeof fallback === "boolean") {
        return Services.prefs.getBoolPref(PREF_BRANCH + name, fallback);
      }
      return Services.prefs.getStringPref(PREF_BRANCH + name, fallback);
    } catch {
      return fallback;
    }
  },

  observe(callback) {
    const observer = {
      observe(subject, topic, data) {
        callback(data.slice(PREF_BRANCH.length));
      },
    };
    Services.prefs.addObserver(PREF_BRANCH, observer);
    return () => Services.prefs.removeObserver(PREF_BRANCH, observer);
  },

  historyEnabled() {
    return Services.prefs.getBoolPref("places.history.enabled", true);
  },

  formHistoryExpireDays() {
    return Services.prefs.getIntPref("browser.formfill.expire_days", 180);
  },
};

export const db = {
  path() {
    return PathUtils.join(PathUtils.profileDir, DB_FILE);
  },

  open(path) {
    return lazy.Sqlite.openConnection({ path });
  },

  async quarantine(path) {
    const target = path.replace(/\.sqlite$/, `.corrupt-${Date.now()}.sqlite`);
    if (await IOUtils.exists(path)) {
      await IOUtils.move(path, target);
    }
    for (const suffix of ["-wal", "-shm", "-journal"]) {
      await IOUtils.remove(path + suffix, { ignoreAbsent: true });
    }
    return target;
  },
};

export const timers = {
  setTimeout: (callback, delayMs) => lazy.setTimeout(callback, delayMs),
  clearTimeout: (id) => lazy.clearTimeout(id),
};

export const places = {
  observe({ onPageRemoved, onHistoryCleared }) {
    const types = ["page-removed", "history-cleared"];
    const listener = (events) => {
      for (const event of events) {
        if (event.type === "history-cleared") {
          onHistoryCleared();
        } else if (event.type === "page-removed" && event.isRemovedFromStore) {
          onPageRemoved(event.url);
        }
      }
    };
    PlacesObservers.addListener(types, listener);
    return () => PlacesObservers.removeListener(types, listener);
  },

  async existingUrls(urls) {
    const connection = await lazy.PlacesUtils.promiseDBConnection();
    const placeholders = urls.map(() => "hash(?)").join(", ");
    const rows = await connection.execute(`SELECT url FROM moz_places WHERE url_hash IN (${placeholders})`, urls);
    return new Set(rows.map((row) => row.getResultByName("url")));
  },

  async visitedPages(sinceMs) {
    const connection = await lazy.PlacesUtils.promiseDBConnection();
    const rows = await connection.execute(
      `SELECT url, last_visit_date FROM moz_places
       WHERE last_visit_date >= :since AND visit_count > 0 AND hidden = 0`,
      { since: sinceMs * 1000 }
    );
    return rows.map((row) => ({
      url: row.getResultByName("url"),
      lastVisit: Math.floor(row.getResultByName("last_visit_date") / 1000),
    }));
  },
};

let searchService;

function getSearchService() {
  if (searchService === undefined) {
    searchService = importFirst(SEARCH_SERVICE_URLS)?.SearchService ?? Services.search ?? null;
  }
  return searchService;
}

export const search = {
  parse(url) {
    const service = getSearchService();
    if (!service || !(service.hasSuccessfullyInitialized ?? service.isInitialized)) {
      return null;
    }
    const parsed = service.parseSubmissionURL(url);
    if (!parsed?.engine || !parsed.terms) {
      return null;
    }
    return { term: parsed.terms, engineId: parsed.engine.id ?? parsed.engine.name ?? null };
  },
};

export const containers = {
  observeDeleted(callback) {
    const observer = {
      observe(subject) {
        const userContextId = subject?.wrappedJSObject?.userContextId;
        if (typeof userContextId === "number") {
          callback(userContextId);
        }
      },
    };
    Services.obs.addObserver(observer, CONTAINER_DELETED_TOPIC);
    return () => Services.obs.removeObserver(observer, CONTAINER_DELETED_TOPIC);
  },
};

export const idle = {
  observe(seconds, callback) {
    const service = Cc["@mozilla.org/widget/useridleservice;1"].getService(Ci.nsIUserIdleService);
    const observer = {
      observe(subject, topic) {
        if (topic === "idle") {
          callback();
        }
      },
    };
    service.addIdleObserver(observer, seconds);
    return () => service.removeIdleObserver(observer, seconds);
  },
};

export const shutdown = {
  addBlocker(name, callback) {
    lazy.AsyncShutdown.profileBeforeChange.addBlocker(name, callback);
    return () => {
      try {
        lazy.AsyncShutdown.profileBeforeChange.removeBlocker(callback);
      } catch {}
    };
  },
};

function tabDetails(window, browser) {
  const tab = window.gBrowser.getTabForBrowser(browser);
  let userContextId = tab?.userContextId;
  if (typeof userContextId !== "number") {
    userContextId = parseInt(browser.getAttribute("usercontextid"), 10) || 0;
  }
  return { userContextId, spaceId: tab?.getAttribute(SPACE_ATTRIBUTE) || "" };
}

function whenBrowserReady(window, callback) {
  if (window.gBrowser?.addTabsProgressListener) {
    callback();
    return () => {};
  }
  const observer = {
    observe(subject) {
      if (subject === window) {
        Services.obs.removeObserver(observer, DELAYED_STARTUP_TOPIC);
        observer.done = true;
        callback();
      }
    },
  };
  Services.obs.addObserver(observer, DELAYED_STARTUP_TOPIC);
  return () => {
    if (!observer.done) {
      observer.done = true;
      Services.obs.removeObserver(observer, DELAYED_STARTUP_TOPIC);
    }
  };
}

export const windows = {
  attach(window, { onVisit, onSpacesChanged }) {
    if (lazy.PrivateBrowsingUtils.isWindowPrivate(window)) {
      return () => {};
    }
    const listener = {
      onLocationChange(browser, webProgress, request, location, flags) {
        if (!webProgress.isTopLevel) {
          return;
        }
        if (flags & Ci.nsIWebProgressListener.LOCATION_CHANGE_ERROR_PAGE) {
          return;
        }
        if (!lazy.PlacesUtils.history.canAddURI(location)) {
          return;
        }
        const { userContextId, spaceId } = tabDetails(window, browser);
        onVisit({ url: location.spec, userContextId, spaceId, time: Date.now() });
      },
    };
    let listening = false;
    const cancelWait = whenBrowserReady(window, () => {
      window.gBrowser.addTabsProgressListener(listener);
      listening = true;
    });
    window.addEventListener(SPACES_EVENT, onSpacesChanged);
    return () => {
      cancelWait();
      window.removeEventListener(SPACES_EVENT, onSpacesChanged);
      if (listening) {
        listening = false;
        try {
          window.gBrowser?.removeTabsProgressListener(listener);
        } catch {}
      }
    };
  },

  activeInfo() {
    const window = Services.wm.getMostRecentWindow(BROWSER_WINDOW);
    const tab = window?.gBrowser?.selectedTab;
    if (!tab) {
      return null;
    }
    return {
      userContextId: typeof tab.userContextId === "number" ? tab.userContextId : 0,
      spaceId: window.gZenWorkspaces?.activeWorkspace || "",
    };
  },

  spaceIds(window) {
    const spaces = window.gZenWorkspaces?.getWorkspaces?.();
    if (!Array.isArray(spaces)) {
      return null;
    }
    return spaces.map((space) => space.uuid).filter(Boolean);
  },

  openBrowserWindows() {
    return [...Services.wm.getEnumerator(BROWSER_WINDOW)].filter((window) => !window.closed);
  },
};

export function notify(message) {
  console.warn("[PerSpaceHistory]", message);
  const window = Services.wm.getMostRecentWindow(BROWSER_WINDOW);
  const box = window?.gNotificationBox;
  if (!box) {
    return;
  }
  Promise.resolve(
    box.appendNotification("per-space-history-notice", { label: message, priority: box.PRIORITY_WARNING_LOW }, [])
  ).catch(() => {});
}

export function now() {
  return Date.now();
}
