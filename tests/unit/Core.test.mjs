import { test } from "node:test";
import assert from "node:assert/strict";
import { createPerSpaceHistory, ORIGINAL_ADD } from "../../lib/Core.sys.mjs";
import { FakeConnection, RESULT_SOURCE, RESULT_TYPE, makeHistoryResult, makeAutofillResult } from "./helpers.mjs";
import { makeFakeCompat, makeFakeUrlbar, makeFakeWindow, makeRunningMod, settle } from "./fakeCompat.mjs";

const WORK_URL = "https://example.org/work-only";
const PROVIDER = { name: "FakeProvider" };

function addThroughQuery(urlbar, context, result, provider = PROVIDER) {
  const query = new urlbar.Query(context);
  query.add(provider, result);
  return query;
}

test("init replaces Query.prototype.add and keeps the stock method under Symbol.for('perSpaceHistory.originalAdd')", async () => {
  const { urlbar } = await makeRunningMod();
  assert.notEqual(urlbar.Query.prototype.add, urlbar.stockAdd);
  assert.equal(urlbar.Query.prototype[ORIGINAL_ADD], urlbar.stockAdd);
  assert.equal(Symbol.for("perSpaceHistory.originalAdd"), ORIGINAL_ADD);
});

test("a history result tagged only in another container never reaches the stock add", async () => {
  const { mod, urlbar } = await makeRunningMod();
  mod.recordVisit({ url: WORK_URL, userContextId: 1, spaceId: "space-a" });
  const query = addThroughQuery(urlbar, { userContextId: 2 }, makeHistoryResult(WORK_URL));
  assert.deepEqual(query.added, []);
  assert.equal(mod.stats().dropped, 1);
});

test("a history result tagged in the current container is passed to the stock add", async () => {
  const { mod, urlbar } = await makeRunningMod();
  mod.recordVisit({ url: WORK_URL, userContextId: 1, spaceId: "space-a" });
  const result = makeHistoryResult(WORK_URL);
  const query = addThroughQuery(urlbar, { userContextId: 1 }, result);
  assert.deepEqual(query.added, [result]);
});

test("dropping a heuristic autofill result removes its provider from pendingHeuristicProviders", async () => {
  const { mod, urlbar } = await makeRunningMod();
  mod.recordVisit({ url: "https://example.net/", userContextId: 2, spaceId: "space-b" });
  const pendingHeuristicProviders = new Set(["FakeProvider", "OtherProvider"]);
  const query = addThroughQuery(
    urlbar,
    { userContextId: 1, pendingHeuristicProviders },
    makeAutofillResult("https://example.net/", "origin")
  );
  assert.deepEqual(query.added, []);
  assert.deepEqual([...pendingHeuristicProviders], ["OtherProvider"]);
});

test("a result whose inspection throws inside the filter is kept and passed to the stock add", async () => {
  const { urlbar } = await makeRunningMod();
  const result = {
    type: RESULT_TYPE.URL,
    get source() {
      throw new Error("exploding result");
    },
    payload: {},
  };
  const query = addThroughQuery(urlbar, { userContextId: 1 }, result);
  assert.deepEqual(query.added, [result]);
});

test("results are kept while the index is still loading and filtered once it is ready", async () => {
  const { compat, control } = makeFakeCompat({ prefs: { untaggedVisibility: "nowhere" } });
  const mod = createPerSpaceHistory(compat);
  const loading = mod.init();
  const urlbar = control.state.urlbar;
  const before = addThroughQuery(urlbar, { userContextId: 1 }, makeHistoryResult(WORK_URL));
  await loading;
  const after = addThroughQuery(urlbar, { userContextId: 1 }, makeHistoryResult(WORK_URL));
  assert.equal(before.added.length, 1);
  assert.equal(after.added.length, 0);
});

test("shutdown restores the stock Query.prototype.add and removes the Symbol slot", async () => {
  const { mod, urlbar } = await makeRunningMod();
  await mod.shutdown();
  assert.equal(urlbar.Query.prototype.add, urlbar.stockAdd);
  assert.equal(ORIGINAL_ADD in urlbar.Query.prototype, false);
});

test("calling init twice wraps Query.prototype.add only once", async () => {
  const { mod, urlbar } = await makeRunningMod();
  const patched = urlbar.Query.prototype.add;
  await mod.init();
  assert.equal(urlbar.Query.prototype.add, patched);
  assert.equal(urlbar.Query.prototype[ORIGINAL_ADD], urlbar.stockAdd);
});

