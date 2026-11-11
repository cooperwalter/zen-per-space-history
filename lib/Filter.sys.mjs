import { pageKey, originKeys, normalizeTerm, urlVariants } from "./UrlKey.sys.mjs";

const ORIGIN_AUTOFILL_TYPES = new Set(["origin", "adaptive_origin"]);
const KEEP = Object.freeze({ kind: "other", gate: null, checks: [] });
const NO_SPACE = Object.freeze({ dim: "s", id: "" });

export function createFilter({ getStore, getConfig, resolveScope, isReady, RESULT_SOURCE, RESULT_TYPE }) {
  function classify(result) {
    const payload = result?.payload ?? {};
    if (payload.isPinned || payload.isSponsored) {
      return KEEP;
    }
    if (result.source !== RESULT_SOURCE.HISTORY) {
      return KEEP;
    }
    if (result.type === RESULT_TYPE.SEARCH) {
      const term = normalizeTerm(payload.lowerCaseSuggestion ?? payload.suggestion);
      if (!term) {
        return KEEP;
      }
      return { kind: "search", gate: "filterSearchHistory", checks: [{ index: "term", keys: [term] }] };
    }
    if (result.autofill) {
      const url = payload.url;
      if (result.autofill.type === "about" || !url) {
        return KEEP;
      }
      const originCheck = { index: "origin", keys: originKeys(url) };
      if (ORIGIN_AUTOFILL_TYPES.has(result.autofill.type)) {
        return { kind: "autofill", gate: "filterAutofill", checks: [originCheck] };
      }
      return {
        kind: "autofill",
        gate: "filterAutofill",
        checks: [{ index: "page", keys: [pageKey(url)] }, originCheck],
      };
    }
    if (payload.url) {
      const keys = result.heuristic ? urlVariants(payload.url).map(pageKey) : [pageKey(payload.url)];
      return { kind: "page", gate: "filterHistory", checks: [{ index: "page", keys }] };
    }
    return KEEP;
  }

  function shouldDrop(context, provider, result, owner) {
    const config = getConfig();
    if (!config.enabled || !isReady() || context?.isPrivate) {
      return false;
    }
    const scope = resolveScope(context, owner);
    if (!scope) {
      return false;
    }
    const classification = classify(result);
    if (!classification.gate || !config[classification.gate]) {
      return false;
    }

    const store = getStore();
    for (const check of classification.checks) {
      let taggedSomewhere = false;
      for (const key of check.keys) {
        if (store.has(check.index, key, scope) || (scope.dim === "s" && store.has(check.index, key, NO_SPACE))) {
          return false;
        }
        taggedSomewhere ||= store.hasAny(check.index, key);
      }
      if (taggedSomewhere) {
        return true;
      }
    }

    switch (config.untaggedVisibility) {
      case "nowhere":
        return true;
      case "noContainerOnly":
        return scope.userContextId !== 0;
      default:
        return false;
    }
  }

  return { shouldDrop, classify };
}
