import { test } from "node:test";
import assert from "node:assert/strict";
import {
  makeFilter,
  makeContext,
  makeHistoryResult,
  makeAutofillResult,
  makeSearchHistoryResult,
  PROVIDER,
  RESULT_SOURCE,
  RESULT_TYPE,
} from "./helpers.mjs";

const WORK_URL = "https://example.org/work-only";

function drop(filter, context, result) {
  return filter.shouldDrop(context, PROVIDER, result);
}

test("keeps a history page tagged in the current container", () => {
  const { filter, store } = makeFilter();
  store.add("page", WORK_URL, 1, "");
  assert.equal(drop(filter, makeContext({ userContextId: 1 }), makeHistoryResult(WORK_URL)), false);
});

test("drops a history page tagged only in another container", () => {
  const { filter, store } = makeFilter();
  store.add("page", WORK_URL, 1, "");
  assert.equal(drop(filter, makeContext({ userContextId: 2 }), makeHistoryResult(WORK_URL)), true);
});

test("keeps an untagged history page everywhere when untaggedVisibility is everywhere", () => {
  const { filter } = makeFilter({ config: { untaggedVisibility: "everywhere" } });
  assert.equal(drop(filter, makeContext({ userContextId: 2 }), makeHistoryResult(WORK_URL)), false);
});

test("drops an untagged history page when untaggedVisibility is nowhere", () => {
  const { filter } = makeFilter({ config: { untaggedVisibility: "nowhere" } });
  assert.equal(drop(filter, makeContext({ userContextId: 0 }), makeHistoryResult(WORK_URL)), true);
});

test("keeps an untagged history page in a no-container tab when untaggedVisibility is noContainerOnly", () => {
  const { filter } = makeFilter({ config: { untaggedVisibility: "noContainerOnly" } });
  assert.equal(drop(filter, makeContext({ userContextId: 0 }), makeHistoryResult(WORK_URL)), false);
});

test("drops an untagged history page in a container tab when untaggedVisibility is noContainerOnly", () => {
  const { filter } = makeFilter({ config: { untaggedVisibility: "noContainerOnly" } });
  assert.equal(drop(filter, makeContext({ userContextId: 2 }), makeHistoryResult(WORK_URL)), true);
});

test("keeps a bookmark result even when the page was visited only in another container", () => {
  const { filter, store } = makeFilter();
  store.add("page", WORK_URL, 1, "");
  const bookmark = makeHistoryResult(WORK_URL, { source: RESULT_SOURCE.BOOKMARKS });
  assert.equal(drop(filter, makeContext({ userContextId: 2 }), bookmark), false);
});

test("keeps an open-tab result even when the page was visited only in another container", () => {
  const { filter, store } = makeFilter();
  store.add("page", WORK_URL, 1, "");
  const tab = makeHistoryResult(WORK_URL, { source: RESULT_SOURCE.TABS, type: RESULT_TYPE.TAB_SWITCH });
  assert.equal(drop(filter, makeContext({ userContextId: 2 }), tab), false);
});

test("keeps a remote search suggestion whose text matches a term searched in another container", () => {
  const { filter, store } = makeFilter();
  store.add("term", "alpha zebra", 1, "");
  const remote = { type: RESULT_TYPE.SEARCH, source: RESULT_SOURCE.SEARCH, payload: { suggestion: "alpha zebra", lowerCaseSuggestion: "alpha zebra" } };
  assert.equal(drop(filter, makeContext({ userContextId: 2 }), remote), false);
});

test("keeps a pinned top site that is history-sourced and tagged only in another container", () => {
  const { filter, store } = makeFilter();
  store.add("page", WORK_URL, 1, "");
  const pinned = makeHistoryResult(WORK_URL, { payload: { url: WORK_URL, isPinned: true } });
  assert.equal(drop(filter, makeContext({ userContextId: 2 }), pinned), false);
});

test("keeps a sponsored top site that is history-sourced and tagged only in another container", () => {
  const { filter, store } = makeFilter();
  store.add("page", WORK_URL, 1, "");
  const sponsored = makeHistoryResult(WORK_URL, { payload: { url: WORK_URL, isSponsored: true } });
  assert.equal(drop(filter, makeContext({ userContextId: 2 }), sponsored), false);
});

