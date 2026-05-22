// Registers a "Kyoto" panel inside Chrome DevTools.
// The panel itself just loads the existing side-panel UI — same JS,
// same storage, so sessions / settings / tools all work identically.
chrome.devtools.panels.create(
  'Kyoto',
  '', // icon (none — DevTools shows a default tab)
  'panel.html',
  () => {}
);
