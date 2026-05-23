// Tabs / windows / DOM interaction tools.

(() => {
  'use strict';
  const { T, STR, NUM, BOOL, OBJ, bg, activeTab, truncate, scrip } = window.KyotoTR;

  // ──────── TABS / WINDOWS ────────
  T({
    name: 'tabs_list',
    group: 'browser',
    description: 'List all open browser tabs across windows.',
    parameters: OBJ(),
    handler: async () => {
      const tabs = await chrome.tabs.query({});
      return tabs.map(t => ({
        id: t.id, windowId: t.windowId, index: t.index, url: t.url,
        title: t.title, active: t.active, audible: t.audible,
        pinned: t.pinned, mutedInfo: t.mutedInfo, status: t.status
      }));
    }
  });

  T({
    name: 'tab_active',
    group: 'browser',
    description: 'Get information about the active tab in the current window.',
    parameters: OBJ(),
    handler: async () => activeTab()
  });

  T({
    name: 'tab_open',
    group: 'browser',
    description: 'Open a new tab. Optionally make it the active tab. The new tab automatically inherits the calling agent\'s conversation — switching to it shows the same chat continued, not a fresh session. Set `freshSession: true` to opt out (the new tab becomes a brand-new session, useful when forking unrelated tasks).',
    parameters: OBJ({ url: STR, active: BOOL, freshSession: BOOL }, ['url']),
    handler: async ({ url, active = true, freshSession = false }) => {
      if (!freshSession && window.__kyotoMarkPendingTabBind) {
        window.__kyotoMarkPendingTabBind();
      }
      const tab = await chrome.tabs.create({ url, active });
      return { id: tab.id, url: tab.url, inheritedSession: !freshSession };
    }
  });

  T({
    name: 'tab_navigate',
    group: 'browser',
    description: 'Navigate a tab to a URL. Defaults to the active tab.',
    parameters: OBJ({ url: STR, tabId: NUM }, ['url']),
    handler: async ({ url, tabId }) => {
      tabId = tabId ?? (await activeTab()).id;
      const tab = await chrome.tabs.update(tabId, { url });
      return { id: tab.id, url: tab.url };
    }
  });

  T({
    name: 'tab_reload',
    group: 'browser',
    description: 'Reload a tab. Defaults to the active tab.',
    parameters: OBJ({ tabId: NUM, bypassCache: BOOL }),
    handler: async ({ tabId, bypassCache = false } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      await chrome.tabs.reload(tabId, { bypassCache });
      return { reloaded: tabId };
    }
  });

  T({
    name: 'tab_close',
    group: 'browser',
    description: 'Close one or more tabs by id.',
    parameters: OBJ({ tabIds: { type: 'array', items: NUM } }, ['tabIds']),
    handler: async ({ tabIds }) => {
      await chrome.tabs.remove(tabIds);
      return { closed: tabIds };
    }
  });

  T({
    name: 'tab_screenshot',
    group: 'browser',
    description: 'Capture a screenshot of a tab. Defaults to the currently-active tab in this window; pass `tabId` to target a specific tab (the API still requires the tab to be active in its window — chrome.tabs.captureVisibleTab is window-scoped). Returns the full data URL (use `format: "jpeg"` and a lower `quality` to reduce size). If you only need to *analyze* the screenshot with a vision model, prefer `minimax_describe_tab`.',
    parameters: OBJ({ format: { type: 'string', enum: ['png', 'jpeg'] }, quality: NUM, tabId: NUM }),
    handler: async ({ format = 'png', quality = 90, tabId } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      // captureVisibleTab is window-scoped. Resolve the tab's window so
      // a subagent capturing its own tab doesn't accidentally screenshot
      // the user's foreground window.
      let windowId;
      try { windowId = (await chrome.tabs.get(tabId))?.windowId; } catch {}
      // captureVisibleTab requires the target tab to be active. Activate
      // briefly if needed (no-op if it already is).
      try {
        const t = await chrome.tabs.get(tabId);
        if (t && !t.active) await chrome.tabs.update(tabId, { active: true });
      } catch {}
      const dataUrl = windowId != null
        ? await chrome.tabs.captureVisibleTab(windowId, { format, quality })
        : await chrome.tabs.captureVisibleTab({ format, quality });
      return { dataUrl, bytes: dataUrl.length, mimeType: `image/${format}`, tabId };
    }
  });

  T({
    name: 'windows_list',
    group: 'browser',
    description: 'List all browser windows with their tabs.',
    parameters: OBJ(),
    handler: async () => chrome.windows.getAll({ populate: true })
  });

  // ──────── PAGE / DOM ────────
  T({
    name: 'page_content',
    group: 'page',
    description: 'Extract the main readable content of a tab (article / body text).',
    parameters: OBJ({ tabId: NUM }),
    handler: async ({ tabId } = {}) => bg('PAGE_EXTRACT_CONTENT', { tabId })
  });

  T({
    name: 'page_html',
    group: 'page',
    description: 'Return the outer HTML of a tab, or of elements matching a CSS selector. Truncated to 60 KB.',
    parameters: OBJ({ selector: STR, tabId: NUM, max: NUM }),
    handler: async ({ selector, tabId, max = 60000 } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      const res = await scrip(tabId, (sel) => {
        if (!sel) return document.documentElement.outerHTML;
        return Array.from(document.querySelectorAll(sel)).map(el => el.outerHTML).join('\n\n');
      }, [selector || '']);
      return truncate(res || '', max);
    }
  });

  T({
    name: 'page_query',
    group: 'page',
    description: 'querySelectorAll on the page. Returns tag/id/classes/text/attrs for each match.',
    parameters: OBJ({ selector: STR, tabId: NUM, limit: NUM }, ['selector']),
    handler: async ({ selector, tabId, limit = 50 }) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, (sel, lim) => {
        const out = [];
        const nodes = document.querySelectorAll(sel);
        for (let i = 0; i < Math.min(nodes.length, lim); i++) {
          const el = nodes[i];
          const attrs = {};
          for (const a of el.attributes) attrs[a.name] = a.value;
          const rect = el.getBoundingClientRect();
          out.push({
            tag: el.tagName.toLowerCase(),
            id: el.id || undefined,
            classes: el.className && typeof el.className === 'string' ? el.className.split(/\s+/) : undefined,
            text: (el.textContent || '').trim().slice(0, 200),
            attrs,
            rect: { x: rect.x, y: rect.y, w: rect.width, h: rect.height, visible: rect.width > 0 && rect.height > 0 }
          });
        }
        return { total: nodes.length, shown: out.length, items: out };
      }, [selector, limit]);
    }
  });

  T({
    name: 'page_click',
    group: 'page',
    description: 'Click the first element matching a CSS selector.',
    parameters: OBJ({ selector: STR, tabId: NUM }, ['selector']),
    handler: async ({ selector, tabId }) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, (sel) => {
        const el = document.querySelector(sel);
        if (!el) return { clicked: false, error: 'no match' };
        el.scrollIntoView({ block: 'center', behavior: 'instant' });
        el.click();
        return { clicked: true, tag: el.tagName };
      }, [selector]);
    }
  });

  T({
    name: 'page_fill',
    group: 'page',
    description: 'Set the value of an input/textarea/contenteditable and dispatch input+change events.',
    parameters: OBJ({ selector: STR, value: STR, tabId: NUM }, ['selector', 'value']),
    handler: async ({ selector, value, tabId }) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, (sel, val) => {
        const el = document.querySelector(sel);
        if (!el) return { filled: false, error: 'no match' };
        el.focus();
        if (el.isContentEditable) {
          el.textContent = val;
        } else {
          const proto = el instanceof HTMLTextAreaElement
            ? HTMLTextAreaElement.prototype
            : HTMLInputElement.prototype;
          const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
          setter.call(el, val);
        }
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        return { filled: true };
      }, [selector, value]);
    }
  });

  T({
    name: 'page_scroll',
    group: 'page',
    description: 'Scroll to a selector (into view, centered) or to a y pixel position.',
    parameters: OBJ({ selector: STR, y: NUM, tabId: NUM }),
    handler: async ({ selector, y, tabId } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, (sel, yPos) => {
        if (sel) {
          const el = document.querySelector(sel);
          if (!el) return { scrolled: false, error: 'no match' };
          el.scrollIntoView({ block: 'center', behavior: 'instant' });
          return { scrolled: true, to: 'selector' };
        }
        window.scrollTo({ top: yPos ?? 0, behavior: 'instant' });
        return { scrolled: true, to: 'y', y: yPos ?? 0 };
      }, [selector || '', y]);
    }
  });

  T({
    name: 'page_wait_for',
    group: 'page',
    description: 'Wait until a selector exists / is visible, or until a JS expression returns truthy. Timeout in ms.',
    parameters: OBJ({ selector: STR, expression: STR, timeoutMs: NUM, tabId: NUM }),
    handler: async ({ selector, expression, timeoutMs = 5000, tabId } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, async (sel, expr, ms) => {
        const deadline = Date.now() + ms;
        const check = () => {
          if (sel) {
            const el = document.querySelector(sel);
            return el && el.getBoundingClientRect().width > 0;
          }
          if (expr) {
            try { return !!eval(expr); } catch { return false; }
          }
          return false;
        };
        while (Date.now() < deadline) {
          if (check()) return { matched: true, waitedMs: ms - (deadline - Date.now()) };
          await new Promise(r => setTimeout(r, 100));
        }
        return { matched: false, timeoutMs: ms };
      }, [selector || '', expression || '', timeoutMs], 'MAIN');
    }
  });

  T({
    name: 'page_eval',
    group: 'page',
    description: 'Evaluate JavaScript in the page MAIN world. The result must be JSON-serializable. POWERFUL — can read page state, call site JS, modify DOM.',
    parameters: OBJ({ code: STR, tabId: NUM }, ['code']),
    handler: async ({ code, tabId }) => {
      tabId = tabId ?? (await activeTab()).id;
      const res = await scrip(tabId, async (src) => {
        try {
          let val;
          try { val = (0, eval)(`(async()=>{return (${src})})()`); }
          catch { val = (0, eval)(`(async()=>{${src}})()`); }
          val = await val;
          try { return { ok: true, result: JSON.parse(JSON.stringify(val)) }; }
          catch { return { ok: true, result: String(val) }; }
        } catch (e) {
          return { ok: false, error: e?.message || String(e), stack: e?.stack };
        }
      }, [code], 'MAIN');
      return res;
    }
  });

  // ──────── PAGE STORAGE (read + write) ────────
  T({
    name: 'page_local_storage',
    group: 'storage',
    description: 'Read all localStorage entries for the active tab.',
    parameters: OBJ({ tabId: NUM }),
    handler: async ({ tabId } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, () => {
        const out = {};
        for (let i = 0; i < localStorage.length; i++) {
          const k = localStorage.key(i);
          out[k] = localStorage.getItem(k);
        }
        return out;
      });
    }
  });

  T({
    name: 'page_session_storage',
    group: 'storage',
    description: 'Read all sessionStorage entries for the active tab.',
    parameters: OBJ({ tabId: NUM }),
    handler: async ({ tabId } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, () => {
        const out = {};
        for (let i = 0; i < sessionStorage.length; i++) {
          const k = sessionStorage.key(i);
          out[k] = sessionStorage.getItem(k);
        }
        return out;
      });
    }
  });

  T({
    name: 'page_local_storage_set',
    group: 'storage',
    description: 'Set a localStorage key on the active tab. WRITE operation.',
    parameters: OBJ({ key: STR, value: STR, tabId: NUM }, ['key', 'value']),
    handler: async ({ key, value, tabId } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, (k, v) => { localStorage.setItem(k, v); return { set: true, key: k }; }, [key, value]);
    }
  });
  T({
    name: 'page_local_storage_remove',
    group: 'storage',
    description: 'Remove a localStorage key on the active tab. Pass key="*" to clear all. WRITE operation.',
    parameters: OBJ({ key: STR, tabId: NUM }, ['key']),
    handler: async ({ key, tabId } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, (k) => {
        if (k === '*') { localStorage.clear(); return { cleared: true }; }
        localStorage.removeItem(k); return { removed: true, key: k };
      }, [key]);
    }
  });
  T({
    name: 'page_session_storage_set',
    group: 'storage',
    description: 'Set a sessionStorage key on the active tab. WRITE operation.',
    parameters: OBJ({ key: STR, value: STR, tabId: NUM }, ['key', 'value']),
    handler: async ({ key, value, tabId } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, (k, v) => { sessionStorage.setItem(k, v); return { set: true, key: k }; }, [key, value]);
    }
  });
  T({
    name: 'page_session_storage_remove',
    group: 'storage',
    description: 'Remove a sessionStorage key. Pass key="*" to clear all. WRITE operation.',
    parameters: OBJ({ key: STR, tabId: NUM }, ['key']),
    handler: async ({ key, tabId } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, (k) => {
        if (k === '*') { sessionStorage.clear(); return { cleared: true }; }
        sessionStorage.removeItem(k); return { removed: true, key: k };
      }, [key]);
    }
  });

  // ──────── INDEXEDDB (read-only) ────────
  T({
    name: 'idb_list_databases',
    group: 'storage',
    description: 'List all IndexedDB databases visible to the active tab.',
    parameters: OBJ({ tabId: NUM }),
    handler: async ({ tabId } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, async () => {
        if (!indexedDB.databases) return { error: 'indexedDB.databases() unsupported in this browser' };
        const list = await indexedDB.databases();
        return list;
      }, [], 'MAIN');
    }
  });

  T({
    name: 'idb_list_stores',
    group: 'storage',
    description: 'List object stores within an IndexedDB database, plus their indexes.',
    parameters: OBJ({ database: STR, tabId: NUM }, ['database']),
    handler: async ({ database, tabId }) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, async (dbName) => {
        return await new Promise((resolve) => {
          const req = indexedDB.open(dbName);
          req.onerror = () => resolve({ error: req.error?.message || 'open failed' });
          req.onsuccess = () => {
            const db = req.result;
            const stores = [];
            for (const name of db.objectStoreNames) {
              const tx = db.transaction(name, 'readonly');
              const st = tx.objectStore(name);
              stores.push({
                name,
                keyPath: st.keyPath,
                autoIncrement: st.autoIncrement,
                indexNames: [...st.indexNames]
              });
            }
            db.close();
            resolve({ database: dbName, version: db.version, stores });
          };
        });
      }, [database], 'MAIN');
    }
  });

  T({
    name: 'idb_read',
    group: 'storage',
    description: 'Read up to `limit` records from an IndexedDB object store. Read-only.',
    parameters: OBJ({ database: STR, store: STR, limit: NUM, tabId: NUM }, ['database', 'store']),
    handler: async ({ database, store, limit = 50, tabId }) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, async (dbName, storeName, lim) => {
        return await new Promise((resolve) => {
          const req = indexedDB.open(dbName);
          req.onerror = () => resolve({ error: req.error?.message || 'open failed' });
          req.onsuccess = () => {
            const db = req.result;
            if (!db.objectStoreNames.contains(storeName)) {
              db.close();
              resolve({ error: `Store "${storeName}" not found` });
              return;
            }
            const tx = db.transaction(storeName, 'readonly');
            const st = tx.objectStore(storeName);
            const out = [];
            const cursorReq = st.openCursor();
            cursorReq.onerror = () => { db.close(); resolve({ error: cursorReq.error?.message || 'cursor failed' }); };
            cursorReq.onsuccess = (e) => {
              const cur = e.target.result;
              if (cur && out.length < lim) {
                try { out.push({ key: cur.key, value: JSON.parse(JSON.stringify(cur.value)) }); }
                catch { out.push({ key: cur.key, value: String(cur.value) }); }
                cur.continue();
              } else {
                db.close();
                resolve({ database: dbName, store: storeName, count: out.length, records: out });
              }
            };
          };
        });
      }, [database, store, limit], 'MAIN');
    }
  });

  // ──────── BULK FORM FILL ────────
  T({
    name: 'page_fill_form',
    group: 'page',
    description: 'Fill multiple form fields in one call. `fields` is an object mapping CSS selector -> value. Submits no form; pair with page_click on the submit button.',
    parameters: OBJ({
      fields: { type: 'object', additionalProperties: STR },
      tabId: NUM
    }, ['fields']),
    handler: async ({ fields, tabId } = {}) => {
      tabId = tabId ?? (await activeTab()).id;
      return scrip(tabId, (map) => {
        const results = [];
        for (const [sel, val] of Object.entries(map)) {
          const el = document.querySelector(sel);
          if (!el) { results.push({ selector: sel, ok: false, error: 'no match' }); continue; }
          el.focus();
          if (el.isContentEditable) { el.textContent = val; }
          else {
            const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
            const setter = Object.getOwnPropertyDescriptor(proto, 'value').set;
            setter.call(el, val);
          }
          el.dispatchEvent(new Event('input', { bubbles: true }));
          el.dispatchEvent(new Event('change', { bubbles: true }));
          results.push({ selector: sel, ok: true });
        }
        return { filled: results.filter(r => r.ok).length, total: results.length, results };
      }, [fields]);
    }
  });
})();
