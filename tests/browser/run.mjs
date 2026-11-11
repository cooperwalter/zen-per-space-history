import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Marionette } from "./marionette.mjs";

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "..");
const ZEN_BINARY = process.env.ZEN_BINARY ?? "/Applications/Zen.app/Contents/MacOS/zen";
const VERBOSE = process.argv.includes("--verbose");

const checks = [];
function check(name, ok, detail = "") {
  checks.push({ name, ok: !!ok, detail });
  console.log(`${ok ? "PASS" : "FAIL"}  ${name}${detail ? `  (${detail})` : ""}`);
}
function note(name, detail) {
  console.log(`NOTE  ${name}: ${detail}`);
}

function startSiteServer() {
  const server = http.createServer((request, response) => {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    response.end(`<!doctype html><title>${request.url.replace(/[<>&]/g, "")}</title><p>per-space-history test page</p>`);
  });
  return new Promise((resolve) => server.listen(0, "127.0.0.1", () => resolve(server)));
}

function freePort() {
  return new Promise((resolve) => {
    const probe = http.createServer();
    probe.listen(0, "127.0.0.1", () => {
      const { port } = probe.address();
      probe.close(() => resolve(port));
    });
  });
}

function writeProfile(profileDir, marionettePort) {
  const prefs = {
    "marionette.port": marionettePort,
    "browser.shell.checkDefaultBrowser": false,
    "browser.aboutwelcome.enabled": false,
    "browser.startup.homepage_override.mstone": "ignore",
    "browser.startup.page": 0,
    "browser.sessionstore.resume_from_crash": false,
    "browser.tabs.warnOnClose": false,
    "browser.warnOnQuit": false,
    "app.update.disabledForTesting": true,
    "datareporting.policy.dataSubmissionEnabled": false,
    "toolkit.telemetry.reportingpolicy.firstRun": false,
    "zen.welcome-screen.seen": true,
    "privacy.userContext.enabled": true,
    "browser.formfill.enable": true,
    "network.dns.localDomains": "psh-search.test",
    "devtools.console.stdout.chrome": true,
    "browser.search.suggest.enabled": true,
    "browser.urlbar.suggest.searches": true,
    "browser.urlbar.suggest.quicksuggest.sponsored": false,
    "browser.urlbar.suggest.quicksuggest.nonsponsored": false,
    "browser.urlbar.suggest.topsites": true,
    "browser.topsites.contile.enabled": false,
    "extensions.autoDisableScopes": 0,
    "network.captive-portal-service.enabled": false,
    "network.connectivity-service.enabled": false,
    "zen.perSpaceHistory.debug": true,
  };
  const lines = Object.entries(prefs).map(([name, value]) => `user_pref(${JSON.stringify(name)}, ${JSON.stringify(value)});`);
  fs.writeFileSync(path.join(profileDir, "user.js"), `${lines.join("\n")}\n`);
}

function writeChromeManifest(workDir) {
  const sineRoot = path.join(workDir, "sine-content");
  fs.mkdirSync(sineRoot, { recursive: true });
  fs.symlinkSync(REPO, path.join(sineRoot, "per-space-history"), "dir");
  const manifest = path.join(workDir, "chrome.manifest");
  fs.writeFileSync(manifest, "content sine sine-content/\n");
  return manifest;
}

