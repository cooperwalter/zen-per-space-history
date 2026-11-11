import { test } from "node:test";
import assert from "node:assert/strict";
import { createScopeResolver } from "../../lib/ScopeResolver.sys.mjs";

function makeResolver({ scope = "container", windowInfo = null } = {}) {
  const config = { scope };
  const lookups = [];
  const resolver = createScopeResolver({
    getConfig: () => config,
    getWindowInfo: (owner) => {
      lookups.push(owner);
      return typeof windowInfo === "function" ? windowInfo(owner) : windowInfo;
    },
  });
  return { resolver, lookups, config };
}

test("container scope resolves to the query context's userContextId", () => {
  const { resolver } = makeResolver({ windowInfo: { userContextId: 9, spaceId: "space-a" } });
  assert.deepEqual(resolver.current({ userContextId: 3 }), { dim: "c", id: 3, userContextId: 3 });
});

test("container scope treats userContextId 0 as the no-container scope when the tab is a normal tab", () => {
  const { resolver } = makeResolver({ windowInfo: { userContextId: 0, spaceId: "space-a", emptyTab: false, spaceContainerId: 4 } });
  assert.deepEqual(resolver.current({ userContextId: 0 }), { dim: "c", id: 0, userContextId: 0 });
});

test("container scope uses the Space's container when the query comes from Zen's empty tab", () => {
  const { resolver } = makeResolver({ windowInfo: { userContextId: 0, spaceId: "space-a", emptyTab: true, spaceContainerId: 4 } });
  assert.deepEqual(resolver.current({ userContextId: 0 }), { dim: "c", id: 4, userContextId: 4 });
});

test("container scope stays on container 0 from Zen's empty tab when the Space has no container", () => {
  const { resolver } = makeResolver({ windowInfo: { userContextId: 0, spaceId: "space-a", emptyTab: true, spaceContainerId: 0 } });
  assert.deepEqual(resolver.current({ userContextId: 0 }), { dim: "c", id: 0, userContextId: 0 });
});

test("container scope does not look at the window for a query from a container tab", () => {
  const { resolver, lookups } = makeResolver({ windowInfo: { userContextId: 9, spaceId: "space-a" } });
  resolver.current({ userContextId: 3 });
  assert.equal(lookups.length, 0);
});

test("container scope falls back to the window's selected tab container when the context has no userContextId", () => {
  const { resolver } = makeResolver({ windowInfo: { userContextId: 4, spaceId: "space-a" } });
  assert.deepEqual(resolver.current({}), { dim: "c", id: 4, userContextId: 4 });
});

test("container scope returns null when neither the context nor a window gives a container", () => {
  const { resolver } = makeResolver({ windowInfo: null });
  assert.equal(resolver.current({}), null);
});

test("space scope resolves to the Space id of the window the query belongs to", () => {
  const owner = { controller: {} };
  const { resolver, lookups } = makeResolver({ scope: "space", windowInfo: { userContextId: 2, spaceId: "space-a" } });
  assert.deepEqual(resolver.current({ userContextId: 2 }, owner), { dim: "s", id: "space-a", userContextId: 2 });
  assert.deepEqual(lookups, [owner]);
});

test("space scope falls back to container scope when the window has no active Space", () => {
  const { resolver } = makeResolver({ scope: "space", windowInfo: { userContextId: 2, spaceId: "" } });
  assert.deepEqual(resolver.current({ userContextId: 2 }), { dim: "c", id: 2, userContextId: 2 });
});

test("space scope falls back to container scope when there is no browser window", () => {
  const { resolver } = makeResolver({ scope: "space", windowInfo: null });
  assert.deepEqual(resolver.current({ userContextId: 1 }), { dim: "c", id: 1, userContextId: 1 });
});

test("the scope is resolved once per query context and reused for that context's later results", () => {
  const { resolver, lookups } = makeResolver({ scope: "space", windowInfo: { userContextId: 2, spaceId: "space-a" } });
  const context = { userContextId: 2 };
  const first = resolver.current(context);
  const second = resolver.current(context);
  assert.equal(first, second);
  assert.equal(lookups.length, 1);
});

test("a cached scope is discarded when the config object is replaced", () => {
  let config = { scope: "space" };
  const resolver = createScopeResolver({
    getConfig: () => config,
    getWindowInfo: () => ({ userContextId: 2, spaceId: "space-a" }),
  });
  const context = { userContextId: 2 };
  assert.equal(resolver.current(context).dim, "s");
  config = { scope: "container" };
  assert.equal(resolver.current(context).dim, "c");
});
