// Pyodide-in-a-sandbox-iframe. The iframe is declared in manifest.json
// (sandbox.pages: ["sandbox/python.html"]) and embedded in sidepanel.html.

(() => {
  'use strict';
  const { T, STR, NUM, OBJ } = window.KyotoTR;

  const PythonSandbox = (() => {
    let ready = false;
    let readyPromise = null;
    // In-flight exec calls, so a sandbox reset can settle them instead of
    // leaving their promises to die on an iframe that no longer exists.
    const pendingExecs = new Set();

    window.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'sandbox_ready') ready = true;
    });

    function getIframe() {
      const f = document.getElementById('pythonSandbox');
      if (!f) throw new Error('Python sandbox iframe missing from side-panel DOM.');
      return f;
    }

    // Pyodide cannot be interrupted from the outside (no SharedArrayBuffer
    // interrupt buffer in this sandbox), and sandbox/python.html serialises
    // exec calls behind one promise chain. So a timed-out job would wedge
    // that queue forever and every later call would time out too. Throwing
    // the iframe away gives the next call a fresh interpreter + queue; it
    // lazy-loads Pyodide again on first use.
    function _resetSandbox(reason) {
      ready = false;
      readyPromise = null;
      try {
        const old = document.getElementById('pythonSandbox');
        if (old && old.parentNode) {
          // cloneNode(false) keeps id/src/style/title attributes and starts
          // a fresh document in the replacement frame.
          old.parentNode.replaceChild(old.cloneNode(false), old);
        }
      } catch {}
      for (const pending of [...pendingExecs]) {
        try { pending.reject(new Error(reason)); } catch {}
      }
      pendingExecs.clear();
    }

    function ensureReady(timeoutMs = 30000) {
      if (ready) return Promise.resolve();
      if (readyPromise) return readyPromise;
      const attempt = new Promise((resolve, reject) => {
        const iframe = getIframe();
        const pingId = 'ping_' + Math.random().toString(36).slice(2, 9);
        const t0 = Date.now();
        const onMsg = (e) => {
          if (!e.data) return;
          if (e.data.type === 'sandbox_ready' || (e.data.type === 'pong' && e.data.id === pingId)) {
            ready = true;
            window.removeEventListener('message', onMsg);
            clearInterval(pingTimer);
            clearTimeout(timeoutTimer);
            resolve();
          }
        };
        window.addEventListener('message', onMsg);
        const sendPing = () => {
          try { iframe.contentWindow.postMessage({ type: 'ping', id: pingId }, '*'); } catch {}
        };
        sendPing();
        const pingTimer = setInterval(sendPing, 500);
        const timeoutTimer = setTimeout(() => {
          window.removeEventListener('message', onMsg);
          clearInterval(pingTimer);
          // Reset the iframe as well: python.html caches its own rejected
          // Pyodide-load promise, so a plain re-probe would keep failing.
          _resetSandbox(`Python sandbox did not become ready within ${Math.round((Date.now() - t0) / 1000)}s; the sandbox was restarted.`);
          reject(new Error(`Python sandbox did not become ready within ${Math.round((Date.now() - t0) / 1000)}s.`));
        }, timeoutMs);
      });
      // Don't cache a readiness failure — a slow CDN load (or a suspended
      // panel) must not brick Python for the rest of the session.
      readyPromise = attempt.catch((e) => { readyPromise = null; throw e; });
      return readyPromise;
    }

    async function exec({ code, packages, timeoutMs = 120000 }) {
      await ensureReady();
      const iframe = getIframe();
      return new Promise((resolve, reject) => {
        const id = 'py_' + Math.random().toString(36).slice(2, 11);
        let done = false;
        const settle = (fn, value) => {
          if (done) return;
          done = true;
          window.removeEventListener('message', onMsg);
          clearTimeout(timer);
          pendingExecs.delete(entry);
          fn(value);
        };
        const onMsg = (e) => {
          if (!e.data || e.data.id !== id) return;
          if (e.data.type === 'result') {
            settle(resolve, { value: e.data.value, stdout: e.data.stdout || '', stderr: e.data.stderr || '' });
          } else {
            settle(reject, new Error(e.data.error || 'unknown sandbox error'));
          }
        };
        window.addEventListener('message', onMsg);
        const timer = setTimeout(() => {
          _resetSandbox(`python_exec timed out after ${Math.round(timeoutMs / 1000)}s; the Python sandbox was restarted.`);
        }, timeoutMs);
        const entry = { reject: (err) => settle(reject, err) };
        pendingExecs.add(entry);
        iframe.contentWindow.postMessage({
          type: 'exec', id, code,
          packages: Array.isArray(packages) ? packages : []
        }, '*');
      });
    }

    return { exec };
  })();

  T({
    name: 'python_exec',
    group: 'devtools',
    description:
      'Execute Python code via Pyodide (full CPython compiled to WebAssembly) inside a sandboxed iframe. ' +
      'The first call lazily downloads Pyodide from cdn.jsdelivr.net (~5 MB; browser-cached after). ' +
      'Each call is isolated — no state persists between calls (no module imports carrying over, no global vars). ' +
      'Returns { value, stdout, stderr }: `value` is the result of the LAST expression (or the explicit returned value); ' +
      '`stdout` / `stderr` capture print() / exception traces. ' +
      'Pass `packages` to install via micropip before running, e.g. `["numpy", "requests"]`. ' +
      'Default timeout: 120 s.',
    parameters: OBJ({
      code: STR,
      packages: { type: 'array', items: STR },
      timeoutMs: NUM
    }, ['code']),
    handler: async (args = {}) => PythonSandbox.exec(args)
  });
})();