test("a second mod instance replaces the first instance's wrapper instead of wrapping it", async () => {
  const urlbar = makeFakeUrlbar();
  await makeRunningMod({ urlbar });
  const second = await makeRunningMod({ urlbar });
  assert.equal(urlbar.Query.prototype[ORIGINAL_ADD], urlbar.stockAdd);
  await second.mod.shutdown();
  assert.equal(urlbar.Query.prototype.add, urlbar.stockAdd);
});

test("when Query is not exported the mod does not patch, notifies once and keeps tagging", async () => {
  const urlbar = { ...makeFakeUrlbar(), Query: undefined };
  const { mod, control } = await makeRunningMod({ urlbar });
  mod.recordVisit({ url: WORK_URL, userContextId: 1, spaceId: "space-a" });
  assert.deepEqual(control.state.notifications, ["Per-Space History is inactive on this browser version"]);
  assert.equal(mod.stats().patched, false);
  assert.equal(mod.stats().pages, 1);
});

test("when Query.prototype.add is missing the mod does not patch and notifies once", async () => {
  const urlbar = makeFakeUrlbar();
  delete urlbar.Query.prototype.add;
  const { mod, control } = await makeRunningMod({ urlbar });
  assert.equal(control.state.notifications.length, 1);
  assert.equal(mod.stats().patched, false);
  assert.equal("add" in urlbar.Query.prototype, false);
});

test("when loading the address-bar modules throws the mod still starts and keeps tagging", async () => {
  const { mod, control } = await makeRunningMod({ loadUrlbarThrows: true });
  mod.recordVisit({ url: WORK_URL, userContextId: 1, spaceId: "" });
  assert.equal(control.state.notifications.length, 1);
  assert.equal(mod.stats().ready, true);
  assert.equal(mod.stats().pages, 1);
});

test("recordVisit tags the page plus its scheme+host and bare-host origins, in memory and in SQLite", async () => {
  const { mod, control } = await makeRunningMod();
  mod.recordVisit({ url: "https://www.example.org/a", userContextId: 3, spaceId: "space-a", time: 5000 });
  await control.fireTimers(5000);
  await settle();
  assert.deepEqual(control.rows("SELECT url, user_context_id, space_id, last_seen FROM page_tags"), [
    { url: "https://www.example.org/a", user_context_id: 3, space_id: "space-a", last_seen: 5000 },
  ]);
  assert.deepEqual(
    control.rows("SELECT origin FROM origin_tags ORDER BY origin").map((row) => row.origin),
    ["example.org", "https://www.example.org"]
  );
  assert.equal(mod.explain("https://www.example.org/a").page.length, 1);
});

test("recordVisit of a search results URL also tags the normalized search term with the engine id", async () => {
  const { mod, control } = await makeRunningMod();
  mod.recordVisit({ url: "https://search.example/?q=Alpha%20%20Zebra", userContextId: 1, spaceId: "space-a", time: 5000 });
  await control.fireTimers(5000);
  await settle();
  assert.deepEqual(control.rows("SELECT term, engine_id, user_context_id FROM search_tags"), [
    { term: "alpha zebra", engine_id: "search.example", user_context_id: 1 },
  ]);
});

test("a search term searched in one container is dropped from another container's suggestions", async () => {
  const { mod, urlbar } = await makeRunningMod();
  mod.recordVisit({ url: "https://search.example/?q=bravo+yak", userContextId: 2, spaceId: "space-b" });
  const result = { type: RESULT_TYPE.SEARCH, source: RESULT_SOURCE.HISTORY, payload: { suggestion: "bravo yak", lowerCaseSuggestion: "bravo yak" } };
  assert.equal(addThroughQuery(urlbar, { userContextId: 1 }, result).added.length, 0);
  assert.equal(addThroughQuery(urlbar, { userContextId: 2 }, result).added.length, 1);
});

test("recordVisit records nothing while the tagging pref is off", async () => {
  const { mod } = await makeRunningMod({ prefs: { tagging: false } });
  mod.recordVisit({ url: WORK_URL, userContextId: 1, spaceId: "" });
  assert.equal(mod.stats().pages, 0);
});

test("recordVisit records nothing while places.history.enabled is false", async () => {
  const { mod, control } = await makeRunningMod();
  control.state.historyEnabled = false;
  mod.recordVisit({ url: WORK_URL, userContextId: 1, spaceId: "" });
  assert.equal(mod.stats().pages, 0);
});

