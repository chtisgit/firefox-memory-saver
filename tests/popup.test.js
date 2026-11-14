import { DEFAULT_SETTINGS } from "../src/core/settings.js";

export function registerPopupTests(test, equal) {
  test("popup renders controls before optional history resolves", async () => {
    const names = ['browser', 'document', 'window', 'ResizeObserver', 'screen', 'getComputedStyle'];
    const original = Object.fromEntries(names.map(name => [name, Object.getOwnPropertyDescriptor(globalThis, name)]));
    const nodes = new Map();
    const node = () => ({ style: {}, classList: { toggle() {}, add() {} }, addEventListener() {}, setAttribute() {},
      removeAttribute() {}, append() {}, replaceChildren() {}, getBoundingClientRect() { return { top: 200 }; } });
    let resolveUsage;
    let usageStarted;
    const started = new Promise(resolve => { usageStarted = resolve; });
    const usage = new Promise(resolve => { resolveUsage = resolve; });
    let notify;
    let nativeRoot;
    let baseCount = 0;
    let usageCount = 0;
    try {
      if (original.document?.configurable === false) {
        // Browser runs use real DOM nodes; Node runs use the lightweight double.
        nativeRoot = document.createElement('main');
        for (const id of ['enabled', 'status-copy', 'discarded-count', 'sleeping-view', 'protected-view',
          'sleeping-view-count', 'protected-view-count', 'lifetime-count', 'tab-list', 'notice', 'discard-window',
          'current-tab-icon', 'current-tab-page-title', 'current-tab-url', 'current-tab-sleep', 'current-tab-usage',
          'current-tab-details-separator', 'protect-tab', 'tab-protection-status', 'tab-protection-status-text', 'settings']) {
          const element = document.createElement('div'); element.id = id;
          nativeRoot.append(element); nodes.set('#' + id, element);
        }
        document.body.append(nativeRoot);
      } else {
        Object.defineProperty(globalThis, 'document', { configurable: true, value: {
          querySelector(id) { if (!nodes.has(id)) nodes.set(id, node()); return nodes.get(id); },
          createElement: node, documentElement: node(),
        } });
        Object.defineProperty(globalThis, 'window', { configurable: true, value: { location: { search: '' }, addEventListener() {} } });
        Object.defineProperty(globalThis, 'screen', { configurable: true, value: { availHeight: 900 } });
        Object.defineProperty(globalThis, 'getComputedStyle', { configurable: true, value: () => ({ paddingBottom: '10' }) });
        Object.defineProperty(globalThis, 'ResizeObserver', { configurable: true, value: class { observe() {} } });
      }
      globalThis.browser = { runtime: { onMessage: { addListener(fn) { notify = fn; } }, async sendMessage(message) {
        if (message.type === 'GET_TAB_USAGE') { usageStarted(); return ++usageCount === 1 ? usage : { ok: true, data: { 1: { totalActiveMs: 240000 } } }; }
        baseCount++;
        return { ok: true, data: { settings: { ...DEFAULT_SETTINGS, usageTrackingEnabled: true }, discardedTabs: [], protectedTabs: [],
          eligibleDiscardCount: 2, lifetimeDiscardCount: 7,
          currentTab: { id: 1, title: baseCount === 1 ? 'Visible immediately' : 'New popup snapshot', url: 'https://example.org', protectionReasons: [], usage: null } } };
      } } };
      await import(`../src/popup/index.js?ui-test=${Date.now()}`);
      await started;
      equal(nodes.get('#current-tab-page-title').textContent, 'Visible immediately');
      equal(nodes.get('#discard-window').hidden, false);
      equal(nodes.get('#discard-window').textContent, 'Discard 2 now');
      equal(nodes.get('#current-tab-usage').textContent, 'active time unknown');
      notify({ type: 'EXTERNAL_PROTECTION_CHANGED' });
      await new Promise(resolve => setTimeout(resolve, 0));
      equal(nodes.get('#current-tab-page-title').textContent, 'New popup snapshot');
      equal(nodes.get('#current-tab-usage').textContent.includes('4m active'), true);
      // A late history reply from the old snapshot must not overwrite this one.
      resolveUsage({ ok: true, data: { 1: { totalActiveMs: 120000, lastActivatedAt: null } } });
      await new Promise(resolve => setTimeout(resolve, 0));
      equal(nodes.get('#current-tab-usage').textContent.includes('4m active'), true);
    } finally {
      nativeRoot?.remove();
      for (const name of names) {
        if (original[name]) Object.defineProperty(globalThis, name, original[name]);
        else delete globalThis[name];
      }
    }
  });
}
