import { TagStore } from "./TagStore.sys.mjs";
import { TagDb } from "./TagDb.sys.mjs";
import { createFilter } from "./Filter.sys.mjs";
import { createScopeResolver } from "./ScopeResolver.sys.mjs";
import { createLog } from "./Log.sys.mjs";
import { pageKey, originKeys, normalizeTerm } from "./UrlKey.sys.mjs";

export const ORIGINAL_ADD = Symbol.for("perSpaceHistory.originalAdd");
export const PAGE_BUDGET = 200000;

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

const ENUMS = Object.freeze({
  scope: ["container", "space"],
  untaggedVisibility: ["everywhere", "noContainerOnly", "nowhere"],
});

const DAY_MS = 24 * 60 * 60 * 1000;
const GC_INTERVAL_MS = 7 * DAY_MS;
const GC_BATCH = 500;
const GC_MIN_AGE_MS = 60 * 60 * 1000;
const IDLE_SECONDS = 300;
const ORPHAN_CHECK_MS = 1000;
const SPACE_CONFIRM_MS = 2000;
const SUMMARY_DELAY_MS = 300;
const EARLY_QUEUE_LIMIT = 5000;

const INACTIVE_MESSAGE = "Per-Space History is inactive on this browser version";
const CORRUPT_MESSAGE = "Per-Space History: the tag database was unreadable and has been reset";

