// Widevine L3 decryptor — PSSH parsing, license server communication,
// and key extraction via browser EME / CDM APIs.
//
// EME only works inside a *page* (MAIN world), not in the extension
// side panel.  The license-request tools therefore inject a self-contained
// async function into the active tab's main world so the CDM can operate.
//
// CRITICAL: Injected functions must ALWAYS resolve (never reject)
// because chrome.scripting.executeScript puts rejections in `error`, not
// `result`, and scrip() only reads `result`.  Errors are indicated by the
// `error` field on the resolved object.
//
// Tools:
//   widevine_parse_pssh         — Parse a base64 PSSH box.
//   widevine_extract_pssh       — Scan MPD / init-segment for PSSH entries.
//   widevine_cdm_info           — Probe whether Widevine L3 is available on
//                                 the active tab.
//   widevine_request_license    — Inject EME flow → generate challenge →
//                                 POST to license server → return keys.
//   widevine_get_content_keys   — Parse PSSH + request license in one call.

(() => {
  'use strict';
  const { T, STR, NUM, BOOL, OBJ, activeTab, scrip } = window.KyotoTR;

  // ═══════════════════════════════════════════════════════════
  //  H E L P E R S   (extension world — no EME here)
  // ═══════════════════════════════════════════════════════════

  function b64ToBytes(b64) {
    const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
    return new Uint8Array([...bin].map(c => c.charCodeAt(0)));
  }

  function bytesToHex(bytes) {
    return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function _dv(buf) {
    return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  function parsePsshBox(buf, offset) {
    if (offset + 12 > buf.length) return null;
    const dv = _dv(buf);
    const size = dv.getUint32(offset);
    if (dv.getUint32(offset + 4) !== 0x70737368) return null;
    if (offset + 28 > buf.length) return null;
    const version = dv.getUint8(offset + 8);
    const flags = (dv.getUint8(offset + 9) << 16) | (dv.getUint8(offset + 10) << 8) | dv.getUint8(offset + 11);
    const systemId = buf.slice(offset + 12, offset + 28);
    let kidCount = 0;
    const kids = [];
    let dataOffset;
    if (version >= 1) {
      if (offset + 32 > buf.length) return null;
      kidCount = dv.getUint32(offset + 28);
      dataOffset = offset + 32;
      if (dataOffset + kidCount * 16 > buf.length) return null;
      for (let i = 0; i < kidCount; i++)
        kids.push(buf.slice(dataOffset + i * 16, dataOffset + (i + 1) * 16));
      dataOffset += kidCount * 16;
    } else {
      dataOffset = offset + 28;
    }
    if (dataOffset + 4 > buf.length) return null;
    const dataSize = dv.getUint32(dataOffset);
    if (dataOffset + 4 + dataSize > buf.length) return null;
    const data = buf.slice(dataOffset + 4, dataOffset + 4 + dataSize);
    return { size, version, flags, dataSize,
             systemId: bytesToHex(systemId),
             keyIds: kids.map(k => bytesToHex(k)),
             data, rawPsshSize: size };
  }

  function findPsshBoxes(buf) {
    const boxes = [];
    const dv = _dv(buf);
    for (let i = 0; i + 12 <= buf.length; i++) {
      try {
        if (dv.getUint32(i + 4) === 0x70737368) {
          const p = parsePsshBox(buf, i);
          if (p) { boxes.push({ offset: i, ...p }); i += Math.max(1, p.size) - 1; }
        }
      } catch {}
    }
    return boxes;
  }

  function extractPsshFromMpd(mpd) {
    const results = [];
    const re = /<cenc:pssh[^>]*>([^<]+)<\/cenc:pssh>/gi;
    let m;
    while ((m = re.exec(mpd))) {
      const b64 = m[1].trim();
      try {
        const buf = b64ToBytes(b64);
        const p = parsePsshBox(buf, 0);
        if (p) results.push({ b64, ...p });
        else results.push({ b64, error: 'Not a valid PSSH box' });
      } catch { results.push({ b64, error: 'Failed to parse' }); }
    }
    return results;
  }

  // ═══════════════════════════════════════════════════════════
  //  T O O L S
  // ═══════════════════════════════════════════════════════════

  T({
    name: 'widevine_parse_pssh',
    group: 'widevine',
    description: 'Parse a base64-encoded PSSH box. Returns system ID, version, flags, key IDs (hex), data size, and human-readable system name.',
    parameters: OBJ({ pssh: STR }, ['pssh']),
    handler: async ({ pssh }) => {
      const buf = b64ToBytes(pssh);
      const p = parsePsshBox(buf, 0);
      if (!p) throw new Error('Not a valid PSSH box');
      const systems = {
        'edef8ba979d64acea3c827dcd51d21ed': 'Widevine',
        '9a04f07998404286ab92e65be0885f95': 'PlayReady',
        '1077efecc0b24d02ace33c1e52e2fb4b': 'W3C Common',
        'f239e769efa348509c16a903c6932efb': 'Primetime',
        'a68129d3475b4f1aaca2512c09dcc2a7': 'FairPlay'
      };
      return {
        size: p.size, version: p.version, flags: p.flags,
        systemId: p.systemId,
        systemIdGuid: p.systemId.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5'),
        systemName: systems[p.systemId] || 'Unknown',
        keyIds: p.keyIds, dataSize: p.dataSize
      };
    }
  });

  T({
    name: 'widevine_extract_pssh',
    group: 'widevine',
    description: 'Extract PSSH boxes from DASH MPD XML or a raw init segment (base64). Searches <cenc:pssh> elements in XML or scans binary for pssh atoms.',
    parameters: OBJ({ mpd: STR, init_segment_b64: STR, url: STR }),
    handler: async ({ mpd, init_segment_b64, url } = {}) => {
      if (mpd) {
        const entries = extractPsshFromMpd(mpd);
        return { source: 'mpd', system: /<ContentProtection/i.test(mpd) ? 'DASH' : 'Unknown', psshEntries: entries };
      }
      if (init_segment_b64) {
        const buf = b64ToBytes(init_segment_b64);
        return { source: 'init-segment', psshBoxes: findPsshBoxes(buf) };
      }
      if (url) {
        const res = await fetch(url, { credentials: 'omit' });
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
        const text = await res.text();
        if (/<cenc:pssh/i.test(text))
          return { source: 'url', system: 'DASH', psshEntries: extractPsshFromMpd(text) };
        const buf = b64ToBytes(text);
        return { source: 'url (binary)', psshBoxes: findPsshBoxes(buf) };
      }
      throw new Error('Provide mpd, init_segment_b64, or url');
    }
  });

  T({
    name: 'widevine_cdm_info',
    group: 'widevine',
    description: 'Probe the active tab to check if Widevine (com.widevine.alpha) is available. Returns CDM status, robustness levels, and whether persistent state is supported. Use this to confirm the page can run EME before calling other widevine tools.',
    parameters: OBJ({ tabId: NUM }),
    handler: async ({ tabId } = {}) => {
      const t = tabId != null ? await chrome.tabs.get(tabId) : await activeTab();
      return scrip(t.id, function() {
        try {
          if (typeof navigator === 'undefined' || !navigator.requestMediaKeySystemAccess)
            return { available: false, error: 'requestMediaKeySystemAccess not available' };
          return navigator.requestMediaKeySystemAccess('com.widevine.alpha', [{
            initDataTypes: ['cenc', 'webm'],
            videoCapabilities: [{ contentType: 'video/mp4;codecs="avc1.4d401e"' }],
            audioCapabilities: [{ contentType: 'audio/mp4;codecs="mp4a.40.2"' }],
            distinctiveIdentifier: 'optional',
            persistentState: 'optional',
            sessionTypes: ['temporary', 'persistent-license']
          }]).then(function(access) {
            var cfg = access.getConfiguration();
            return {
              available: true, keySystem: access.keySystem,
              distinctiveIdentifier: cfg.distinctiveIdentifier,
              persistentState: cfg.persistentState,
              sessionTypes: cfg.sessionTypes,
              audioContentTypes: (cfg.audioCapabilities || []).map(function(c) { return c.contentType; }),
              videoContentTypes: (cfg.videoCapabilities || []).map(function(c) { return c.contentType; }),
              initDataTypes: cfg.initDataTypes
            };
          }).catch(function(e) {
            return { available: false, error: e.message || String(e) };
          });
        } catch (e) {
          return { available: false, error: e.message || String(e) };
        }
      }, [], 'MAIN');
    }
  });

  // ═══════════════════════════════════════════════════════════
  //  S H A R E D    E M E    I N J E C T E D    F U N C T I O N
  //
  // Both widevine_request_license and widevine_get_content_keys
  // need to run a full EME license-request flow inside the page's
  // MAIN world.  Instead of duplicating the logic we define a
  // single helper and pass a mode flag.
  //
  // IMPORTANT: this function MUST always resolve (never reject).
  // Errors are in the `error` field of the resolved object.
  // ═══════════════════════════════════════════════════════════

  /**
   * Run the full EME license flow inside the target tab's MAIN world.
   *
   * @param {object} param0
   * @param {string}  param0.psshB64        - base64 PSSH init data
   * @param {string}  param0.licenseUrl     - license server URL
   * @param {object|null} param0.headersObj - extra headers for license POST
   * @param {boolean} param0.challengeOnly  - stop after generating challenge
   * @returns {Promise<object>}  { keys?, challengeHex?, sessionId?, error? }
   */
  async function emeFlowInPage({ psshB64, licenseUrl, headersObj, challengeOnly, tabId }) {
    const tab = tabId != null ? await chrome.tabs.get(tabId) : await activeTab();

    /**
     * ╔══════════════════════════════════════════════════════╗
     * ║  THIS FUNCTION RUNS IN THE  P A G E   MAIN WORLD   ║
     * ║  — no outer references, fully self-contained —      ║
     * ║  — ALWAYS resolves, errors in `error` field —       ║
     * ╚══════════════════════════════════════════════════════╝
     */
    function pageEmeFlow(psshB64, licenseUrl, headersObj, challengeOnly) {
      function _b64ToBytes(b64) {
        var bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
        var out = new Uint8Array(bin.length);
        for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
        return out;
      }
      function _hex(buf) {
        var h = '';
        for (var i = 0; i < buf.length; i++) h += buf[i].toString(16).padStart(2, '0');
        return h;
      }

      var cfg = [{
        initDataTypes: ['cenc', 'webm'],
        videoCapabilities: [{ contentType: 'video/mp4;codecs="avc1.4d401e"' }],
        audioCapabilities: [{ contentType: 'audio/mp4;codecs="mp4a.40.2"' }],
        distinctiveIdentifier: 'optional',
        persistentState: 'required',
        sessionTypes: ['temporary', 'persistent-license']
      }];

      return new Promise(function(resolve) {
        var settled = false, tid = null, iid = null;

        function cleanup() {
          if (tid != null) { clearTimeout(tid); tid = null; }
          if (iid != null) { clearInterval(iid); iid = null; }
        }
        function ok(val) {
          if (settled) return;
          settled = true; cleanup(); resolve(val);
        }
        function err(msg) {
          if (settled) return;
          settled = true; cleanup(); resolve({ error: msg });
        }
        function collectKeys(session) {
          var keys = [], usable = [];
          session.keyStatuses.forEach(function(st, kid) {
            var k = { kid: _hex(new Uint8Array(kid)), status: st };
            keys.push(k);
            if (st === 'usable') usable.push(k.kid);
          });
          return { keys: keys, usableKeys: usable, success: usable.length > 0 };
        }

        // ── start ──
        var initData;
        try { initData = _b64ToBytes(psshB64); } catch (e) { return err('Invalid PSSH base64'); }

        // Wrap in try so a synchronous throw (e.g. requestMediaKeySystemAccess
        // missing entirely) still routes through err() instead of escaping
        // the Promise body as a bare TypeError.
        try {
          navigator.requestMediaKeySystemAccess('com.widevine.alpha', cfg).then(function(access) {
            return access.createMediaKeys();
          }).then(function(mk) {
          var session = mk.createSession('temporary');
          var requestSent = false;

          session.addEventListener('message', function(event) {
            if (settled) return;
            if (event.messageType === 'individualization-request') {
              return err('Device needs provisioning (individualization required)');
            }
            if (event.messageType !== 'license-request') return;
            if (requestSent) return;
            requestSent = true;

            var challenge = new Uint8Array(event.message);

            if (challengeOnly) {
              return ok({
                challengeHex: _hex(challenge),
                challengeBytes: challenge.length,
                sessionId: session.sessionId || ''
              });
            }

            // POST to license server
            var hdrs = { 'Content-Type': 'application/octet-stream' };
            if (headersObj) {
              var hk = Object.keys(headersObj);
              for (var i = 0; i < hk.length; i++) hdrs[hk[i]] = headersObj[hk[i]];
            }

            fetch(licenseUrl, {
              method: 'POST',
              headers: hdrs,
              body: challenge.buffer.slice(challenge.byteOffset, challenge.byteOffset + challenge.byteLength),
              credentials: 'omit'
            }).then(function(res) {
              if (!res.ok) {
                return res.text().catch(function() { return ''; }).then(function(t) {
                  err('License server HTTP ' + res.status + (t ? ': ' + t.slice(0, 400) : ''));
                });
              }
              return res.arrayBuffer()
                .then(function(buf) { return session.update(new Uint8Array(buf)); })
                .catch(function(e) { err('session.update failed: ' + (e.message || String(e))); });
            }).catch(function(e) {
              err('License fetch failed: ' + (e.message || String(e)));
            });
          });

          session.addEventListener('keystatuseschange', function() {
            if (session.keyStatuses.size > 0) ok(collectKeys(session));
          });

          // belt-and-braces poll — some CDMs don't fire the event
          iid = setInterval(function() {
            if (!settled && session.keyStatuses.size > 0) ok(collectKeys(session));
          }, 250);

          tid = setTimeout(function() {
            if (!settled) err('License request timed out after 35s');
          }, 35000);

          return session.generateRequest('cenc', initData);
        }).catch(function(e) {
          err('EME setup failed: ' + (e.message || String(e)));
        });
        } catch (e) {
          err('EME setup failed: ' + (e.message || String(e)));
        }
      });
    }

    const result = await scrip(tab.id, pageEmeFlow,
      [psshB64, licenseUrl, headersObj, !!challengeOnly], 'MAIN');

    if (!result) throw new Error('EME injection returned nothing');
    if (result.error) throw new Error(result.error);
    return result;
  }

  // ═══════════════════════════════════════════════════════════
  //  widevine_request_license
  // ═══════════════════════════════════════════════════════════

  T({
    name: 'widevine_request_license',
    group: 'widevine',
    description: 'Request a Widevine license from a license server. Injects the EME flow into the active page\'s MAIN world so the CDM can generate a challenge. POSTs the challenge to the license server with optional custom headers (e.g. Authorization, x-cr-video-token), then returns key IDs and statuses. Set challenge_only=true to get just the challenge without contacting the server.',
    parameters: OBJ({
      license_url: STR,
      pssh: STR,
      headers: OBJ(),
      challenge_only: BOOL,
      tabId: NUM
    }, ['license_url', 'pssh']),
    handler: async ({ license_url, pssh, headers, challenge_only, tabId } = {}) => {
      if (!pssh) throw new Error('pssh required');
      if (!challenge_only && !license_url) throw new Error('license_url required (or set challenge_only: true)');
      return emeFlowInPage({
        psshB64: pssh,
        licenseUrl: license_url || '',
        headersObj: headers || null,
        challengeOnly: !!challenge_only,
        tabId
      });
    }
  });

  // ═══════════════════════════════════════════════════════════
  //  widevine_get_content_keys
  // ═══════════════════════════════════════════════════════════

  T({
    name: 'widevine_get_content_keys',
    group: 'widevine',
    description: 'Parse a PSSH and request a Widevine license from the server in one call. Runs EME in the page\'s MAIN world. Supply auth headers (e.g. Authorization, x-cr-video-token) for services like Crunchyroll that require tokens. Returns key IDs with CDM statuses (usable/expired/output-restricted) plus basic PSSH metadata.',
    parameters: OBJ({
      license_url: STR,
      pssh: STR,
      headers: OBJ(),
      tabId: NUM
    }, ['license_url', 'pssh']),
    handler: async ({ license_url, pssh, headers, tabId } = {}) => {
      if (!pssh) throw new Error('pssh required');
      if (!license_url) throw new Error('license_url required');

      let psshInfo = null;
      try {
        const buf = b64ToBytes(pssh);
        const p = parsePsshBox(buf, 0);
        if (p) {
          psshInfo = {
            systemId: p.systemId,
            systemIdGuid: p.systemId.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5'),
            systemName: p.systemId === 'edef8ba979d64acea3c827dcd51d21ed' ? 'Widevine' : 'Unknown',
            keyIds: p.keyIds, dataSize: p.dataSize
          };
        }
      } catch {}

      const result = await emeFlowInPage({
        psshB64: pssh,
        licenseUrl: license_url,
        headersObj: headers || null,
        challengeOnly: false,
        tabId
      });

      return { ...result, psshInfo };
    }
  });

})();
