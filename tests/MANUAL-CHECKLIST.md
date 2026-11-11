# Manual checklist

Use a fresh profile so nothing here touches real history:

```bash
/Applications/Zen.app/Contents/MacOS/zen -P psh-test
```

Install Sine in that profile, set `sine.allow-unsafe-js = true` in `about:config`, install this mod, and restart.

Items marked **(auto)** are also covered by `npm run test:browser` in container scope. Run them by hand anyway after a Zen update, because the automated run does not go through Sine or the visible address bar.

## Setup

- [ ] Create Space A with container "Work" and Space B with container "Personal".
- [ ] Turn on "Remember search and form history" (Zen ships with it off; without it there is no search history to filter).
- [ ] In A, visit `example.org/work-only` and search "alpha zebra" from the address bar.
- [ ] In B, visit `example.net/personal-only` and search "bravo yak" from the address bar.

## Filtering

- [ ] **(auto)** In A, typing "work" suggests the work URL. Typing "personal" doesn't suggest the personal URL.
- [ ] **(auto)** In A, the empty address bar's top sites show no B pages.
- [ ] **(auto)** In A, typing "alp" suggests "alpha zebra". Typing "bra" doesn't suggest "bravo yak".
- [ ] Mirror the three items above in B.
- [ ] **(auto)** Autofill: in A, typing "example.n" doesn't autofill `example.net`. Enter still navigates, with no delay.
- [ ] **(auto)** Visit the same URL in both Spaces; it appears in both.

## Cleanup

- [ ] **(auto)** Forget the personal URL from the History sidebar; `PerSpaceHistory.explain(url)` shows no tags.
- [ ] **(auto)** Clear all history; `PerSpaceHistory.stats()` shows 0 pages, origins and terms.
- [ ] **(auto)** Delete container "Personal"; its tags are gone.
- [ ] Delete a Space; about two seconds later its tags are gone.

## Lifecycle

- [ ] Disable the mod in Sine: everything shows everywhere, with no errors in the Browser Console. Re-enable: filtering resumes, no restart.
- [ ] Two windows, one per Space, typing alternately: each sees only its own history.
- [ ] **(auto)** Restart the browser: tags persist.
- [ ] Space scope mode (`zen.perSpaceHistory.scope = space`): a container tab opened by hand inside Space A follows A's history.
- [ ] Space scope mode with two windows in different Spaces: each window follows its own Space.

## After every Zen update

- [ ] `PerSpaceHistory.selfTest()` in the Browser Console reports 9/9.
- [ ] The first four Filtering items pass.
