// Registers a "Kyoto" panel inside Chrome DevTools.
// The panel itself just loads the existing side-panel UI — same JS,
// same storage, so sessions / settings / tools all work identically.
// The icon + page paths are resolved against the extension root, NOT
// relative to this devtools.js. So we use the full path.
chrome.devtools.panels.create(
  'Kyoto',
  'icons/icon48.png',
  'devtools/panel.html',
  () => {}
);
