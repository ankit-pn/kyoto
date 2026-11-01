// Boots the real side panel in jsdom.
//
// Every other test loads a module in isolation. This one loads the actual
// `sidepanel.html` plus every `<script src>` it declares, in the declared order,
// against a recording `chrome` stub — so the code under test is the code that
// ships, not a copy. That is the only way to cover the 7k-line wiring layer,
// which is where the last two rounds of bugs actually lived.
//
// jsdom is a devDependency only; nothing here ships in the extension bundle.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { makeChrome } = require('./chrome-stub');

const ROOT = path.join(__dirname, '..', '..');

function readHtml() {
  return fs.readFileSync(path.join(ROOT, 'sidepanel', 'sidepanel.html'), 'utf-8');
}

/** Script srcs in declaration order (mirrors what Chrome would execute). */
function scriptOrder() {
  return [...readHtml().matchAll(/<script src="([^"]+)"><\/script>/g)].map(m => m[1]);
}

function baseWindowStubs(window, chrome) {
  window.chrome = chrome;

  // jsdom lacks a few platform APIs the panel uses.
  if (!window.CSS) window.CSS = {};
  if (!window.CSS.escape) window.CSS.escape = (s) => String(s).replace(/[^a-zA-Z0-9_-]/g, (c) => '\\' + c);
  if (!window.URL.createObjectURL) {
    let n = 0;
    window.URL.createObjectURL = () => `blob:kyoto/${++n}`;
    window.URL.revokeObjectURL = () => {};
  }
  if (!window.matchMedia) {
    window.matchMedia = () => ({ matches: false, addEventListener() {}, removeEventListener() {}, addListener() {}, removeListener() {} });
  }
  // Speech: absent by default so the mic-hiding path is exercised; tests that
  // need dictation install a fake on window before booting.
  if (!('speechSynthesis' in window)) {
    window.speechSynthesis = { speak: () => {}, cancel: () => {}, speaking: false, pending: false };
    window.SpeechSynthesisUtterance = class { constructor(t) { this.text = t; } };
  }
  window.indexedDB = { open: () => { throw new Error('indexedDB unavailable in jsdom harness'); } };
  window.fetch = async () => ({ ok: false, status: 0, json: async () => ({}), text: async () => '', headers: { get: () => null, forEach() {} } });
  window.scrollTo = () => {};
  if (!window.navigator.clipboard) {
    window.navigator.clipboard = { writeText: async () => {}, readText: async () => '' };
  }
  // jsdom reports 0 for layout; the composer autosize path guards on it.
  Object.defineProperty(window.HTMLElement.prototype, 'scrollHeight', { configurable: true, get() { return 24; } });
}

/**
 * Boot the panel.
 * @param {{html?: string, chrome?: object, beforeBoot?: (window:any, chrome:any) => void}} opts
 */
async function bootPanel(opts = {}) {
  const chrome = opts.chrome || makeChrome();
  const html = opts.html || readHtml();
  // Strip script tags: we evaluate them ourselves so we control order and can
  // install stubs before the first line runs.
  const shell = html.replace(/<script src="[^"]+"><\/script>/g, '');

  const dom = new JSDOM(shell, {
    url: 'https://example.test/',
    runScripts: 'outside-only',
    pretendToBeVisual: true,
  });
  const { window } = dom;
  baseWindowStubs(window, chrome);
  if (opts.beforeBoot) opts.beforeBoot(window, chrome);

  const errors = [];
  const origError = window.console.error;
  window.console.error = (...args) => { errors.push(args.map(String).join(' ')); origError.apply(window.console, args); };
  window.addEventListener('error', (e) => errors.push('uncaught: ' + (e.message || e.error)));
  window.addEventListener('unhandledrejection', (e) => errors.push('unhandled rejection: ' + (e.reason?.message || e.reason)));

  const loaded = [];
  for (const src of scriptOrder()) {
    const file = path.join(ROOT, 'sidepanel', src);
    if (!fs.existsSync(file)) throw new Error(`sidepanel.html references missing script: ${src}`);
    const code = fs.readFileSync(file, 'utf-8');
    window.eval(code + `\n//# sourceURL=sidepanel/${src}`);
    loaded.push(src);
  }

  // The panel's boot sequence is an async IIFE at the end of sidepanel.js.
  for (let i = 0; i < 12; i++) await new Promise(r => setTimeout(r, 10));

  return { dom, window, chrome, errors, loaded, $: (sel) => window.document.querySelector(sel) };
}

/** Fire a keyboard event the way the panel's listeners expect. */
function key(window, keyName, mods = {}) {
  const ev = new window.KeyboardEvent('keydown', { key: keyName, bubbles: true, cancelable: true, ...mods });
  window.document.dispatchEvent(ev);
  return ev;
}

/** Type into an input and fire the input event listeners rely on. */
function type(window, el, text) {
  el.value = text;
  el.dispatchEvent(new window.Event('input', { bubbles: true }));
}

module.exports = { bootPanel, key, type, scriptOrder, readHtml, ROOT };
