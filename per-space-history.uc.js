// ==UserScript==
// @name           Per-Space History
// @description    Separate address-bar history per container / Space
// @include        chrome://browser/content/browser.xhtml
// ==/UserScript==

(() => {
  const MODULE_BASE = "chrome://sine/content/per-space-history/";

  const { PerSpaceHistory } = ChromeUtils.importESModule(`${MODULE_BASE}PerSpaceHistory.sys.mjs`);
  const detach = () => PerSpaceHistory.detachWindow(window);

  PerSpaceHistory.attachWindow(window);
  if (typeof window.addUnloadListener === "function") {
    window.addUnloadListener(detach);
  }
  window.addEventListener("unload", detach, { once: true });
})();
