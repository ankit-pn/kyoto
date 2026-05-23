// Pyodide-in-a-sandbox-iframe. The iframe is declared in manifest.json
// (sandbox.pages: ["sandbox/python.html"]) and embedded in sidepanel.html.

(() => {
  'use strict';
  const { T, STR, NUM, OBJ } = window.KyotoTR;

  const PythonSandbox = (() => {
    let ready = false;
    let readyPromise = null;

    window.addEventListener('message', (e) => {
      if (e.data && e.data.type === 'sandbox_ready') ready = true;
    });

    function getIframe() {
      const f = document.getElementById('pythonSandbox');
      if (!f) throw new Error('Python sandbox iframe missing from side-panel DOM.');
      return f;
    }

    function ensureReady(timeoutMs = 30000) {
      if (ready) return Promise.resolve();
      if (readyPromise) return readyPromise;
      readyPromise = new Promise((resolve, reject) => {
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
          reject(new Error(`Python sandbox did not become ready within ${Math.round((Date.now() - t0) / 1000)}s.`));
        }, timeoutMs);
      });
      return readyPromise;
    }

    async function exec({ code, packages, timeoutMs = 120000 }) {
      await ensureReady();
      const iframe = getIframe();
      return new Promise((resolve, reject) => {
        const id = 'py_' + Math.random().toString(36).slice(2, 11);
        const onMsg = (e) => {
          if (!e.data || e.data.id !== id) return;
          window.removeEventListener('message', onMsg);
          clearTimeout(timer);
          if (e.data.type === 'result') {
            resolve({ value: e.data.value, stdout: e.data.stdout || '', stderr: e.data.stderr || '' });
          } else {
            reject(new Error(e.data.error || 'unknown sandbox error'));
          }
        };
        window.addEventListener('message', onMsg);
        const timer = setTimeout(() => {
          window.removeEventListener('message', onMsg);
          reject(new Error(`python_exec timed out after ${Math.round(timeoutMs / 1000)}s`));
        }, timeoutMs);
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
