import { test } from "node:test";
import assert from "node:assert/strict";
import { makeStore } from "./helpers.mjs";

const URL_A = "https://example.org/work-only";

test("has returns true for a page in the container it was tagged in", () => {
  const store = makeStore();
  store.add("page", URL_A, 1, "space-a");
  assert.equal(store.has("page", URL_A, { dim: "c", id: 1 }), true);
});

test("has returns false for a page in a container it was never tagged in", () => {
  const store = makeStore();
  store.add("page", URL_A, 1, "space-a");
  assert.equal(store.has("page", URL_A, { dim: "c", id: 2 }), false);
});

test("has returns true for a page in the Space it was tagged in and false in another Space", () => {
  const store = makeStore();
  store.add("page", URL_A, 1, "space-a");
  assert.equal(store.has("page", URL_A, { dim: "s", id: "space-a" }), true);
  assert.equal(store.has("page", URL_A, { dim: "s", id: "space-b" }), false);
});

test("has returns false for a key that was never added", () => {
  const store = makeStore();
  assert.equal(store.has("page", URL_A, { dim: "c", id: 0 }), false);
});

test("hasAny returns true once a key is tagged in any scope and false before", () => {
  const store = makeStore();
  assert.equal(store.hasAny("page", URL_A), false);
  store.add("page", URL_A, 3, "space-c");
  assert.equal(store.hasAny("page", URL_A), true);
});

test("a page visited in two containers is visible in both", () => {
  const store = makeStore();
  store.add("page", URL_A, 1, "space-a");
  store.add("page", URL_A, 2, "space-b");
  assert.equal(store.has("page", URL_A, { dim: "c", id: 1 }), true);
  assert.equal(store.has("page", URL_A, { dim: "c", id: 2 }), true);
});

test("pages, origins and search terms are kept in separate indexes", () => {
  const store = makeStore();
  store.add("origin", "example.org", 1, "");
  assert.equal(store.hasAny("page", "example.org"), false);
  assert.equal(store.hasAny("term", "example.org"), false);
  assert.equal(store.hasAny("origin", "example.org"), true);
});

test("add returns true for a new tag and false when the same tag already exists", () => {
  const store = makeStore();
  assert.equal(store.add("page", URL_A, 1, "space-a"), true);
  assert.equal(store.add("page", URL_A, 1, "space-a"), false);
  assert.equal(store.rowCount("page"), 1);
});

test("a missing Space id is stored as the empty Space", () => {
  const store = makeStore();
  store.add("page", URL_A, 0, null);
  assert.deepEqual(store.scopesOf("page", URL_A), [{ userContextId: 0, spaceId: "" }]);
});

test("removeKey deletes every tag of that key in every scope", () => {
  const store = makeStore();
  store.add("page", URL_A, 1, "space-a");
  store.add("page", URL_A, 2, "space-b");
  assert.equal(store.removeKey("page", URL_A), true);
  assert.equal(store.hasAny("page", URL_A), false);
  assert.equal(store.rowCount("page"), 0);
});

test("removeTag deletes one container/Space tag and leaves the key's other tags", () => {
  const store = makeStore();
  store.add("page", URL_A, 1, "space-a");
  store.add("page", URL_A, 2, "space-b");
  store.removeTag("page", URL_A, 1, "space-a");
  assert.equal(store.has("page", URL_A, { dim: "c", id: 1 }), false);
  assert.equal(store.has("page", URL_A, { dim: "c", id: 2 }), true);
});

test("removeScope for a container deletes that container's tags from pages, origins and terms", () => {
  const store = makeStore();
  store.add("page", URL_A, 2, "space-b");
  store.add("origin", "example.org", 2, "space-b");
  store.add("term", "alpha zebra", 2, "space-b");
  store.add("page", "https://keep.example/", 1, "space-a");
  const removed = store.removeScope("c", 2);
  assert.equal(removed, 3);
  assert.equal(store.hasAny("page", URL_A), false);
  assert.equal(store.hasAny("origin", "example.org"), false);
  assert.equal(store.hasAny("term", "alpha zebra"), false);
  assert.equal(store.has("page", "https://keep.example/", { dim: "c", id: 1 }), true);
});