export function createPerSpaceHistory(compat) {
  let active = false;
  let ready = false;
  let store = new TagStore();
  let db = null;
  let earlyQueue = [];
  let config = { ...DEFAULT_CONFIG };
  let urlbar = null;
  let filter = null;
  let patchedAdd = null;
  let override = null;
  let lifecycle = Promise.resolve();
  let readyPromise = Promise.resolve();
  let syncCleanups = [];
  let orphanTimer = null;
  let summaryTimer = null;
  let pendingSummaries = new Map();
  const counters = { dropped: 0, recorded: 0 };
  const attached = new Map();
  const spacesByWindow = new Map();
  const notified = new Set();

  const log = createLog({ isDebug: () => config.debug });

  const resolver = createScopeResolver({
    getConfig: () => override?.config ?? config,
    getActiveWindowInfo: () => {
      try {
        return compat.windows.activeInfo();
      } catch (error) {
        log.errorOnce("activeInfo", error);
        return null;
      }
    },
  });

  function readConfig() {
    const next = {};
    for (const [name, fallback] of Object.entries(DEFAULT_CONFIG)) {
      let value = compat.prefs.get(name, fallback);
      if (ENUMS[name] && !ENUMS[name].includes(value)) {
        value = fallback;
      }
      next[name] = value;
    }
    return next;
  }

  function notifyOnce(key, message) {
    if (notified.has(key)) {
      return;
    }
    notified.add(key);
    try {
      compat.notify(message);
    } catch (error) {
      log.error("notify failed", error);
    }
  }

  function noteDrop(context, provider, result) {
    if (!config.debug) {
      return;
    }
    let summary = pendingSummaries.get(context);
    if (!summary) {
      summary = { search: context?.searchString, userContextId: context?.userContextId, total: 0, providers: {} };
      pendingSummaries.set(context, summary);
    }
    summary.total++;
    const name = provider?.name ?? "unknown";
    summary.providers[name] = (summary.providers[name] ?? 0) + 1;
    log.debug("drop", name, result?.payload?.url ?? result?.payload?.suggestion);
    if (summaryTimer === null) {
      summaryTimer = compat.timers.setTimeout(() => {
        summaryTimer = null;
        const summaries = pendingSummaries;
        pendingSummaries = new Map();
        for (const entry of summaries.values()) {
          log.debug(`query "${entry.search}" in container ${entry.userContextId}: dropped ${entry.total}`, entry.providers);
        }
      }, SUMMARY_DELAY_MS);
    }
  }

  function restoreOriginalAdd(Query) {
    const original = Query.prototype[ORIGINAL_ADD];
    if (original) {
      Query.prototype.add = original;
      delete Query.prototype[ORIGINAL_ADD];
    }
  }

  function installPatch() {
    let loaded = null;
    try {
      loaded = compat.loadUrlbar();
    } catch (error) {
      log.error("could not load the address bar modules", error);
    }
    const Query = loaded?.Query;
    if (typeof Query?.prototype?.add !== "function" || !loaded.RESULT_SOURCE || !loaded.RESULT_TYPE) {
      log.error("Query.prototype.add is not available; address-bar filtering is off, tagging continues");
      notifyOnce("inactive", INACTIVE_MESSAGE);
      return;
    }
    urlbar = loaded;
    if (patchedAdd && Query.prototype.add === patchedAdd) {
      return;
    }
    restoreOriginalAdd(Query);

    filter = createFilter({
      getStore: () => override?.store ?? store,
      getConfig: () => override?.config ?? config,
      resolveScope: (context) => resolver.current(context),
      isReady: () => (override ? true : ready),
      RESULT_SOURCE: loaded.RESULT_SOURCE,
      RESULT_TYPE: loaded.RESULT_TYPE,
    });

    const original = Query.prototype.add;
    const activeFilter = filter;
    patchedAdd = function (provider, result) {
      try {
        if (activeFilter.shouldDrop(this.context, provider, result)) {
          this.context.pendingHeuristicProviders?.delete(provider.name);
          counters.dropped++;
          noteDrop(this.context, provider, result);
          return undefined;
        }
      } catch (error) {
        log.errorOnce("filter", error);
      }
      return original.call(this, provider, result);
    };
    Query.prototype[ORIGINAL_ADD] = original;
    Query.prototype.add = patchedAdd;
  }

  function removePatch() {
    const Query = urlbar?.Query;
    if (Query && patchedAdd && Query.prototype.add === patchedAdd) {
      restoreOriginalAdd(Query);
    }
    patchedAdd = null;
    filter = null;
  }

  function persist(kind, key, userContextId, spaceId, time, extra) {
    if (db) {
      db.enqueue(kind, key, userContextId, spaceId, time, extra);
    } else if (earlyQueue.length < EARLY_QUEUE_LIMIT) {
      earlyQueue.push([kind, key, userContextId, spaceId, time, extra]);
    }
  }

  function tag(kind, key, userContextId, spaceId, time, extra) {
    store.add(kind, key, userContextId, spaceId);
    persist(kind, key, userContextId, spaceId, time, extra);
  }

  function canRecord() {
    return active && config.tagging && compat.prefs.historyEnabled();
  }

  function recordSearch({ term, engineId = null, userContextId = 0, spaceId = "", time = compat.now() }) {
    if (!canRecord()) {
      return;
    }
    const normalized = normalizeTerm(term);
    if (!normalized) {
      return;
    }
    tag("term", normalized, userContextId, spaceId ?? "", time, { engineId });
  }

  function recordVisit({ url, userContextId = 0, spaceId = "", time = compat.now() }) {
    if (!canRecord() || typeof url !== "string" || !url) {
      return;
    }
    const space = spaceId ?? "";
    tag("page", pageKey(url), userContextId, space, time);
    for (const origin of originKeys(url)) {
      tag("origin", origin, userContextId, space, time);
    }
    counters.recorded++;
    let search = null;
    try {
      search = compat.search.parse(url);
    } catch (error) {
      log.errorOnce("search.parse", error);
    }
    if (search?.term) {
      recordSearch({ term: search.term, engineId: search.engineId, userContextId, spaceId: space, time });
    }
  }

  async function openDatabase(path) {
    const conn = await compat.db.open(path);
    const next = new TagDb({
      conn,
      setTimeout: compat.timers.setTimeout,
      clearTimeout: compat.timers.clearTimeout,
      onError: (error) => log.errorOnce("flush", error),
    });
    try {
      await next.init();
      await next.loadInto(store);
    } catch (error) {
      await conn.close().catch(() => {});
      throw error;
    }
    return next;
  }

  function rebuildStoreFromEarlyQueue() {
    store = new TagStore();
    for (const [kind, key, userContextId, spaceId] of earlyQueue) {
      store.add(kind, key, userContextId, spaceId);
    }
  }

  async function startAsync() {
    if (!active || db) {
      return;
    }
    const path = compat.db.path();
    let opened = null;
    try {
      opened = await openDatabase(path);
    } catch (error) {
      log.error("tag database is unusable; moving it aside and starting empty", error);
      rebuildStoreFromEarlyQueue();
      try {
        await compat.db.quarantine(path);
      } catch (quarantineError) {
        log.error("could not move the unusable database aside", quarantineError);
      }
      notifyOnce("corrupt", CORRUPT_MESSAGE);
      try {
        opened = await openDatabase(path);
      } catch (retryError) {
        log.error("still cannot open a tag database; tags will not persist this session", retryError);
        rebuildStoreFromEarlyQueue();
      }
    }
    if (!active) {
      await opened?.close().catch(() => {});
      return;
    }
    db = opened;
    if (db) {
      for (const row of earlyQueue) {
        db.enqueue(...row);
      }
    }
    earlyQueue = [];
    ready = true;
    log.debug("ready", store.stats());
  }

  async function stopAsync() {
    const closing = db;
    db = null;
    if (closing) {
      await closing.close();
    }
  }

  function chain(task, label) {
    lifecycle = lifecycle.then(task).catch((error) => log.error(`${label} failed`, error));
    return lifecycle;
  }

  async function whenReady() {
    await readyPromise;
    return ready;
  }

  async function onPageRemoved(url) {
    store.removeKey("page", pageKey(url));
    if (await whenReady()) {
      await db?.deleteKey("page", pageKey(url));
    }
  }

  async function onHistoryCleared() {
    store.clear();
    earlyQueue = [];
    if (await whenReady()) {
      store.clear();
      await db?.clearAll();
    }
  }

  async function forgetScope({ userContextId, spaceId } = {}) {
    const hasContainer = typeof userContextId === "number";
    const hasSpace = typeof spaceId === "string" && spaceId !== "";
    if (hasContainer === hasSpace) {
      throw new Error("forgetScope needs exactly one of { userContextId } or { spaceId }");
    }
    const dim = hasSpace ? "s" : "c";
    const id = hasSpace ? spaceId : userContextId;
    let removed = store.removeScope(dim, id);
    earlyQueue = earlyQueue.filter((row) => (hasSpace ? row[3] !== id : row[2] !== id));
    if (await whenReady()) {
      removed += store.removeScope(dim, id);
      await db?.deleteScope(dim, id);
    }
    return removed;
  }

  function background(promise, label) {
    promise.catch((error) => log.error(`${label} failed`, error));
  }

  function spaceStillListed(spaceId) {
    for (const window of attached.keys()) {
      let ids = null;
      try {
        ids = compat.windows.spaceIds(window);
      } catch {
        return true;
      }
      if (!ids || !ids.length || ids.includes(spaceId)) {
        return true;
      }
    }
    return attached.size === 0;
  }

  function onSpacesChanged(window) {
    let current = null;
    try {
      current = compat.windows.spaceIds(window);
    } catch (error) {
      log.errorOnce("spaceIds", error);
    }
    if (!current || !current.length) {
      return;
    }
    const previous = spacesByWindow.get(window) ?? new Set();
    spacesByWindow.set(window, new Set(current));
    const removed = [...previous].filter((id) => !current.includes(id));
    if (!removed.length) {
      return;
    }
    compat.timers.setTimeout(() => {
      for (const spaceId of removed) {
        if (active && !spaceStillListed(spaceId)) {
          log.debug("Space deleted, forgetting its tags", spaceId);
          background(forgetScope({ spaceId }), "forgetting a deleted Space");
        }
      }
    }, SPACE_CONFIRM_MS);
  }

  async function gc() {
    if (!(await whenReady()) || !db) {
      return null;
    }
    const target = db;
    const now = compat.now();
    await target.flush();
    const summary = { pagesChecked: 0, pagesRemoved: 0, termsExpired: 0, rowsPruned: 0 };

    let after = "";
    for (;;) {
      const urls = await target.pageUrlsAfter(after, GC_BATCH, now - GC_MIN_AGE_MS);
      if (!urls.length) {
        break;
      }
      after = urls[urls.length - 1];
      summary.pagesChecked += urls.length;
      const existing = await compat.places.existingUrls(urls);
      const missing = urls.filter((url) => !existing.has(url));
      if (missing.length) {
        await target.deletePages(missing);
        for (const url of missing) {
          store.removeKey("page", url);
        }
        summary.pagesRemoved += missing.length;
      }
    }

    const cutoff = now - compat.prefs.formHistoryExpireDays() * DAY_MS;
    for (const row of await target.expireTerms(cutoff)) {
      store.removeTag("term", row.key, row.userContextId, row.spaceId);
      summary.termsExpired++;
    }

    for (const row of await target.enforceBudget("page", PAGE_BUDGET)) {
      store.removeTag("page", row.key, row.userContextId, row.spaceId);
      summary.rowsPruned++;
    }

    await target.setMeta("last_gc", now);
    log.debug("gc", summary);
    return summary;
  }

  async function gcIfDue() {
    if (!(await whenReady()) || !db) {
      return;
    }
    const last = Number(await db.getMeta("last_gc")) || 0;
    if (compat.now() - last >= GC_INTERVAL_MS) {
      await gc();
    }
  }

  function startSync() {
    compat.prefs.setDefaults(DEFAULT_CONFIG);
    config = readConfig();
    syncCleanups.push(
      compat.prefs.observe(() => {
        config = readConfig();
        log.debug("config changed", config);
      })
    );
    installPatch();
    syncCleanups.push(
      compat.places.observe({
        onPageRemoved: (url) => background(onPageRemoved(url), "page-removed cleanup"),
        onHistoryCleared: () => background(onHistoryCleared(), "history-cleared cleanup"),
      })
    );
    syncCleanups.push(
      compat.containers.observeDeleted((userContextId) =>
        background(forgetScope({ userContextId }), "container-deleted cleanup")
      )
    );
    syncCleanups.push(compat.idle.observe(IDLE_SECONDS, () => background(gcIfDue(), "idle GC")));
    syncCleanups.push(compat.shutdown.addBlocker("PerSpaceHistory: flush and close the tag database", () => shutdown()));
  }

  function stopSync() {
    removePatch();
    for (const cleanup of syncCleanups.splice(0)) {
      try {
        cleanup?.();
      } catch (error) {
        log.error("cleanup failed", error);
      }
    }
    for (const timer of [orphanTimer, summaryTimer]) {
      if (timer !== null) {
        compat.timers.clearTimeout(timer);
      }
    }
    orphanTimer = null;
    summaryTimer = null;
    pendingSummaries = new Map();
    for (const [window, detach] of attached) {
      try {
        detach();
      } catch (error) {
        log.error("window detach failed", error);
      }
      spacesByWindow.delete(window);
    }
    attached.clear();
    ready = false;
    store = new TagStore();
    earlyQueue = [];
  }

  function init() {
    if (active) {
      return readyPromise;
    }
    active = true;
    try {
      startSync();
    } catch (error) {
      log.error("startup failed", error);
    }
    readyPromise = chain(startAsync, "startup");
    return readyPromise;
  }

  function shutdown() {
    if (!active) {
      return lifecycle;
    }
    active = false;
    stopSync();
    return chain(stopAsync, "shutdown");
  }

  function attachWindow(window) {
    init();
    if (attached.has(window)) {
      return;
    }
    if (orphanTimer !== null) {
      compat.timers.clearTimeout(orphanTimer);
      orphanTimer = null;
    }
    let detach = () => {};
    try {
      detach =
        compat.windows.attach(window, {
          onVisit: (visit) => {
            try {
              recordVisit(visit);
            } catch (error) {
              log.errorOnce("recordVisit", error);
            }
          },
          onSpacesChanged: () => onSpacesChanged(window),
        }) ?? detach;
    } catch (error) {
      log.error("could not attach to a window", error);
    }
    attached.set(window, detach);
    try {
      const ids = compat.windows.spaceIds(window);
      if (ids?.length) {
        spacesByWindow.set(window, new Set(ids));
      }
    } catch (error) {
      log.errorOnce("spaceIds", error);
    }
  }

  function detachWindow(window) {
    const detach = attached.get(window);
    if (!detach) {
      return;
    }
    attached.delete(window);
    spacesByWindow.delete(window);
    try {
      detach();
    } catch (error) {
      log.error("window detach failed", error);
    }
    if (attached.size === 0 && active && orphanTimer === null) {
      orphanTimer = compat.timers.setTimeout(() => {
        orphanTimer = null;
        let open = [];
        try {
          open = compat.windows.openBrowserWindows();
        } catch (error) {
          log.errorOnce("openBrowserWindows", error);
        }
        if (active && attached.size === 0 && open.length > 0) {
          log.debug("no window runs the mod's script any more; shutting down");
          shutdown();
        }
      }, ORPHAN_CHECK_MS);
    }
  }

  function stats() {
    const index = store.stats();
    return {
      pages: index.pages,
      origins: index.origins,
      terms: index.terms,
      rows: index.rows,
      dropped: counters.dropped,
      recorded: counters.recorded,
      scopes: index.scopes,
      active,
      ready,
      patched: !!patchedAdd && urlbar?.Query?.prototype?.add === patchedAdd,
      persistent: !!db,
      pendingWrites: db ? db.pendingCount : earlyQueue.length,
      windows: attached.size,
      config: { ...config },
    };
  }

  function explain(input) {
    const text = String(input ?? "");
    const activeInfo = resolver.current({});
    return {
      page: store.scopesOf("page", pageKey(text)),
      origins: Object.fromEntries(originKeys(text).map((key) => [key, store.scopesOf("origin", key)])),
      term: store.scopesOf("term", normalizeTerm(text)),
      currentScope: activeInfo ? { dim: activeInfo.dim, id: activeInfo.id } : null,
    };
  }

  async function backfill({ userContextId, spaceId = "", sinceDays = 90 } = {}) {
    if (typeof userContextId !== "number" || !Number.isInteger(userContextId) || userContextId < 0) {
      throw new Error("backfill needs { userContextId } as a non-negative integer");
    }
    if (!(await whenReady())) {
      throw new Error("Per-Space History is not running");
    }
    const since = compat.now() - sinceDays * DAY_MS;
    const pages = await compat.places.visitedPages(since);
    let tagged = 0;
    for (const page of pages) {
      if (store.hasAny("page", pageKey(page.url))) {
        continue;
      }
      const time = page.lastVisit || compat.now();
      tag("page", pageKey(page.url), userContextId, spaceId, time);
      for (const origin of originKeys(page.url)) {
        tag("origin", origin, userContextId, spaceId, time);
      }
      tagged++;
    }
    await db?.flush();
    return { scanned: pages.length, tagged };
  }

  async function exportJSON() {
    if (!(await whenReady()) || !db) {
      return JSON.stringify({ schemaVersion: null, pages: [], origins: [], terms: [] });
    }
    await db.flush();
    return JSON.stringify(await db.exportAll(), null, 2);
  }

  function selfTest() {
    const Query = urlbar?.Query;
    if (!Query || !patchedAdd || Query.prototype.add !== patchedAdd) {
      const report = { ok: false, passed: 0, failed: 1, results: [{ name: "Query.prototype.add is patched", ok: false }] };
      log.error("selfTest", report);
      return report;
    }
    const { RESULT_SOURCE, RESULT_TYPE } = urlbar;
    let provider = { name: "PerSpaceHistorySelfTest" };
    try {
      provider = urlbar.ProvidersManager?.getInstanceForSap?.("urlbar")?.providers?.[0] ?? provider;
    } catch {}

    const testStore = new TagStore();
    const pageUrl = "https://selftest.invalid/work-only";
    testStore.add("page", pageUrl, 1, "selftest-space-a");
    testStore.add("origin", "https://selftest.invalid", 1, "selftest-space-a");
    testStore.add("origin", "selftest.invalid", 1, "selftest-space-a");
    testStore.add("term", "alpha zebra", 1, "selftest-space-a");

    const page = { type: RESULT_TYPE.URL, source: RESULT_SOURCE.HISTORY, payload: { url: pageUrl } };
    const bookmark = { type: RESULT_TYPE.URL, source: RESULT_SOURCE.BOOKMARKS, payload: { url: pageUrl } };
    const untagged = { type: RESULT_TYPE.URL, source: RESULT_SOURCE.HISTORY, payload: { url: "https://selftest.invalid/never-seen" } };
    const term = {
      type: RESULT_TYPE.SEARCH,
      source: RESULT_SOURCE.HISTORY,
      payload: { suggestion: "Alpha Zebra", lowerCaseSuggestion: "alpha zebra" },
    };
    const autofill = {
      type: RESULT_TYPE.URL,
      source: RESULT_SOURCE.HISTORY,
      heuristic: true,
      autofill: { type: "origin", value: "selftest.invalid/" },
      payload: { url: "https://selftest.invalid/" },
    };

    const cases = [
      { name: "history page shows in the container it was visited in", result: page, userContextId: 1, drop: false },
      { name: "history page is hidden in another container", result: page, userContextId: 2, drop: true },
      { name: "bookmark shows in another container", result: bookmark, userContextId: 2, drop: false },
      { name: "untagged history page shows (untaggedVisibility=everywhere)", result: untagged, userContextId: 2, drop: false },
      { name: "search term shows in the container it was searched in", result: term, userContextId: 1, drop: false },
      { name: "search term is hidden in another container", result: term, userContextId: 2, drop: true },
      { name: "origin autofill shows in the container it was visited in", result: autofill, userContextId: 1, drop: false },
      { name: "origin autofill is hidden in another container", result: autofill, userContextId: 2, drop: true, heuristic: true },
      { name: "private-window query is never filtered", result: page, userContextId: 2, isPrivate: true, drop: false },
    ];

    const results = [];
    const droppedBefore = counters.dropped;
    override = { store: testStore, config: { ...DEFAULT_CONFIG } };
    try {
      for (const testCase of cases) {
        const pending = new Set([provider.name]);
        const query = {
          context: {
            userContextId: testCase.userContextId,
            isPrivate: !!testCase.isPrivate,
            pendingHeuristicProviders: pending,
            searchString: "selftest",
          },
          canceled: true,
        };
        const before = counters.dropped;
        let error = null;
        try {
          Query.prototype.add.call(query, provider, testCase.result);
        } catch (thrown) {
          error = thrown;
        }
        const dropped = counters.dropped > before;
        let ok = dropped === testCase.drop && (!error || !dropped);
        if (testCase.heuristic) {
          ok &&= !pending.has(provider.name);
        }
        results.push({ name: testCase.name, ok, expected: testCase.drop ? "drop" : "keep", actual: dropped ? "drop" : "keep" });
      }
    } finally {
      override = null;
      counters.dropped = droppedBefore;
    }

    const failed = results.filter((entry) => !entry.ok).length;
    const report = { ok: failed === 0, passed: results.length - failed, failed, results };
    for (const entry of results) {
      log.info(`selfTest ${entry.ok ? "PASS" : "FAIL"}: ${entry.name} (expected ${entry.expected}, got ${entry.actual})`);
    }
    log.info(`selfTest ${report.ok ? "passed" : "FAILED"}: ${report.passed}/${results.length}`);
    return report;
  }

  return {
    init,
    shutdown,
    attachWindow,
    detachWindow,
    recordVisit,
    recordSearch,
    stats,
    explain,
    backfill,
    forgetScope,
    exportJSON,
    selfTest,
    gc,
    get ready() {
      return readyPromise;
    },
  };
}