test("keeps a form-history search term searched in the current container", () => {
  const { filter, store } = makeFilter();
  store.add("term", "alpha zebra", 1, "");
  const result = makeSearchHistoryResult({ suggestion: "Alpha Zebra", lowerCaseSuggestion: "alpha zebra" });
  assert.equal(drop(filter, makeContext({ userContextId: 1 }), result), false);
});

test("drops a form-history search term searched only in another container", () => {
  const { filter, store } = makeFilter();
  store.add("term", "alpha zebra", 1, "");
  const result = makeSearchHistoryResult({ suggestion: "Alpha Zebra", lowerCaseSuggestion: "alpha zebra" });
  assert.equal(drop(filter, makeContext({ userContextId: 2 }), result), true);
});

test("drops a recent-search result that has only payload.suggestion, after lower-casing and collapsing spaces", () => {
  const { filter, store } = makeFilter();
  store.add("term", "bravo yak", 1, "");
  const result = makeSearchHistoryResult({ suggestion: "  Bravo   YAK " });
  assert.equal(drop(filter, makeContext({ userContextId: 2 }), result), true);
});

test("keeps a search-history result that carries no suggestion text", () => {
  const { filter } = makeFilter({ config: { untaggedVisibility: "nowhere" } });
  assert.equal(drop(filter, makeContext(), makeSearchHistoryResult({})), false);
});

test("drops an origin autofill result whose origin was visited only in another container", () => {
  const { filter, store } = makeFilter();
  store.add("origin", "https://example.net", 2, "");
  store.add("origin", "example.net", 2, "");
  const result = makeAutofillResult("https://example.net/", "origin");
  assert.equal(drop(filter, makeContext({ userContextId: 1 }), result), true);
});

test("keeps an origin autofill result whose scheme and host were visited in the current container", () => {
  const { filter, store } = makeFilter();
  store.add("origin", "https://example.net", 2, "");
  const result = makeAutofillResult("https://example.net/", "origin");
  assert.equal(drop(filter, makeContext({ userContextId: 2 }), result), false);
});

test("keeps an origin autofill result for https://www.example.net when the current container visited http://example.net", () => {
  const { filter, store } = makeFilter();
  store.add("origin", "http://example.net", 2, "");
  store.add("origin", "example.net", 2, "");
  const result = makeAutofillResult("https://www.example.net/", "origin");
  assert.equal(drop(filter, makeContext({ userContextId: 2 }), result), false);
});

test("treats an adaptive_origin autofill result as an origin lookup", () => {
  const { filter, store } = makeFilter();
  store.add("origin", "example.net", 2, "");
  const result = makeAutofillResult("https://example.net/", "adaptive_origin");
  assert.equal(drop(filter, makeContext({ userContextId: 1 }), result), true);
});

test("drops a url autofill result whose exact page was visited only in another container", () => {
  const { filter, store } = makeFilter();
  store.add("page", "https://example.net/docs/", 2, "");
  const result = makeAutofillResult("https://example.net/docs/", "url");
  assert.equal(drop(filter, makeContext({ userContextId: 1 }), result), true);
});

test("drops a url autofill result for a path prefix that is not a stored page when its origin was visited only in another container", () => {
  const { filter, store } = makeFilter();
  store.add("page", "https://example.net/docs/page.html", 2, "");
  store.add("origin", "https://example.net", 2, "");
  const result = makeAutofillResult("https://example.net/docs/", "url");
  assert.equal(drop(filter, makeContext({ userContextId: 1 }), result), true);
});

test("keeps a url autofill result for a path prefix when its origin was visited in the current container", () => {
  const { filter, store } = makeFilter();
  store.add("origin", "https://example.net", 2, "");
  const result = makeAutofillResult("https://example.net/docs/", "url");
  assert.equal(drop(filter, makeContext({ userContextId: 2 }), result), false);
});

test("keeps an about-page autofill result even when untaggedVisibility is nowhere", () => {
  const { filter } = makeFilter({ config: { untaggedVisibility: "nowhere" } });
  const result = makeAutofillResult("about:config", "about");
  assert.equal(drop(filter, makeContext({ userContextId: 1 }), result), false);
});

test("keeps a history page from another container when filterHistory is off", () => {
  const { filter, store } = makeFilter({ config: { filterHistory: false } });
  store.add("page", WORK_URL, 1, "");
  assert.equal(drop(filter, makeContext({ userContextId: 2 }), makeHistoryResult(WORK_URL)), false);
});