test("a visit recorded before the database has opened is written once it opens", async () => {
  const { compat, control } = makeFakeCompat();
  const mod = createPerSpaceHistory(compat);
  const loading = mod.init();
  mod.recordVisit({ url: WORK_URL, userContextId: 1, spaceId: "space-a", time: 5000 });
  await loading;
  await control.fireTimers(5000);
  await settle();
  assert.equal(control.rows("SELECT COUNT(*) AS n FROM page_tags")[0].n, 1);
});

test("tags written in one session are loaded back after a restart", async () => {
  const sharedConnection = new FakeConnection();
  const first = await makeRunningMod({ sharedConnection });
  first.mod.recordVisit({ url: WORK_URL, userContextId: 1, spaceId: "space-a" });
  await first.mod.shutdown();
  const second = await makeRunningMod({ sharedConnection });
  assert.deepEqual(second.mod.explain(WORK_URL).page, [{ userContextId: 1, spaceId: "space-a" }]);
});

test("attachWindow records the visits a window's tab listener reports", async () => {
  const { mod } = await makeRunningMod();
  const window = makeFakeWindow();
  mod.attachWindow(window);
  window.handlers.onVisit({ url: WORK_URL, userContextId: 4, spaceId: "space-a", time: 1 });
  assert.deepEqual(mod.explain(WORK_URL).page, [{ userContextId: 4, spaceId: "space-a" }]);
});

test("attachWindow does not listen to a private window", async () => {
  const { mod } = await makeRunningMod();
  const window = makeFakeWindow({ isPrivate: true });
  mod.attachWindow(window);
  assert.equal(window.handlers, null);
  assert.equal(mod.stats().windows, 1);
});

test("detachWindow removes the window's tab listener", async () => {
  const { mod } = await makeRunningMod();
  const window = makeFakeWindow();
  mod.attachWindow(window);
  mod.detachWindow(window);
  assert.equal(window.detached, true);
  assert.equal(mod.stats().windows, 0);
});

test("a page-removed event deletes that URL's tags from memory and from SQLite", async () => {
  const { mod, control } = await makeRunningMod();
  mod.recordVisit({ url: WORK_URL, userContextId: 1, spaceId: "", time: 5000 });
  mod.recordVisit({ url: "https://keep.example/", userContextId: 1, spaceId: "", time: 5000 });
  await control.fireTimers(5000);
  control.state.placesHandlers.onPageRemoved(WORK_URL);
  await settle();
  assert.deepEqual(mod.explain(WORK_URL).page, []);
  assert.deepEqual(control.rows("SELECT url FROM page_tags"), [{ url: "https://keep.example/" }]);
});

test("a history-cleared event deletes every page, origin and term tag from memory and from SQLite", async () => {
  const { mod, control } = await makeRunningMod();
  mod.recordVisit({ url: "https://search.example/?q=alpha", userContextId: 1, spaceId: "", time: 5000 });
  await control.fireTimers(5000);
  control.state.placesHandlers.onHistoryCleared();
  await settle();
  const stats = mod.stats();
  assert.deepEqual({ pages: stats.pages, origins: stats.origins, terms: stats.terms }, { pages: 0, origins: 0, terms: 0 });
  const counts = ["page_tags", "origin_tags", "search_tags"].map((table) => control.rows(`SELECT COUNT(*) AS n FROM ${table}`)[0].n);
  assert.deepEqual(counts, [0, 0, 0]);
});

test("removing the last tagged page of a site deletes that site's origin tags from memory and from SQLite", async () => {
  const { mod, control } = await makeRunningMod();
  mod.recordVisit({ url: "https://forgotten.example/only", userContextId: 1, spaceId: "", time: 5000 });
  await control.fireTimers(5000);
  control.state.placesHandlers.onPageRemoved("https://forgotten.example/only");
  await settle();
  await control.fireTimers(2000);
  await settle();
  assert.equal(mod.stats().origins, 0);
  assert.equal(control.rows("SELECT COUNT(*) AS n FROM origin_tags")[0].n, 0);
});

