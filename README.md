# Per-Space History

A privileged mod for [Zen Browser](https://zen-browser.app) that gives each container its own address-bar history. Each Zen Space uses its own container, so in practice each Space gets its own.

It records which container (and Space) every visit came from. It then hides address-bar history results, URL autofill and past search terms that don't belong to the current tab's container. Firefox's own history database is never modified: tags live in a separate file, `per-space-history.sqlite`, in the profile folder.

Bookmarks, open tabs and remote search suggestions are never filtered. The History sidebar, the Library window and the new-tab page keep stock behavior.

Status: v0.1.0. Verified on Zen 1.24.1b (Gecko 159) with the automated checks below. Loading through Sine has not been run yet; see [PLATFORM.md](PLATFORM.md).

## Security warning

This mod is JavaScript that runs with **full browser privileges**. It can read and change anything the browser can. Read the code before you install it, and install it only from a source you trust. It has no dependencies and never fetches remote code.

## Install with Sine

1. Install [Sine](https://github.com/CosmoCreeper/Sine) in your Zen profile.
2. Open `about:config` and set `sine.allow-unsafe-js` to `true`. Sine refuses to run JavaScript from mods outside its store without it. This setting applies to every Sine mod you install, not only this one.
3. In Sine's settings, paste this repo's URL into the "install from repo" field.
4. Restart Zen.

History from before the install has no tags. By default it keeps showing everywhere, so nothing disappears on day one. See `untaggedVisibility` and `backfill` below to change that.

Zen ships with "Remember search and form history" turned off. While it is off the browser keeps no search history, so there are no past search terms to filter, and the mod records none.

## Install with fx-autoconfig

Untested. The files are loader-neutral apart from one constant:

1. Copy `per-space-history.uc.js` into `<profile>/chrome/JS/`.
2. Copy `PerSpaceHistory.sys.mjs` and the `lib/` folder into `<profile>/chrome/JS/per-space-history/`.
3. In the copied `per-space-history.uc.js`, change `MODULE_BASE` to `"chrome://userscripts/content/per-space-history/"`.
4. Clear the startup cache and restart.

## Settings

All settings are prefs under `zen.perSpaceHistory.`, shown in Sine's mod settings. Changes apply at once, with no restart.

| Pref | Default | Effect |
| --- | --- | --- |
| `enabled` | `true` | Off: nothing is filtered. Visits are still tagged, so turning it back on loses nothing |
| `scope` | `container` | `container`: the tab's own container. `space`: the window's active Space |
| `untaggedVisibility` | `everywhere` | Where history with no tags shows: `everywhere`, `noContainerOnly` (only in tabs with no container) or `nowhere` |
| `filterHistory` | `true` | Filter history pages |
| `filterAutofill` | `true` | Filter URL autofill. Turn off if autofill feels broken |
| `filterSearchHistory` | `true` | Filter past search terms |
| `tagging` | `true` | Off: stop recording new tags (for debugging) |
| `debug` | `false` | Log each dropped result and a per-query summary with a `[PerSpaceHistory]` prefix |

## Console tools

Open the Browser Console (`Cmd+Shift+J` on macOS, `Ctrl+Shift+J` elsewhere):

```js
const { PerSpaceHistory } = ChromeUtils.importESModule("chrome://sine/content/per-space-history/PerSpaceHistory.sys.mjs");

PerSpaceHistory.stats();                          // index sizes, drop count, known container/Space pairs, state
PerSpaceHistory.explain("https://example.com/");  // which containers and Spaces a URL (or a search term) is tagged in
PerSpaceHistory.selfTest();                       // 9 checks through the patched address-bar code
await PerSpaceHistory.backfill({ userContextId: 2, sinceDays: 90 });
await PerSpaceHistory.forgetScope({ userContextId: 2 });    // or { spaceId: "{uuid}" }
JSON.parse(await PerSpaceHistory.exportJSON());   // every stored tag
await PerSpaceHistory.gc();                       // run the weekly cleanup now
```

`backfill` tags existing history that has no tags yet into one container. Use it to move pre-install history into, say, your personal container, then set `untaggedVisibility` to `nowhere`. It tags pages and sites, not past search terms.

Run `selfTest()` after every Zen update. The mod patches one internal method, `Query.prototype.add`. If an update removes or moves it, the mod stops filtering, shows one notice, and the address bar behaves like stock Zen.

## What deleting history does

| You do this | The mod deletes |
| --- | --- |
| Forget a page, or a whole site | That page's tags, and the site's tags once no tagged page of it is left |
| Clear all history | Every tag |
| Remove a search from search history | That search term's tags |
| Delete a container | Every tag for that container |
| Delete a Space | Every tag recorded in that Space |

A weekly cleanup, run while the computer is idle, also removes tags for pages Firefox has expired, search terms older than `browser.formfill.expire_days`, and the oldest rows beyond 200,000 pages.

## Known limits

- **Fewer history rows.** Firefox fetches a fixed number of history matches ranked across all containers, then the mod removes the ones from other containers. A heavily filtered query can show fewer history rows than stock Zen.
- **Bookmarked sites still autofill.** Firefox labels every autofill result as history, so autofill for a site is filtered by container even when the site is bookmarked. The bookmark row itself always shows.
- **Deleting a Space or container drops both tags of its visits.** A visit is stored as one container + Space pair. Deleting either side deletes the pair, so those pages become untagged and follow `untaggedVisibility`.
- **Some searches can't be tagged.** A search is tagged from its results URL, which only works for engines that pass the terms as a URL parameter. Untagged terms follow `untaggedVisibility`.
- **Space scope reads the most recently focused window.** With two windows in different Spaces this can pick the wrong one in rare cases. Container scope does not have this problem.
- Private windows are never tagged or filtered. History that arrives through Sync is untagged.

## Development

No dependencies. Needs Node 22.5 or newer for the tests (they use `node:sqlite`).

```bash
npm test
```

```bash
npm run bench
```

```bash
npm run test:browser
```

`npm test` runs the unit tests for everything except `lib/GeckoCompat.sys.mjs`. `npm run test:browser` starts the installed Zen headless on a throwaway profile, loads the mod, and checks tagging, filtering, persistence, cleanup and shutdown end to end. It does not touch your real profile. Set `ZEN_BINARY` if Zen is not in `/Applications`.

The manual checklist for things the automated run can't cover is in [tests/MANUAL-CHECKLIST.md](tests/MANUAL-CHECKLIST.md).

### Layout

```
theme.json                    Sine manifest
preferences.json              Sine preference UI
PerSpaceHistory.sys.mjs       background entry: builds the controller and starts it
per-space-history.uc.js       per-window: attaches the window to the controller
lib/Core.sys.mjs              controller: patch, tagging, cleanup, lifecycle, console tools
lib/GeckoCompat.sys.mjs       every Firefox/Zen internal the mod touches
lib/Filter.sys.mjs            which results to drop
lib/ScopeResolver.sys.mjs     container vs. Space scope
lib/TagStore.sys.mjs          in-memory index
lib/TagDb.sys.mjs             SQLite persistence and write queue
lib/UrlKey.sys.mjs            page, origin and search-term keys
lib/Log.sys.mjs               console wrapper gated by the debug pref
tests/                        unit tests, benchmark, headless browser checks, manual checklist
```

After a Zen update that breaks the mod, `lib/GeckoCompat.sys.mjs` is the one file to fix.
