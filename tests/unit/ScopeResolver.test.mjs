import { test } from "node:test";
import assert from "node:assert/strict";
import { createScopeResolver } from "../../lib/ScopeResolver.sys.mjs";

function makeResolver({ scope = "container", windowInfo = null } = {}) {
  return createScopeResolver({
    getConfig: () => ({ scope }),
    getActiveWindowInfo: () => windowInfo,
  });
}

test("container scope resolves to the query context's userContextId", () => {
  const resolver = makeResolver({ windowInfo: { userContextId: 9, spaceId: "space-a" } });
  assert.deepEqual(resolver.current({ userContextId: 3 }), { dim: "c", id: 3, userContextId: 3 });
});

test("container scope treats userContextId 0 as the no-container scope, not as missing", () => {
  const resolver = makeResolver({ windowInfo: { userContextId: 9, spaceId: "space-a" } });
  assert.deepEqual(resolver.current({ userContextId: 0 }), { dim: "c", id: 0, userContextId: 0 });
});

test("container scope falls back to the active window's selected tab container when the context has no userContextId", () => {
  const resolver = makeResolver({ windowInfo: { userContextId: 4, spaceId: "space-a" } });
  assert.deepEqual(resolver.current({}), { dim: "c", id: 4, userContextId: 4 });
});

test("container scope returns null when neither the context nor a window gives a container", () => {
  const resolver = makeResolver({ windowInfo: null });
  assert.equal(resolver.current({}), null);
});

test("space scope resolves to the active window's Space id", () => {
  const resolver = makeResolver({ scope: "space", windowInfo: { userContextId: 2, spaceId: "space-a" } });
  assert.deepEqual(resolver.current({ userContextId: 2 }), { dim: "s", id: "space-a", userContextId: 2 });
});

test("space scope falls back to container scope when the window has no active Space", () => {
  const resolver = makeResolver({ scope: "space", windowInfo: { userContextId: 2, spaceId: "" } });
  assert.deepEqual(resolver.current({ userContextId: 2 }), { dim: "c", id: 2, userContextId: 2 });
});

test("space scope falls back to container scope when there is no browser window", () => {
  const resolver = makeResolver({ scope: "space", windowInfo: null });
  assert.deepEqual(resolver.current({ userContextId: 1 }), { dim: "c", id: 1, userContextId: 1 });
});