test("removing one of two tagged pages of a site keeps the site's origin tags", async () => {
  const { mod, control } = await makeRunningMod();
  mod.recordVisit({ url: "https://site.example/a", userContextId: 1, spaceId: "" });
  mod.recordVisit({ url: "https://site.example/b", userContextId: 1, spaceId: "" });
  control.state.placesHandlers.onPageRemoved("https://site.example/a");
  await settle();
  await control.fireTimers(2000);
  await settle();
  assert.deepEqual(mod.explain("https://site.example/b").origins["site.example"], [{ userContextId: 1, spaceId: "" }]);
});

test("removing a site's only page from one container deletes that container's origin tag and keeps the other container's", async () => {
  const { mod, control } = await makeRunningMod();
  mod.recordVisit({ url: "https://site.example/work", userContextId: 1, spaceId: "" });
  mod.recordVisit({ url: "https://site.example/personal", userContextId: 2, spaceId: "" });
  control.state.placesHandlers.onPageRemoved("https://site.example/work");
  await settle();
  await control.fireTimers(2000);
  await settle();
  assert.deepEqual(mod.explain("https://site.example/personal").origins["site.example"], [{ userContextId: 2, spaceId: "" }]);
});

test("a form-history removal deletes tags for terms no longer in form history and keeps terms still there", async () => {
  const { mod, control } = await makeRunningMod();
  mod.recordSearch({ term: "alpha zebra", userContextId: 1, spaceId: "", time: 5000 });
  mod.recordSearch({ term: "bravo yak", userContextId: 1, spaceId: "", time: 5000 });
  await control.fireTimers(5000);
  control.state.formHistoryTerms = ["Bravo  Yak"];
  control.state.formHistoryRemoved();
  await control.fireTimers(2000);
  await settle();
  assert.deepEqual(mod.explain("alpha zebra").term, []);
  assert.equal(mod.explain("bravo yak").term.length, 1);
  assert.deepEqual(control.rows("SELECT term FROM search_tags"), [{ term: "bravo yak" }]);
});

test("removing a search results page keeps its term tag while form history still has the term", async () => {
  const { mod, control } = await makeRunningMod();
  const url = "https://search.example/?q=alpha+zebra";
  mod.recordVisit({ url, userContextId: 1, spaceId: "" });
  control.state.formHistoryTerms = ["alpha zebra"];
  control.state.placesHandlers.onPageRemoved(url);
  await settle();
  await control.fireTimers(2000);
  await settle();
  assert.equal(mod.explain("alpha zebra").term.length, 1);
});

test("removing a search results page deletes its term tag when form history no longer has the term", async () => {
  const { mod, control } = await makeRunningMod();
  const url = "https://search.example/?q=alpha+zebra";
  mod.recordVisit({ url, userContextId: 1, spaceId: "" });
  control.state.formHistoryTerms = [];
  control.state.placesHandlers.onPageRemoved(url);
  await settle();
  await control.fireTimers(2000);
  await settle();
  assert.deepEqual(mod.explain("alpha zebra").term, []);
});

test("term tags are left alone when form history cannot be read", async () => {
  const { mod, control } = await makeRunningMod();
  mod.recordSearch({ term: "alpha zebra", userContextId: 1, spaceId: "" });
  control.state.formHistoryTerms = null;
  control.state.formHistoryRemoved();
  await control.fireTimers(2000);
  await settle();
  assert.equal(mod.explain("alpha zebra").term.length, 1);
});

test("recordSearch records nothing while form history (browser.formfill.enable) is off", async () => {
  const { mod, control } = await makeRunningMod();
  control.state.formHistoryEnabled = false;
  mod.recordVisit({ url: "https://search.example/?q=alpha+zebra", userContextId: 1, spaceId: "" });
  assert.equal(mod.stats().terms, 0);
  assert.equal(mod.stats().pages, 1);
});

test("gc deletes origin tags that no tagged page backs any more and keeps backed ones", async () => {
  const { mod, control } = await makeRunningMod();
  const old = control.state.now - 2 * 60 * 60 * 1000;
  mod.recordVisit({ url: "https://gone.example/", userContextId: 1, spaceId: "", time: old });
  mod.recordVisit({ url: "https://kept.example/", userContextId: 1, spaceId: "", time: old });
  control.state.existingUrls = new Set(["https://kept.example/"]);
  const summary = await mod.gc();
  assert.equal(summary.originsRemoved, 2);
  assert.deepEqual(
    control.rows("SELECT origin FROM origin_tags ORDER BY origin").map((row) => row.origin),
    ["https://kept.example", "kept.example"]
  );
});