test("keeps an autofill result from another container when filterAutofill is off", () => {
  const { filter, store } = makeFilter({ config: { filterAutofill: false } });
  store.add("origin", "example.net", 2, "");
  const result = makeAutofillResult("https://example.net/", "origin");
  assert.equal(drop(filter, makeContext({ userContextId: 1 }), result), false);
});

test("keeps a search term from another container when filterSearchHistory is off", () => {
  const { filter, store } = makeFilter({ config: { filterSearchHistory: false } });
  store.add("term", "alpha zebra", 1, "");
  const result = makeSearchHistoryResult({ lowerCaseSuggestion: "alpha zebra" });
  assert.equal(drop(filter, makeContext({ userContextId: 2 }), result), false);
});

test("keeps everything when the mod is disabled", () => {
  const { filter, store } = makeFilter({ config: { enabled: false } });
  store.add("page", WORK_URL, 1, "");
  assert.equal(drop(filter, makeContext({ userContextId: 2 }), makeHistoryResult(WORK_URL)), false);
});

test("keeps everything while the index is still loading", () => {
  const { filter, store } = makeFilter({ ready: false });
  store.add("page", WORK_URL, 1, "");
  assert.equal(drop(filter, makeContext({ userContextId: 2 }), makeHistoryResult(WORK_URL)), false);
});

test("keeps everything for a private-window query", () => {
  const { filter, store } = makeFilter();
  store.add("page", WORK_URL, 1, "");
  assert.equal(drop(filter, makeContext({ userContextId: 2, isPrivate: true }), makeHistoryResult(WORK_URL)), false);
});

test("keeps the result when the current scope cannot be resolved", () => {
  const { filter, store } = makeFilter({ windowInfo: null });
  store.add("page", WORK_URL, 1, "");
  assert.equal(drop(filter, makeContext({ userContextId: undefined }), makeHistoryResult(WORK_URL)), false);
});

test("keeps a history-sourced result that has neither a URL nor a search suggestion", () => {
  const { filter } = makeFilter({ config: { untaggedVisibility: "nowhere" } });
  const result = { type: RESULT_TYPE.KEYWORD, source: RESULT_SOURCE.HISTORY, payload: {} };
  assert.equal(drop(filter, makeContext(), result), false);
});

test("in space scope, keeps a page tagged in the window's active Space", () => {
  const { filter, store } = makeFilter({
    config: { scope: "space" },
    windowInfo: { userContextId: 0, spaceId: "space-a" },
  });
  store.add("page", WORK_URL, 5, "space-a");
  assert.equal(drop(filter, makeContext({ userContextId: 0 }), makeHistoryResult(WORK_URL)), false);
});

test("in space scope, drops a page tagged only in another Space even when the container matches", () => {
  const { filter, store } = makeFilter({
    config: { scope: "space" },
    windowInfo: { userContextId: 5, spaceId: "space-b" },
  });
  store.add("page", WORK_URL, 5, "space-a");
  assert.equal(drop(filter, makeContext({ userContextId: 5 }), makeHistoryResult(WORK_URL)), true);
});

test("in space scope with noContainerOnly, keeps an untagged page only when the query's tab has no container", () => {
  const { filter } = makeFilter({
    config: { scope: "space", untaggedVisibility: "noContainerOnly" },
    windowInfo: { userContextId: 0, spaceId: "space-a" },
  });
  assert.equal(drop(filter, makeContext({ userContextId: 0 }), makeHistoryResult(WORK_URL)), false);
  assert.equal(drop(filter, makeContext({ userContextId: 3 }), makeHistoryResult(WORK_URL)), true);
});

test("classify labels each result kind the filter distinguishes", () => {
  const { filter } = makeFilter();
  assert.equal(filter.classify(makeHistoryResult(WORK_URL)).kind, "page");
  assert.equal(filter.classify(makeAutofillResult("https://example.net/", "origin")).kind, "autofill");
  assert.equal(filter.classify(makeSearchHistoryResult({ suggestion: "x" })).kind, "search");
  assert.equal(filter.classify(makeHistoryResult(WORK_URL, { source: RESULT_SOURCE.BOOKMARKS })).kind, "other");
});