async function launch(profileDir, marionettePort) {
  const child = spawn(ZEN_BINARY, ["--headless", "--marionette", "-no-remote", "-profile", profileDir], {
    env: { ...process.env, MOZ_HEADLESS: "1", MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: "1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  for (const stream of [child.stdout, child.stderr]) {
    stream.on("data", (chunk) => {
      output += chunk;
      if (VERBOSE) {
        process.stderr.write(chunk);
      }
    });
  }
  const exited = new Promise((resolve) => child.once("exit", resolve));
  const killOnExit = () => child.kill("SIGKILL");
  process.once("exit", killOnExit);
  exited.then(() => process.removeListener("exit", killOnExit));
  try {
    const client = await Marionette.connect(marionettePort);
    await client.start();
    return { child, client, exited, output: () => output };
  } catch (error) {
    child.kill("SIGKILL");
    throw error;
  }
}

async function quit(browser) {
  try {
    await browser.client.send("Marionette:Quit", { flags: ["eForceQuit"] });
  } catch {}
  browser.client.close();
  const timer = setTimeout(() => browser.child.kill("SIGKILL"), 15000);
  await browser.exited;
  clearTimeout(timer);
}

const HELPERS = `
  const MOD_URL = "chrome://sine/content/per-space-history/PerSpaceHistory.sys.mjs";
  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const { PlacesUtils } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
  const urlbarManager = ChromeUtils.importESModule("moz-src:///browser/components/urlbar/UrlbarProvidersManager.sys.mjs");
  const mod = () => ChromeUtils.importESModule(MOD_URL).PerSpaceHistory;

  async function until(predicate, label, timeoutMs = 20000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const value = await predicate();
      if (value) {
        return value;
      }
      if (Date.now() > deadline) {
        throw new Error("timed out waiting for " + label);
      }
      await sleep(50);
    }
  }

  async function visit(url, userContextId) {
    const tab = gBrowser.addTab(url, {
      userContextId,
      triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal(),
    });
    const browser = tab.linkedBrowser;
    await until(() => browser.currentURI && browser.currentURI.spec === url && !browser.webProgress.isLoadingDocument, "load of " + url);
    await until(() => PlacesUtils.history.fetch(url), "Places visit of " + url);
    const spaceId = tab.getAttribute("zen-workspace-id") || "";
    gBrowser.removeTab(tab);
    return { spaceId };
  }

  async function query(searchString, userContextId) {
    const { UrlbarQueryContext } = ChromeUtils.importESModule("chrome://browser/content/urlbar/UrlbarQueryContext.mjs");
    const context = new UrlbarQueryContext({
      allowAutofill: true,
      isPrivate: false,
      maxResults: 20,
      searchString,
      userContextId,
      sapName: "urlbar",
    });
    await urlbarManager.ProvidersManager.getInstanceForSap("urlbar").startQuery(context);
    return context.results.map((result) => ({
      type: result.type,
      source: result.source,
      url: result.payload.url || null,
      suggestion: result.payload.suggestion || null,
      heuristic: !!result.heuristic,
      autofill: result.autofill ? result.autofill.type : null,
      provider: result.providerName,
    }));
  }
`;

const run = (client, body, args) => client.run(`${HELPERS}\n${body}`, args);

async function loadMod(client, manifest) {
  return run(
    client,
    `
    const file = Cc["@mozilla.org/file/local;1"].createInstance(Ci.nsIFile);
    file.initWithPath(args[0]);
    Components.manager.QueryInterface(Ci.nsIComponentRegistrar).autoRegister(file);
    await until(() => window.gBrowserInit && window.gBrowserInit.delayedStartupFinished, "browser startup", 60000);
    const stockAdd = urlbarManager.Query.prototype.add;
    Services.scriptloader.loadSubScriptWithOptions("chrome://sine/content/per-space-history/per-space-history.uc.js", {
      target: window,
      ignoreCache: true,
    });
    const PerSpaceHistory = mod();
    await PerSpaceHistory.ready;
    return {
      stockAddReplaced: urlbarManager.Query.prototype.add !== stockAdd,
      stats: PerSpaceHistory.stats(),
      selfTest: PerSpaceHistory.selfTest(),
    };
    `,
    [manifest]
  );
}

async function platformFacts(client) {
  return run(
    client,
    `
    const manager = urlbarManager.ProvidersManager.getInstanceForSap("urlbar");
    const { UrlbarShared } = ChromeUtils.importESModule("chrome://browser/content/urlbar/UrlbarShared.mjs");
    return {
      version: Services.appinfo.version,
      platformVersion: Services.appinfo.platformVersion,
      queryExported: typeof urlbarManager.Query === "function",
      addIsFunction: typeof urlbarManager.Query.prototype.add === "function",
      providers: manager.providers.map((provider) => provider.name),
      resultSource: UrlbarShared.RESULT_SOURCE,
      zenWorkspaces: typeof window.gZenWorkspaces,
      currentSpaceContainerId: window.gZenWorkspaces ? window.gZenWorkspaces.getCurrentSpaceContainerId() : null,
      activeWorkspace: window.gZenWorkspaces ? window.gZenWorkspaces.activeWorkspace : null,
      activeWorkspaceContainer: window.gZenWorkspaces && window.gZenWorkspaces.getActiveWorkspaceFromCache()
        ? window.gZenWorkspaces.getActiveWorkspaceFromCache().containerTabId
        : null,
      servicesSearch: typeof Services.search,
    };
    `
  );
}

const hasUrl = (results, url) => results.some((result) => result.url === url);
const historyRows = (results, url) => results.filter((result) => result.url === url && result.source === 2);

async function main() {
  if (!fs.existsSync(ZEN_BINARY)) {
    console.error(`Zen binary not found at ${ZEN_BINARY}; set ZEN_BINARY.`);
    process.exit(2);
  }
  const workDir = fs.mkdtempSync(path.join(os.tmpdir(), "psh-browser-test-"));
  const profileDir = path.join(workDir, "profile");
  fs.mkdirSync(profileDir);
  const marionettePort = await freePort();
  writeProfile(profileDir, marionettePort);
  const manifest = writeChromeManifest(workDir);
  const site = await startSiteServer();
  const port = site.address().port;
  const workUrl = `http://127.0.0.1:${port}/work-only`;
  const personalUrl = `http://localhost:${port}/personal-only`;
  const sharedUrl = `http://127.0.0.1:${port}/shared-page`;
  console.log(`profile: ${profileDir}`);

  let browser = await launch(profileDir, marionettePort);
  try {
    const facts = await platformFacts(browser.client);
    console.log(`Zen ${facts.version} (Gecko ${facts.platformVersion})`);
    console.log(`providers: ${facts.providers.join(", ")}`);
    console.log(
      `gZenWorkspaces: ${facts.zenWorkspaces}, active Space ${facts.activeWorkspace}, container ${facts.currentSpaceContainerId}; Services.search: ${facts.servicesSearch}`
    );
    check("Query is exported with an add method", facts.queryExported && facts.addIsFunction);

    const loaded = await loadMod(browser.client, manifest);
    check("mod loads, patches Query.prototype.add and becomes ready", loaded.stockAddReplaced && loaded.stats.patched && loaded.stats.ready, JSON.stringify({ patched: loaded.stats.patched, ready: loaded.stats.ready, persistent: loaded.stats.persistent }));
    check("selfTest passes through the real patched add", loaded.selfTest.ok, `${loaded.selfTest.passed}/${loaded.selfTest.results.length}`);
    for (const entry of loaded.selfTest.results.filter((result) => !result.ok)) {
      note("selfTest failure", `${entry.name}: expected ${entry.expected}, got ${entry.actual}`);
    }

    const setup = await run(
      browser.client,
      `
      const { ContextualIdentityService } = ChromeUtils.importESModule(
        "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs"
      );
      const work = ContextualIdentityService.create("PSH Work", "briefcase", "blue").userContextId;
      const personal = ContextualIdentityService.create("PSH Personal", "fingerprint", "green").userContextId;
      let engine = "none";
      try {
        const { SearchService } = ChromeUtils.importESModule("moz-src:///toolkit/components/search/SearchService.sys.mjs");
        await SearchService.init();
        const added = await SearchService.addUserEngine({ name: "PSH Test Engine", url: args[0], alias: "pshtest" });
        await SearchService.setDefault(added, 0);
        engine = SearchService.defaultEngine.name;
      } catch (error) {
        engine = "failed: " + error;
      }
      return { work, personal, engine };
      `,
      [`http://psh-search.test:${port}/search?q={searchTerms}`]
    );
    const { work, personal } = setup;
    note("containers", `work=${work} personal=${personal}; test search engine: ${setup.engine}`);
    const engineReady = setup.engine === "PSH Test Engine";

    const visits = await run(
      browser.client,
      `
      const [workUrl, personalUrl, sharedUrl, work, personal, searchBase, engineReady] = args;
      const first = await visit(workUrl, work);
      await visit(personalUrl, personal);
      await visit(sharedUrl, work);
      await visit(sharedUrl, personal);
      const PerSpaceHistory = mod();
      if (engineReady) {
        await visit(searchBase + "alpha+zebra", work);
        await visit(searchBase + "bravo+yak", personal);
      } else {
        PerSpaceHistory.recordSearch({ term: "alpha zebra", userContextId: work, spaceId: first.spaceId });
        PerSpaceHistory.recordSearch({ term: "bravo yak", userContextId: personal, spaceId: first.spaceId });
      }
      const { FormHistory } = ChromeUtils.importESModule("resource://gre/modules/FormHistory.sys.mjs");
      await FormHistory.update([
        { op: "bump", fieldname: "searchbar-history", value: "alpha zebra" },
        { op: "bump", fieldname: "searchbar-history", value: "bravo yak" },
      ]);
      const compatModule = ChromeUtils.importESModule("chrome://sine/content/per-space-history/lib/GeckoCompat.sys.mjs");
      let parsed = null;
      try {
        parsed = compatModule.search.parse(searchBase + "alpha+zebra");
      } catch (error) {
        parsed = "threw: " + error;
      }
      return {
        parsed,
        spaceId: first.spaceId,
        activeWorkspace: window.gZenWorkspaces ? window.gZenWorkspaces.activeWorkspace : null,
        work: PerSpaceHistory.explain(workUrl),
        personal: PerSpaceHistory.explain(personalUrl),
        shared: PerSpaceHistory.explain(sharedUrl),
        alpha: PerSpaceHistory.explain("alpha zebra").term,
        bravo: PerSpaceHistory.explain("bravo yak").term,
        stats: PerSpaceHistory.stats(),
      };
      `,
      [workUrl, personalUrl, sharedUrl, work, personal, `http://psh-search.test:${port}/search?q=`, engineReady]
    );
    check("a visit in the Work container is tagged with that container", visits.work.page.length === 1 && visits.work.page[0].userContextId === work, JSON.stringify(visits.work.page));
    check("a visit in the Personal container is tagged with that container", visits.personal.page.length === 1 && visits.personal.page[0].userContextId === personal);
    check("the same URL visited in both containers is tagged in both", visits.shared.page.length === 2);
    check("visits carry the tab's Zen Space id", !!visits.spaceId && visits.spaceId === visits.activeWorkspace, `tab=${visits.spaceId} active=${visits.activeWorkspace}`);
    check(
      engineReady ? "a search results visit tags its search term via parseSubmissionURL" : "search terms are tagged (recordSearch fallback; engine setup failed)",
      visits.alpha.length === 1 && visits.alpha[0].userContextId === work && visits.bravo.length === 1 && visits.bravo[0].userContextId === personal,
      JSON.stringify({ alpha: visits.alpha, bravo: visits.bravo, parsed: visits.parsed })
    );

    const queries = await run(
      browser.client,
      `
      const [work, personal] = args;
      const out = {};
      const typedVisits = Array.from({ length: 12 }, (unused, index) => ({
        transition: PlacesUtils.history.TRANSITIONS.TYPED,
        date: new Date(Date.now() - index * 60000),
      }));
      await PlacesUtils.history.insert({ url: args[3], visits: typedVisits });
      try {
        const recalculator = Cc["@mozilla.org/places/frecency-recalculator;1"].getService(Ci.nsIObserver).wrappedJSObject;
        await recalculator.recalculateAnyOutdatedFrecencies();
      } catch (error) {
        out.frecencyError = String(error);
      }
      const timed = async (searchString, userContextId) => {
        const started = Date.now();
        const results = await query(searchString, userContextId);
        return { results, ms: Date.now() - started };
      };
      out.workInWork = await query("work-only", work);
      out.workInPersonal = await query("work-only", personal);
      out.personalInPersonal = await query("personal-only", personal);
      out.personalInWork = await query("personal-only", work);
      out.sharedInWork = await query("shared-page", work);
      out.sharedInPersonal = await query("shared-page", personal);
      out.workInNone = await query("work-only", 0);
      out.alpInWork = await query("alp", work);
      out.alpInPersonal = await query("alp", personal);
      out.braInPersonal = await query("bra", personal);
      out.braInWork = await query("bra", work);
      out.emptyInWork = await query("", work);
      out.emptyInPersonal = await query("", personal);
      const locInPersonal = await timed("loc", personal);
      const locInWork = await timed("loc", work);
      out.autofillLocInPersonal = locInPersonal.results;
      out.autofillLocInWork = locInWork.results;
      out.autofillMs = { kept: locInPersonal.ms, dropped: locInWork.ms };
      out.typedUrlInPersonal = await query(args[2], personal);
      out.dropped = mod().stats().dropped;
      return out;
      `,
      [work, personal, workUrl, personalUrl]
    );
    if (queries.frecencyError) {
      note("frecency recalculation", queries.frecencyError);
    }
    check("typing 'work-only' in Work suggests the work URL", hasUrl(queries.workInWork, workUrl));
    check("typing 'work-only' in Personal does not suggest the work URL", !hasUrl(queries.workInPersonal, workUrl), JSON.stringify(queries.workInPersonal.map((result) => result.url)));
    check("typing 'work-only' with no container does not suggest the work URL", !hasUrl(queries.workInNone, workUrl));
    check("typing 'personal-only' in Personal suggests the personal URL", hasUrl(queries.personalInPersonal, personalUrl));
    check("typing 'personal-only' in Work does not suggest the personal URL", !hasUrl(queries.personalInWork, personalUrl));
    check("a URL visited in both containers is suggested in both", hasUrl(queries.sharedInWork, sharedUrl) && hasUrl(queries.sharedInPersonal, sharedUrl));

    const formHistory = (results, term) => results.some((result) => result.type === 2 && result.source === 2 && result.suggestion === term);
    check("typing 'alp' in Work suggests the past search 'alpha zebra'", formHistory(queries.alpInWork, "alpha zebra"), JSON.stringify(queries.alpInWork.map((result) => [result.provider, result.suggestion || result.url])));
    check("typing 'alp' in Personal does not suggest 'alpha zebra'", !formHistory(queries.alpInPersonal, "alpha zebra"));
    check("typing 'bra' in Personal suggests the past search 'bravo yak'", formHistory(queries.braInPersonal, "bravo yak"));
    check("typing 'bra' in Work does not suggest 'bravo yak'", !formHistory(queries.braInWork, "bravo yak"));

    const leaksInEmptyWork = queries.emptyInWork.filter((result) => result.url === personalUrl || result.suggestion === "bravo yak");
    const leaksInEmptyPersonal = queries.emptyInPersonal.filter((result) => result.url === workUrl || result.suggestion === "alpha zebra");
    check("the empty address bar shows no Personal pages or searches in Work", leaksInEmptyWork.length === 0, JSON.stringify(queries.emptyInWork.map((result) => [result.provider, result.suggestion || result.url])));
    check("the empty address bar shows no Work pages or searches in Personal", leaksInEmptyPersonal.length === 0);

    const autofilled = (results) => results.find((result) => result.autofill);
    check("typing 'loc' in Work does not autofill localhost (visited only in Personal)", !autofilled(queries.autofillLocInWork) || !autofilled(queries.autofillLocInWork).url.includes("localhost"));
    check("a query whose autofill was dropped still gets a heuristic result", queries.autofillLocInWork.some((result) => result.heuristic), JSON.stringify(queries.autofillLocInWork.filter((result) => result.heuristic)));
    const keptAutofill = autofilled(queries.autofillLocInPersonal);
    check("typing 'loc' in Personal autofills localhost (visited there)", keptAutofill && keptAutofill.url.includes("localhost"), keptAutofill ? `${keptAutofill.autofill} autofill ${keptAutofill.url}` : "Firefox offered no autofill");
    check("a query whose autofill was dropped finishes without a stall", queries.autofillMs.dropped < queries.autofillMs.kept + 500, `kept ${queries.autofillMs.kept} ms, dropped ${queries.autofillMs.dropped} ms`);
    check("typing the full work URL in Personal still yields a heuristic visit result", queries.typedUrlInPersonal.some((result) => result.heuristic && result.url && result.url.startsWith(workUrl)), JSON.stringify(queries.typedUrlInPersonal.filter((result) => result.heuristic)));
    check("typing the full work URL in Personal shows no history row for it", historyRows(queries.typedUrlInPersonal, workUrl).length === 0);
    note("results dropped so far", String(queries.dropped));

    const prefToggle = await run(
      browser.client,
      `
      const [work, personal] = args;
      Services.prefs.setBoolPref("zen.perSpaceHistory.enabled", false);
      const off = await query("work-only", personal);
      Services.prefs.setBoolPref("zen.perSpaceHistory.enabled", true);
      const on = await query("work-only", personal);
      Services.prefs.setStringPref("zen.perSpaceHistory.scope", "space");
      const spaceScope = await query("work-only", personal);
      Services.prefs.setStringPref("zen.perSpaceHistory.scope", "container");
      Services.prefs.setStringPref("zen.perSpaceHistory.untaggedVisibility", "nowhere");
      const { PlacesUtils: P } = ChromeUtils.importESModule("resource://gre/modules/PlacesUtils.sys.mjs");
      await P.history.insert({ url: args[2], title: "untagged", visits: [{ date: new Date() }] });
      const untaggedNowhere = await query("untagged-page", work);
      Services.prefs.setStringPref("zen.perSpaceHistory.untaggedVisibility", "everywhere");
      const untaggedEverywhere = await query("untagged-page", work);
      return { off, on, spaceScope, untaggedNowhere, untaggedEverywhere };
      `,
      [work, personal, `http://127.0.0.1:${port}/untagged-page`]
    );
    const untaggedUrl = `http://127.0.0.1:${port}/untagged-page`;
    check("with the enabled pref off, the work URL shows in Personal again", hasUrl(prefToggle.off, workUrl));
    check("turning the enabled pref back on resumes filtering without a restart", !hasUrl(prefToggle.on, workUrl));
    check("in space scope, a page visited in the active Space shows regardless of container", hasUrl(prefToggle.spaceScope, workUrl));
    check("an untagged history page is hidden when untaggedVisibility is nowhere", !hasUrl(prefToggle.untaggedNowhere, untaggedUrl));
    check("an untagged history page shows when untaggedVisibility is everywhere", hasUrl(prefToggle.untaggedEverywhere, untaggedUrl));

    await run(browser.client, `await mod().exportJSON();`);
    await quit(browser);
    browser = null;

    browser = await launch(profileDir, marionettePort);
    const reloaded = await loadMod(browser.client, manifest);
    const afterRestart = await run(
      browser.client,
      `
      const [workUrl, work, personal] = args;
      return {
        explain: mod().explain(workUrl).page,
        workInWork: await query("work-only", work),
        workInPersonal: await query("work-only", personal),
      };
      `,
      [workUrl, work, personal]
    );
    check("tags persist across a browser restart", reloaded.stats.pages >= 3 && afterRestart.explain.length === 1 && afterRestart.explain[0].userContextId === work, `pages=${reloaded.stats.pages}`);
    check("filtering works after a restart", hasUrl(afterRestart.workInWork, workUrl) && !hasUrl(afterRestart.workInPersonal, workUrl));

    const cleanup = await run(
      browser.client,
      `
      const [workUrl, personalUrl, sharedUrl, work, personal] = args;
      const PerSpaceHistory = mod();
      const out = {};
      const { FormHistory } = ChromeUtils.importESModule("resource://gre/modules/FormHistory.sys.mjs");
      await FormHistory.update({ op: "remove", fieldname: "searchbar-history", value: "alpha zebra" });
      await until(() => PerSpaceHistory.explain("alpha zebra").term.length === 0, "form-history removal cleanup");
      out.termsAfterFormRemoval = {
        alpha: PerSpaceHistory.explain("alpha zebra").term,
        bravo: PerSpaceHistory.explain("bravo yak").term,
      };

      const bookmarkedUrl = args[5];
      await visit(bookmarkedUrl, work);
      await PlacesUtils.bookmarks.insert({ parentGuid: PlacesUtils.bookmarks.unfiledGuid, url: bookmarkedUrl, title: "kept bookmark" });
      await PlacesUtils.history.remove(bookmarkedUrl);
      await until(() => PerSpaceHistory.explain(bookmarkedUrl).page.length === 0, "bookmarked page visit removal");
      out.bookmarkedAfterRemove = PerSpaceHistory.explain(bookmarkedUrl).page;
      out.bookmarkedStillSuggested = (await query("bookmarked-page", personal)).some((result) => result.url === bookmarkedUrl);

      out.personalOriginBefore = PerSpaceHistory.explain(personalUrl).origins;
      await PlacesUtils.history.remove(workUrl);
      await until(() => PerSpaceHistory.explain(workUrl).page.length === 0, "page-removed cleanup");
      out.afterRemove = PerSpaceHistory.explain(workUrl).page;
      await PlacesUtils.history.remove(personalUrl);
      const originKey = new URL(personalUrl).origin;
      await until(() => (PerSpaceHistory.explain(personalUrl).origins[originKey] || []).length === 0, "origin cleanup after its last page is removed");
      out.personalOriginAfter = PerSpaceHistory.explain(personalUrl).origins;

      const { ContextualIdentityService } = ChromeUtils.importESModule(
        "moz-src:///toolkit/components/contextualidentity/ContextualIdentityService.sys.mjs"
      );
      ContextualIdentityService.remove(personal);
      await until(() => PerSpaceHistory.explain(sharedUrl).page.length === 1, "container-deleted cleanup");
      out.afterContainerDelete = {
        personal: PerSpaceHistory.explain("bravo yak").term,
        shared: PerSpaceHistory.explain(sharedUrl).page,
        scopes: PerSpaceHistory.stats().scopes,
      };

      await PlacesUtils.history.clear();
      await until(() => PerSpaceHistory.stats().pages === 0, "history-cleared cleanup");
      const stats = PerSpaceHistory.stats();
      out.afterClear = { pages: stats.pages, origins: stats.origins, terms: stats.terms };
      out.exported = JSON.parse(await PerSpaceHistory.exportJSON());
      return out;
      `,
      [workUrl, personalUrl, sharedUrl, work, personal, `http://127.0.0.1:${port}/bookmarked-page`]
    );
    check("removing a search from form history removes its term tag and keeps other terms", cleanup.termsAfterFormRemoval.alpha.length === 0 && cleanup.termsAfterFormRemoval.bravo.length === 1, JSON.stringify(cleanup.termsAfterFormRemoval));
    check("removing all visits of a bookmarked page removes its tag while the bookmark still shows everywhere", cleanup.bookmarkedAfterRemove.length === 0 && cleanup.bookmarkedStillSuggested);
    check("forgetting a page in Places removes its tags", cleanup.afterRemove.length === 0);
    check("forgetting a site's last page removes the site's origin tags", Object.values(cleanup.personalOriginBefore).every((scopes) => scopes.length === 1) && Object.values(cleanup.personalOriginAfter).every((scopes) => scopes.length === 0), JSON.stringify(cleanup.personalOriginAfter));
    check("deleting a container removes its tags and keeps the other container's", cleanup.afterContainerDelete.personal.length === 0 && cleanup.afterContainerDelete.shared.length === 1 && cleanup.afterContainerDelete.shared[0].userContextId === work, JSON.stringify(cleanup.afterContainerDelete.shared));
    check("clearing all history empties the index", cleanup.afterClear.pages === 0 && cleanup.afterClear.origins === 0 && cleanup.afterClear.terms === 0, JSON.stringify(cleanup.afterClear));
    check("clearing all history empties the SQLite tables", cleanup.exported.pages.length === 0 && cleanup.exported.origins.length === 0 && cleanup.exported.terms.length === 0);

    const lifecycle = await run(
      browser.client,
      `
      const PerSpaceHistory = mod();
      const patchedBefore = PerSpaceHistory.stats().patched;
      await PerSpaceHistory.shutdown();
      const symbol = Symbol.for("perSpaceHistory.originalAdd");
      const restored = !(symbol in urlbarManager.Query.prototype) && !PerSpaceHistory.stats().patched;
      const stockResults = await query("anything", 0);
      Services.scriptloader.loadSubScriptWithOptions("chrome://sine/content/per-space-history/per-space-history.uc.js", {
        target: window,
        ignoreCache: true,
      });
      await PerSpaceHistory.ready;
      const after = PerSpaceHistory.stats();
      return { patchedBefore, restored, stockQueryWorked: Array.isArray(stockResults), repatched: after.patched && after.ready && after.windows === 1 };
      `
    );
    check("shutdown restores the stock Query.prototype.add and queries still work", lifecycle.patchedBefore && lifecycle.restored && lifecycle.stockQueryWorked);
    check("re-running the window script after a shutdown re-enables the mod without a restart", lifecycle.repatched);

    const logged = browser.output().match(/\[PerSpaceHistory\][^\n]*/g) ?? [];
    const errors = logged.filter((line) => /error|failed|unusable|inactive/i.test(line)).slice(0, 5);
    check("the mod's console output was captured and holds no errors", logged.length > 0 && errors.length === 0, errors.length ? errors.join(" | ") : `${logged.length} log lines`);
  } finally {
    if (browser) {
      await quit(browser);
    }
    site.close();
  }

  const failed = checks.filter((entry) => !entry.ok);
  console.log(`\n${checks.length - failed.length}/${checks.length} checks passed`);
  console.log(`(test profile left at ${workDir}; the OS clears its temp folder on its own)`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