test("gc removes only the unbacked container from a scheme+host origin tag whose bare-host tag is still fully backed", async () => {
  const { mod, control } = await makeRunningMod();
  const old = control.state.now - 2 * 60 * 60 * 1000;
  mod.recordVisit({ url: "https://a.example/p", userContextId: 1, spaceId: "", time: old });
  mod.recordVisit({ url: "https://a.example/q", userContextId: 2, spaceId: "", time: old });
  mod.recordVisit({ url: "http://a.example/r", userContextId: 2, spaceId: "", time: old });
  control.state.existingUrls = new Set(["https://a.example/p", "http://a.example/r"]);
  await mod.gc();
  const origins = mod.explain("https://a.example/p").origins;
  assert.deepEqual(origins["https://a.example"], [{ userContextId: 1, spaceId: "" }]);
  assert.deepEqual(origins["a.example"], [
    { userContextId: 1, spaceId: "" },
    { userContextId: 2, spaceId: "" },
  ]);
});

test("gc deletes tags for terms that form history no longer holds", async () => {
  const { mod, control } = await makeRunningMod();
  mod.recordSearch({ term: "alpha zebra", userContextId: 1, spaceId: "" });
  mod.recordSearch({ term: "bravo yak", userContextId: 1, spaceId: "" });
  control.state.formHistoryTerms = ["bravo yak"];
  const summary = await mod.gc();
  assert.equal(summary.termsRemoved, 1);
  assert.deepEqual(mod.explain("alpha zebra").term, []);
});

test("deleting a container deletes that container's tags and keeps other containers' tags", async () => {
  const { mod, control } = await makeRunningMod();
  mod.recordVisit({ url: WORK_URL, userContextId: 2, spaceId: "space-b", time: 5000 });
  mod.recordVisit({ url: "https://keep.example/", userContextId: 1, spaceId: "space-a", time: 5000 });
  await control.fireTimers(5000);
  control.state.containerDeleted(2);
  await settle();
  assert.deepEqual(mod.explain(WORK_URL).page, []);
  assert.deepEqual(control.rows("SELECT DISTINCT user_context_id FROM page_tags"), [{ user_context_id: 1 }]);
});

test("a Space that disappears from every window's Space list has its tags deleted after the confirmation delay", async () => {
  const { mod, control } = await makeRunningMod();
  const window = makeFakeWindow({ spaces: ["space-a", "space-b"] });
  mod.attachWindow(window);
  mod.recordVisit({ url: WORK_URL, userContextId: 2, spaceId: "space-b", time: 5000 });
  window.spaces = ["space-a"];
  window.handlers.onSpacesChanged();
  assert.equal(mod.explain(WORK_URL).page.length, 1);
  await control.fireTimers(2000);
  await settle();
  assert.deepEqual(mod.explain(WORK_URL).page, []);
});

test("a Space still listed by another window keeps its tags when one window stops listing it", async () => {
  const { mod, control } = await makeRunningMod();
  const first = makeFakeWindow({ spaces: ["space-a", "space-b"] });
  const second = makeFakeWindow({ spaces: ["space-a", "space-b"] });
  mod.attachWindow(first);
  mod.attachWindow(second);
  mod.recordVisit({ url: WORK_URL, userContextId: 2, spaceId: "space-b" });
  first.spaces = ["space-a"];
  first.handlers.onSpacesChanged();
  await control.fireTimers(2000);
  await settle();
  assert.equal(mod.explain(WORK_URL).page.length, 1);
});

test("an empty Space list is treated as not-yet-loaded and deletes no tags", async () => {
  const { mod, control } = await makeRunningMod();
  const window = makeFakeWindow({ spaces: ["space-a", "space-b"] });
  mod.attachWindow(window);
  mod.recordVisit({ url: WORK_URL, userContextId: 2, spaceId: "space-b" });
  window.spaces = [];
  window.handlers.onSpacesChanged();
  await control.fireTimers(2000);
  await settle();
  assert.equal(mod.explain(WORK_URL).page.length, 1);
});

test("gc deletes tags for pages older than an hour that are missing from Places and keeps pages Places still has", async () => {
  const { mod, control } = await makeRunningMod();
  const old = control.state.now - 2 * 60 * 60 * 1000;
  mod.recordVisit({ url: "https://gone.example/", userContextId: 1, spaceId: "", time: old });
  mod.recordVisit({ url: "https://kept.example/", userContextId: 1, spaceId: "", time: old });
  control.state.existingUrls = new Set(["https://kept.example/"]);
  const summary = await mod.gc();
  assert.equal(summary.pagesRemoved, 1);
  assert.deepEqual(control.rows("SELECT url FROM page_tags"), [{ url: "https://kept.example/" }]);
  assert.deepEqual(mod.explain("https://gone.example/").page, []);
});