test("removeScope for a container also removes the Space tag that came from the same visit", () => {
  const store = makeStore();
  store.add("page", URL_A, 2, "space-b");
  store.add("page", URL_A, 1, "space-a");
  store.removeScope("c", 2);
  assert.equal(store.has("page", URL_A, { dim: "s", id: "space-b" }), false);
  assert.equal(store.has("page", URL_A, { dim: "s", id: "space-a" }), true);
});

test("removeScope for a Space deletes that Space's tags and keeps other Spaces' tags", () => {
  const store = makeStore();
  store.add("page", URL_A, 1, "space-a");
  store.add("page", URL_A, 1, "space-b");
  store.removeScope("s", "space-a");
  assert.equal(store.has("page", URL_A, { dim: "s", id: "space-a" }), false);
  assert.equal(store.has("page", URL_A, { dim: "s", id: "space-b" }), true);
});

test("clear empties pages, origins and terms", () => {
  const store = makeStore();
  store.add("page", URL_A, 1, "");
  store.add("origin", "example.org", 1, "");
  store.add("term", "alpha", 1, "");
  store.clear();
  assert.deepEqual(
    { pages: store.size("page"), origins: store.size("origin"), terms: store.size("term") },
    { pages: 0, origins: 0, terms: 0 }
  );
});

test("a key tagged in 40 containers reports has=true for every one of them, past the 31-bit mask limit", () => {
  const store = makeStore();
  for (let ctx = 0; ctx < 40; ctx++) {
    store.add("page", URL_A, ctx, "");
  }
  for (let ctx = 0; ctx < 40; ctx++) {
    assert.equal(store.has("page", URL_A, { dim: "c", id: ctx }), true, `container ${ctx}`);
  }
  assert.equal(store.has("page", URL_A, { dim: "c", id: 40 }), false);
  assert.equal(store.rowCount("page"), 40);
});

test("a key first tagged in the 35th container is found there and not in the first container", () => {
  const store = makeStore();
  for (let ctx = 0; ctx < 35; ctx++) {
    store.add("page", `https://filler.example/${ctx}`, ctx, "");
  }
  store.add("page", URL_A, 34, "");
  assert.equal(store.has("page", URL_A, { dim: "c", id: 34 }), true);
  assert.equal(store.has("page", URL_A, { dim: "c", id: 0 }), false);
});

test("removeScope works on keys that overflowed the 31-bit mask", () => {
  const store = makeStore();
  for (let ctx = 0; ctx < 40; ctx++) {
    store.add("page", URL_A, ctx, "");
  }
  store.removeScope("c", 39);
  store.removeScope("c", 3);
  assert.equal(store.has("page", URL_A, { dim: "c", id: 39 }), false);
  assert.equal(store.has("page", URL_A, { dim: "c", id: 3 }), false);
  assert.equal(store.has("page", URL_A, { dim: "c", id: 38 }), true);
  assert.equal(store.rowCount("page"), 38);
});

test("scopesOf lists every container/Space pair a key is tagged in", () => {
  const store = makeStore();
  store.add("page", URL_A, 1, "space-a");
  store.add("page", URL_A, 2, "space-b");
  assert.deepEqual(store.scopesOf("page", URL_A), [
    { userContextId: 1, spaceId: "space-a" },
    { userContextId: 2, spaceId: "space-b" },
  ]);
});

test("stats reports key counts per index and the known container/Space pairs", () => {
  const store = makeStore();
  store.add("page", URL_A, 1, "space-a");
  store.add("origin", "example.org", 1, "space-a");
  const stats = store.stats();
  assert.equal(stats.pages, 1);
  assert.equal(stats.origins, 1);
  assert.equal(stats.terms, 0);
  assert.deepEqual(stats.scopes, [{ userContextId: 1, spaceId: "space-a" }]);
});
