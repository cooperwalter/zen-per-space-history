export function createScopeResolver({ getConfig, getActiveWindowInfo }) {
  function current(context) {
    let windowInfo;
    let userContextId = context?.userContextId;
    if (typeof userContextId !== "number") {
      windowInfo = getActiveWindowInfo();
      userContextId = windowInfo?.userContextId;
    }
    const hasContainer = typeof userContextId === "number";

    if (getConfig().scope === "space") {
      windowInfo ??= getActiveWindowInfo();
      const spaceId = windowInfo?.spaceId;
      if (spaceId) {
        return { dim: "s", id: spaceId, userContextId: hasContainer ? userContextId : 0 };
      }
    }

    if (!hasContainer) {
      return null;
    }
    return { dim: "c", id: userContextId, userContextId };
  }

  return { current };
}