test("gc leaves a page tagged within the last hour alone even when Places does not have it yet", async () => {
  const { mod, control } = await makeRunningMod();
  mod.recordVisit({ url: "https://fresh.example/", userContextId: 1, spaceId: "", time: control.state.now - 1000 });
  control.state.existingUrls = new Set();
  await mod.gc();
  assert.equal(mod.explain("https://fresh.example/").page.length, 1);
});

test("gc drops search terms older than browser.formfill.expire_days and keeps newer ones", async () => {
  const { mod, control } = await makeRunningMod();
  const day = 24 * 60 * 60 * 1000;
  mod.recordSearch({ term: "old term", userContextId: 1, spaceId: "", time: control.state.now - 181 * day });
  mod.recordSearch({ term: "new term", userContextId: 1, spaceId: "", time: control.state.now - 10 * day });
  await mod.gc();
  assert.deepEqual(mod.explain("old term").term, []);
  assert.equal(mod.explain("new term").term.length, 1);
});

test("the idle observer is registered for 300 seconds and runs gc when the last gc was over a week ago", async () => {
  const { mod, control } = await makeRunningMod();
  mod.recordVisit({ url: "https://gone.example/", userContextId: 1, spaceId: "", time: control.state.now - 2 * 60 * 60 * 1000 });
  control.state.existingUrls = new Set();
  assert.equal(control.state.idleSeconds, 300);
  control.state.idleCallback();
  await settle();
  assert.deepEqual(mod.explain("https://gone.example/").page, []);
  assert.equal(control.rows("SELECT value FROM meta WHERE key = 'last_gc'")[0].value, String(control.state.now));
});

test("the idle observer skips gc when the last gc ran less than a week ago", async () => {
  const { mod, control } = await makeRunningMod();
  await mod.gc();
  control.state.now += 24 * 60 * 60 * 1000;
  mod.recordVisit({ url: "https://gone.example/", userContextId: 1, spaceId: "", time: control.state.now - 2 * 60 * 60 * 1000 });
  control.state.existingUrls = new Set();
  control.state.idleCallback();
  await settle();
  assert.equal(mod.explain("https://gone.example/").page.length, 1);
});

test("an unreadable database is moved aside, the user is notified once, and the mod starts empty and persistent", async () => {
  const { mod, control } = await makeRunningMod({ openFailures: 1 });
  assert.deepEqual(control.state.quarantined, ["/profile/per-space-history.sqlite"]);
  assert.equal(control.state.notifications.length, 1);
  assert.equal(mod.stats().ready, true);
  assert.equal(mod.stats().persistent, true);
});

test("when the database cannot be opened even after moving it aside the mod runs from memory only", async () => {
  const { mod, urlbar } = await makeRunningMod({ openFailures: 2 });
  mod.recordVisit({ url: WORK_URL, userContextId: 1, spaceId: "" });
  assert.equal(mod.stats().persistent, false);
  assert.equal(addThroughQuery(urlbar, { userContextId: 2 }, makeHistoryResult(WORK_URL)).added.length, 0);
});

test("shutdown flushes pending tags, closes the database and removes its observers", async () => {
  const { mod, control } = await makeRunningMod();
  mod.recordVisit({ url: WORK_URL, userContextId: 1, spaceId: "", time: 5000 });
  await mod.shutdown();
  const conn = control.connection();
  assert.equal(conn.closed, true);
  assert.equal(control.state.placesHandlers, null);
  assert.equal(control.state.containerDeleted, null);
  assert.equal(control.state.idleCallback, null);
  assert.equal(control.state.formHistoryRemoved, null);
  assert.equal(control.state.blockers.length, 0);
});

test("the profileBeforeChange blocker flushes pending tags to SQLite before closing", async () => {
  const sharedConnection = new FakeConnection();
  const { mod, control } = await makeRunningMod({ sharedConnection });
  mod.recordVisit({ url: WORK_URL, userContextId: 1, spaceId: "", time: 5000 });
  await control.state.blockers[0].callback();
  assert.equal(sharedConnection.rows("SELECT COUNT(*) AS n FROM page_tags")[0].n, 1);
});

