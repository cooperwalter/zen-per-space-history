export function createScopeResolver({ getConfig, getWindowInfo }) {
  const cache = new WeakMap();

  function resolve(context, owner, config) {
    let windowInfo;
    const lookUp = () => {
      if (windowInfo === undefined) {
        windowInfo = getWindowInfo(owner) ?? null;
      }
      return windowInfo;
    };

    let userContextId = context?.userContextId;
    if (typeof userContextId !== "number") {
      userContextId = lookUp()?.userContextId;
    } else if (userContextId === 0) {
      const info = lookUp();
      if (info?.emptyTab && typeof info.spaceContainerId === "number") {
        userContextId = info.spaceContainerId;
      }
    }
    const hasContainer = typeof userContextId === "number";

    if (config.scope === "space") {
      const spaceId = lookUp()?.spaceId;
      if (spaceId) {
        return { dim: "s", id: spaceId, userContextId: hasContainer ? userContextId : 0 };
      }
    }

    if (!hasContainer) {
      return null;
    }
    return { dim: "c", id: userContextId, userContextId };
  }

  function current(context, owner) {
    const config = getConfig();
    const cacheable = context !== null && typeof context === "object";
    if (cacheable) {
      const cached = cache.get(context);
      if (cached && cached.config === config) {
        return cached.scope;
      }
    }
    const scope = resolve(context, owner, config);
    if (cacheable) {
      cache.set(context, { config, scope });
    }
    return scope;
  }

  return { current };
}
