# Platform verification

Checked on 2026-11-11 against the Zen build installed on this Mac: **Zen 1.24.1b, Gecko 159.0.1** (build 20261106124806). The design spec was written against Zen 1.24.2b / Firefox 160, one release newer.

Two methods were used:

- **Source**: reading the JavaScript shipped inside `/Applications/Zen.app` (`omni.ja` and `browser/omni.ja`).
- **Live**: `npm run test:browser`, which starts this Zen build headless on a throwaway profile, loads the mod, and runs 57 checks through the real address-bar code. Zen's own Browser Console was not used, because Zen was running under the everyday profile at the time.

Sine is not installed on this Mac, so the Sine rows were checked against Sine's source only (`CosmoCreeper/Sine` at `fb0bd4c`, 2026-09-01). **Loading through Sine itself has not been run.**

## Facts the design relies on

| Fact | Result | How |
| --- | --- | --- |
| `Query` is exported from `moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs`, and every provider result goes through `Query.prototype.add(provider, result)` | Holds. Providers are given an arrow function that calls `this.add(...)`, so replacing the prototype method takes effect for every query | Source + live |
| `add` starts by deleting the provider from `context.pendingHeuristicProviders` | Holds | Source |
| `context.userContextId` is the container of the tab the query was typed in | Holds, with one exception: Zen's empty tab (see difference 10). It is always a number: `UrlbarQueryContext` normalizes it (0 for no container, -1 for private) | Source + live |
| `ProvidersManager.getInstanceForSap("urlbar").providers` lists the providers | Holds: 32 providers, including Zen's `ZenUrlbarProviderGlobalActions` and `ZenUrlbarProviderSidebar` | Live |
| `RESULT_SOURCE` is `BOOKMARKS:1, HISTORY:2, SEARCH:3, TABS:4, OTHER_LOCAL:5`, in `chrome://browser/content/urlbar/UrlbarShared.mjs` | Holds. Zen adds `ZEN_ACTIONS:9` and `WORKSPACES:10` | Source + live |
| Form-history suggestions are `type SEARCH` + `source HISTORY` with `payload.lowerCaseSuggestion` | Holds for `UrlbarProviderSearchSuggestions`. `UrlbarProviderRecentSearches` sets only `payload.suggestion` (see difference 4) | Source + live |
| `gZenWorkspaces.getCurrentSpaceContainerId()` and `getActiveWorkspaceFromCache().containerTabId` give the active Space's container; `gZenWorkspaces.activeWorkspace` is its id | Holds | Source + live |
| Tabs carry their Space in the `zen-workspace-id` attribute | Holds; it matched `gZenWorkspaces.activeWorkspace` for tabs opened in the active Space | Live |
| `ZenWorkspaceDataChanged` fires on the window when Space data changes | Holds, but only in windows that sync Spaces and are not private, and it fires before the Space list is updated (see difference 11) | Source |
| `PlacesObservers` fires `page-removed` (with `isRemovedFromStore`) and `history-cleared` | Holds | Source + live |
| Observer topic `contextual-identity-deleted` carries `wrappedJSObject.userContextId` | Holds | Source + live |
| Sine loads a mod's `.sys.mjs` once with `ChromeUtils.importESModule("chrome://sine/content/<modId>/<path>")` and its `.uc.js` into each matching window, from the `scripts` tree in `theme.json` | Holds | Sine source |
| Sine runs JS only for store mods or when `sine.allow-unsafe-js` is `true` | Holds | Sine source |
| Sine does not apply preference defaults at install (`TODO: Apply default preferences`) | Holds | Sine source |

## Differences from the spec

None of these change the design. Each is handled in `lib/GeckoCompat.sys.mjs` or `lib/Core.sys.mjs`.

1. **`Services.search` does not exist in this build.** The search service is the `SearchService` export of `moz-src:///toolkit/components/search/SearchService.sys.mjs`, and `parseSubmissionURL` returns nothing until `hasSuccessfullyInitialized` is true. The compat layer imports that module first and falls back to `Services.search`.
2. **Zen ships with form history off** (`browser.formfill.enable = false`), so by default there are no typed-search suggestions from form history. Past searches still appear another way: in engine search mode, `UrlbarProviderPlaces` turns search-results pages from history into `type SEARCH` + `source HISTORY` rows that carry the term but no URL. The mod therefore tags the term of every search-results visit whether or not form history is on, and keeps a term tag for as long as a tagged results page or a form-history entry backs it. The spec's age-based expiry of term tags was dropped, because it would have untagged terms whose pages are still in history.
3. **Custom search engines parse only when their URL has a `name={searchTerms}` query parameter.** Engines whose terms sit in the path, and POST engines, never yield a term, so their searches stay untagged and follow `untaggedVisibility`.
4. **`UrlbarProviderRecentSearches` results have no `lowerCaseSuggestion`.** The filter normalizes `payload.suggestion` instead, as the spec's fallback already allowed.
5. **Autofill has five types**: `origin`, `adaptive_origin`, `url`, `adaptive_url` and `about`. The two origin types use the origin index. The two URL types use the page index and fall back to the origin index, because URL autofill can complete to a path prefix that was never a page. `about` is always kept.
6. **Autofill results are always `source HISTORY`**, even for a bookmarked page, so a bookmarked site's autofill is filtered like history. Bookmark rows themselves are unaffected.
7. **Sine has no unload hook for background modules.** It calls a window script's unload listener both when the window closes and when the mod is disabled. The mod therefore shuts itself down when no window runs its script any more while browser windows are still open, and starts again when a window script attaches.
8. **Sine's toast only shows Sine's own built-in messages.** The two user notices (inactive on this browser version, database reset) are shown as a notification bar in the browser window and logged to the console.
9. **Zen's results learner stores only action command ids**, never URLs, so it cannot bring a filtered URL back.
10. **Zen's empty tab is always container 0.** Zen selects a placeholder tab when a Space has no open tab, and that tab has no container even when the Space has one. A query typed from it is filtered by the Space's container (`getCurrentSpaceContainerId()`), which is also the container the picked result opens in.
11. **`ZenWorkspaceDataChanged` fires before Zen updates its Space list**, so the mod reads the list two seconds after the event. Spaces removed by Sync fire no event at all; their tags stay until `forgetScope({ spaceId })` is run.
12. **Essentials tabs have no Space id.** Their visits are stored with an empty Space, and in Space scope those pages show in every Space.
13. **The typed-URL heuristic carries the URL as typed**, with the title of whichever `http`/`https`/`www` variant is in history. The filter checks all four variants for that row.
14. **A query's own window is reachable** through `query.controller.browserWindow`. Space scope and the empty-tab check read that window, and fall back to the most recently focused one only when it is missing.

## Measurements (Milestone 2)

Node 26, `npm run bench`, 200,000 page rows across 8 containers:

| Measure | Result | Target |
| --- | --- | --- |
| In-memory index heap | 22.4 MB | under about 30 MB |
| `shouldDrop` p99 | 0.001 ms | under 0.05 ms |
| Load 200,000 rows from SQLite into the index | 128 ms (node:sqlite, not Gecko's wrapper) | under 500 ms |

## Not verified

- Loading through Sine or fx-autoconfig. The headless run registers the mod's `chrome://sine/content/per-space-history/` URLs directly and loads the window script the way Sine does.
- Space scope with two Spaces or two windows, and deleting a Space. The headless profile has one Space.
- Moving a corrupt database aside (unit-tested only).
- Whether Zen's new-tab page shows history.
- The weekly cleanup firing from the real idle service. Its logic is unit-tested, and the live run calls it by hand.