test("the mod shuts down when its last window script is unloaded while browser windows stay open", async () => {
  const { mod, control, urlbar } = await makeRunningMod();
  const window = makeFakeWindow();
  mod.attachWindow(window);
  control.state.openWindows = [window];
  mod.detachWindow(window);
  await control.fireTimers(1000);
  await settle();
  assert.equal(mod.stats().active, false);
  assert.equal(urlbar.Query.prototype.add, urlbar.stockAdd);
});

test("the mod stays active when its last window closes and no browser window remains open", async () => {
  const { mod, control } = await makeRunningMod();
  const window = makeFakeWindow();
  mod.attachWindow(window);
  control.state.openWindows = [];
  mod.detachWindow(window);
  await control.fireTimers(1000);
  await settle();
  assert.equal(mod.stats().active, true);
});

test("the mod stays active when a window script is unloaded and re-attached before the orphan check", async () => {
  const { mod, control } = await makeRunningMod();
  const window = makeFakeWindow();
  mod.attachWindow(window);
  control.state.openWindows = [window];
  mod.detachWindow(window);
  mod.attachWindow(window);
  await control.fireTimers(1000);
  await settle();
  assert.equal(mod.stats().active, true);
  assert.equal(mod.stats().windows, 1);
});

test("attachWindow after a shutdown starts the mod again and re-installs the patch", async () => {
  const { mod, urlbar } = await makeRunningMod();
  await mod.shutdown();
  mod.attachWindow(makeFakeWindow());
  await mod.ready;
  assert.equal(mod.stats().active, true);
  assert.notEqual(urlbar.Query.prototype.add, urlbar.stockAdd);
});

test("turning the enabled pref off stops filtering at once and turning it back on resumes it", async () => {
  const { mod, control, urlbar } = await makeRunningMod();
  mod.recordVisit({ url: WORK_URL, userContextId: 1, spaceId: "" });
  control.setPref("enabled", false);
  const whileOff = addThroughQuery(urlbar, { userContextId: 2 }, makeHistoryResult(WORK_URL));
  control.setPref("enabled", true);
  const whileOn = addThroughQuery(urlbar, { userContextId: 2 }, makeHistoryResult(WORK_URL));
  assert.equal(whileOff.added.length, 1);
  assert.equal(whileOn.added.length, 0);
});

test("tagging continues while the enabled pref is off", async () => {
  const { mod, control } = await makeRunningMod();
  control.setPref("enabled", false);
  mod.recordVisit({ url: WORK_URL, userContextId: 1, spaceId: "" });
  assert.equal(mod.stats().pages, 1);
});

test("an unknown scope pref value falls back to container scope", async () => {
  const { mod } = await makeRunningMod({ prefs: { scope: "galaxy" } });
  assert.equal(mod.stats().config.scope, "container");
});

test("init registers every pref default on the default branch", async () => {
  const { mod } = await makeRunningMod();
  assert.deepEqual(mod.stats().config, {
    enabled: true,
    scope: "container",
    untaggedVisibility: "everywhere",
    filterHistory: true,
    filterAutofill: true,
    filterSearchHistory: true,
    tagging: true,
    debug: false,
  });
});

test("stats reports index sizes, the drop counter and the known container/Space pairs", async () => {
  const { mod, urlbar } = await makeRunningMod();
  mod.recordVisit({ url: WORK_URL, userContextId: 1, spaceId: "space-a" });
  addThroughQuery(urlbar, { userContextId: 2 }, makeHistoryResult(WORK_URL));
  const stats = mod.stats();
  assert.equal(stats.pages, 1);
  assert.equal(stats.origins, 2);
  assert.equal(stats.terms, 0);
  assert.equal(stats.dropped, 1);
  assert.deepEqual(stats.scopes, [{ userContextId: 1, spaceId: "space-a" }]);
  assert.equal(stats.patched, true);
});

test("explain lists the scopes of a URL's page tag and origin tags plus the current scope", async () => {
  const { mod } = await makeRunningMod();
  mod.recordVisit({ url: WORK_URL, userContextId: 1, spaceId: "space-a" });
  assert.deepEqual(mod.explain(WORK_URL), {
    page: [{ userContextId: 1, spaceId: "space-a" }],
    origins: {
      "https://example.org": [{ userContextId: 1, spaceId: "space-a" }],
      "example.org": [{ userContextId: 1, spaceId: "space-a" }],
    },
    term: [],
    currentScope: { dim: "c", id: 0 },
  });
});

test("backfill tags only pages that have no tags yet into the given container", async () => {
  const { mod, control } = await makeRunningMod();
  mod.recordVisit({ url: "https://tagged.example/", userContextId: 1, spaceId: "space-a" });
  control.state.visitedPages = [
    { url: "https://tagged.example/", lastVisit: 100 },
    { url: "https://old.example/page", lastVisit: 200 },
  ];
  const report = await mod.backfill({ userContextId: 2, sinceDays: 90 });
  assert.deepEqual(report, { scanned: 2, tagged: 1 });
  assert.deepEqual(mod.explain("https://old.example/page").page, [{ userContextId: 2, spaceId: "" }]);
  assert.deepEqual(mod.explain("https://tagged.example/").page, [{ userContextId: 1, spaceId: "space-a" }]);
  assert.deepEqual(control.rows("SELECT last_seen FROM page_tags WHERE url = 'https://old.example/page'"), [{ last_seen: 200 }]);
});

test("backfill rejects a call without a numeric userContextId", async () => {
  const { mod } = await makeRunningMod();
  await assert.rejects(() => mod.backfill({ sinceDays: 90 }), /userContextId/);
});

test("forgetScope with a userContextId deletes that container's tags and returns how many it removed", async () => {
  const { mod } = await makeRunningMod();
  mod.recordVisit({ url: WORK_URL, userContextId: 2, spaceId: "space-b" });
  const removed = await mod.forgetScope({ userContextId: 2 });
  assert.equal(removed, 3);
  assert.equal(mod.stats().pages, 0);
});

test("forgetScope rejects a call that names neither a container nor a Space", async () => {
  const { mod } = await makeRunningMod();
  await assert.rejects(() => mod.forgetScope({}), /exactly one/);
});

test("exportJSON returns a JSON string holding the persisted pages, origins and terms", async () => {
  const { mod } = await makeRunningMod();
  mod.recordVisit({ url: "https://search.example/?q=alpha", userContextId: 1, spaceId: "space-a" });
  const dump = JSON.parse(await mod.exportJSON());
  assert.equal(dump.schemaVersion, 1);
  assert.equal(dump.pages.length, 1);
  assert.equal(dump.origins.length, 2);
  assert.equal(dump.terms[0].term, "alpha");
});

test("selfTest passes all nine cases through the patched Query.prototype.add", async () => {
  const { mod } = await makeRunningMod();
  const report = mod.selfTest();
  assert.equal(report.ok, true, JSON.stringify(report.results.filter((entry) => !entry.ok)));
  assert.equal(report.passed, 9);
});

test("selfTest leaves the real index and the drop counter untouched", async () => {
  const { mod } = await makeRunningMod();
  mod.selfTest();
  const stats = mod.stats();
  assert.equal(stats.pages, 0);
  assert.equal(stats.dropped, 0);
  assert.deepEqual(stats.scopes, []);
});

test("selfTest ignores the user's prefs and passes even with the mod disabled", async () => {
  const { mod } = await makeRunningMod({ prefs: { enabled: false, untaggedVisibility: "nowhere" } });
  assert.equal(mod.selfTest().ok, true);
});

test("selfTest reports failure when Query.prototype.add is not patched", async () => {
  const urlbar = { ...makeFakeUrlbar(), Query: undefined };
  const { mod } = await makeRunningMod({ urlbar });
  const report = mod.selfTest();
  assert.equal(report.ok, false);
  assert.equal(report.failed, 1);
});

test("with the debug pref on, drops for one query are summarised in a single delayed log line", async () => {
  const { mod, control, urlbar } = await makeRunningMod({ prefs: { debug: true } });
  mod.recordVisit({ url: WORK_URL, userContextId: 1, spaceId: "" });
  const lines = [];
  const originalLog = console.log;
  console.log = (...args) => lines.push(args);
  try {
    const query = new urlbar.Query({ userContextId: 2, searchString: "work" });
    query.add(PROVIDER, makeHistoryResult(WORK_URL));
    query.add(PROVIDER, makeHistoryResult(WORK_URL));
    await control.fireTimers(300);
  } finally {
    console.log = originalLog;
  }
  const summaries = lines.filter((args) => typeof args[1] === "string" && args[1].startsWith('query "work"'));
  assert.equal(summaries.length, 1);
  assert.match(summaries[0][1], /dropped 2/);
});
