// Widevine L3 decryptor — PSSH parsing, license server communication,
// and key extraction via browser EME / CDM APIs.
//
// Tools:
//   widevine_parse_pssh         — Parse a base64 PSSH box into system ID, key IDs, version.
//   widevine_extract_pssh       — Scan MPD/manifest text for PSSH entries; also accepts
//                                 raw init-segment bytes (base64).
//   widevine_request_license    — Use the browser's EME CDM to generate a license request for
//                                 a PSSH, POST it to a license server, and return keys.
//   widevine_get_content_keys   — Convenience: parse PSSH + request license in one call.

(() => {
  'use strict';
  const { T, STR, NUM, BOOL, OBJ, bg } = window.KyotoTR;

  // ── helpers: PSSH parsing ─────────────────────────────

  function b64ToBytes(b64) {
    const bin = atob(b64.replace(/-/g, '+').replace(/_/g, '/'));
    return new Uint8Array([...bin].map(c => c.charCodeAt(0)));
  }

  function bytesToB64(bytes) {
    const bin = String.fromCharCode(...bytes);
    return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  }

  function bytesToHex(bytes) {
    return [...bytes].map(b => b.toString(16).padStart(2, '0')).join('');
  }

  function hexToBytes(hex) {
    const out = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2) out[i / 2] = parseInt(hex.substr(i, 2), 16);
    return out;
  }

  // DataView must use the typed-array's own byteOffset / byteLength,
  // otherwise reads against a subview land in the wrong slice of the
  // underlying ArrayBuffer.
  function _dv(buf) {
    return new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
  }

  function parsePsshBox(buf, offset) {
    if (offset + 12 > buf.length) return null;
    const dv = _dv(buf);
    const size = dv.getUint32(offset);
    const pssh = dv.getUint32(offset + 4);
    if (pssh !== 0x70737368) return null; // 'pssh'
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
      for (let i = 0; i < kidCount; i++) {
        kids.push(buf.slice(dataOffset + i * 16, dataOffset + (i + 1) * 16));
      }
      dataOffset += kidCount * 16;
    } else {
      dataOffset = offset + 28;
    }
    if (dataOffset + 4 > buf.length) return null;
    const dataSize = dv.getUint32(dataOffset);
    if (dataOffset + 4 + dataSize > buf.length) return null;
    const data = buf.slice(dataOffset + 4, dataOffset + 4 + dataSize);
    return {
      size, version, flags,
      systemId: bytesToHex(systemId),
      systemIdBytes: bytesToB64(systemId),
      keyIds: kids.map(k => bytesToHex(k)),
      dataSize,
      data: bytesToB64(data)
    };
  }

  function findPsshBoxes(buf) {
    const boxes = [];
    const dv = _dv(buf);
    for (let i = 0; i + 12 <= buf.length; i++) {
      try {
        if (dv.getUint32(i + 4) === 0x70737368) {
          const pssh = parsePsshBox(buf, i);
          if (pssh) {
            boxes.push({ offset: i, ...pssh });
            i += Math.max(1, pssh.size) - 1;
          }
        }
      } catch {}
    }
    return boxes;
  }

  // ── MPD helpers ────────

  function extractPsshFromMpd(mpd) {
    const results = [];
    const psshRegex = /<cenc:pssh[^>]*>([^<]+)<\/cenc:pssh>/gi;
    let m;
    while ((m = psshRegex.exec(mpd))) {
      const psshB64 = m[1].trim();
      try {
        const buf = b64ToBytes(psshB64);
        const parsed = parsePsshBox(buf, 0);
        results.push({ b64: psshB64, ...parsed });
      } catch {
        results.push({ b64: psshB64, error: 'Failed to parse PSSH' });
      }
    }
    return results;
  }

  // ── EME license flow ──────────────────────────────────

  const WIDEVINE_SYSTEM_ID = 'edef8ba979d64acea3c827dcd51d21ed';

  function toUint8Array(data) {
    if (data instanceof Uint8Array) return data;
    if (typeof data === 'string') return b64ToBytes(data);
    if (Array.isArray(data)) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    throw new Error('Cannot convert to Uint8Array');
  }

  async function getKeySystemConfig() {
    return [
      {
        initDataTypes: ['cenc', 'webm', 'keyids'],
        videoCapabilities: [{ contentType: 'video/mp4;codecs="avc1.4d401e"' }],
        audioCapabilities: [{ contentType: 'audio/mp4;codecs="mp4a.40.2"' }],
        distinctiveIdentifier: 'optional',
        persistentState: 'required',
        sessionTypes: ['temporary', 'persistent-license']
      }
    ];
  }

  // ── TOOLS ────────

  T({
    name: 'widevine_parse_pssh',
    group: 'widevine',
    description: 'Parse a base64-encoded PSSH box. Returns system ID (hex), version, flags, key IDs (hex), and raw data fields. The Widevine system ID is edef8ba9-79d6-4ace-a3c8-27dcd51d21ed.',
    parameters: OBJ({ pssh: STR }, ['pssh']),
    handler: async ({ pssh }) => {
      if (!pssh) throw new Error('pssh required (base64 string)');
      const buf = b64ToBytes(pssh);
      const parsed = parsePsshBox(buf, 0);
      if (!parsed) throw new Error('Not a valid PSSH box');
      const knownSystems = {
        'edef8ba979d64acea3c827dcd51d21ed': 'Widevine',
        '9a04f07998404286ab92e65be0885f95': 'PlayReady',
        '1077efecc0b24d02ace33c1e52e2fb4b': 'W3C Common',
        'f239e769efa348509c16a903c6932efb': 'Primetime',
        'a68129d3475b4f1aaca2512c09dcc2a7': 'FairPlay'
      };
      return {
        ...parsed,
        systemName: knownSystems[parsed.systemId] || 'Unknown',
        systemIdGuid: parsed.systemId.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
      };
    }
  });

  T({
    name: 'widevine_extract_pssh',
    group: 'widevine',
    description: 'Extract PSSH boxes from DASH MPD XML or from a raw init segment (provided as base64). Searches for <cenc:pssh> elements in XML or scans the binary for pssh atoms. Returns all found PSSH entries with parsed key IDs and system IDs.',
    parameters: OBJ({
      mpd: STR,
      init_segment_b64: STR,
      url: STR
    }),
    handler: async ({ mpd, init_segment_b64, url } = {}) => {
      let content = mpd;
      if (!content && init_segment_b64) {
        const buf = b64ToBytes(init_segment_b64);
        const boxes = findPsshBoxes(buf);
        return {
          source: 'init-segment',
          psshBoxes: boxes
        };
      }
      if (!content && url) {
        const res = await fetch(url, { credentials: 'omit' });
        if (!res.ok) throw new Error(`HTTP ${res.status} fetching ${url}`);
        content = await res.text();
      }
      if (!content) throw new Error('Provide mpd, init_segment_b64, or url');
      if (/<cenc:pssh/i.test(content)) {
        const psshEntries = extractPsshFromMpd(content);
        return {
          source: mpd ? 'mpd' : 'url',
          system: /<ContentProtection/i.test(content) ? 'DASH' : 'Unknown',
          psshEntries
        };
      }
      const buf = b64ToBytes(content);
      const boxes = findPsshBoxes(buf);
      return {
        source: 'raw-data',
        psshBoxes: boxes
      };
    }
  });

  T({
    name: 'widevine_request_license',
    group: 'widevine',
    description: 'Request a Widevine license from a license server. Uses the browser CDM to generate a proper license challenge from the PSSH, sends it to the license server, and processes the response. Returns the license response content (base64) and any extracted metadata. Set challenge_only=true to get the license challenge without sending it.',
    parameters: OBJ({
      license_url: STR,
      pssh: STR,
      headers: OBJ(),
      challenge_only: BOOL,
      session_type: { type: 'string', enum: ['temporary', 'persistent-license'] }
    }, ['license_url', 'pssh']),
    handler: async ({ license_url, pssh, headers, challenge_only, session_type } = {}) => {
      if (!pssh) throw new Error('pssh required');
      if (!challenge_only && !license_url) throw new Error('license_url required (or set challenge_only: true)');
      const initData = b64ToBytes(pssh);

      const keySystemAccess = await navigator.requestMediaKeySystemAccess(
        'com.widevine.alpha',
        await getKeySystemConfig()
      );
      const mediaKeys = await keySystemAccess.createMediaKeys();
      const session = mediaKeys.createSession(session_type || 'temporary');

      return new Promise((resolve, reject) => {
        let settled = false;
        let licenseInfo = null;
        let timeoutHandle = null;
        let intervalHandle = null;

        const cleanup = () => {
          if (timeoutHandle != null) { clearTimeout(timeoutHandle); timeoutHandle = null; }
          if (intervalHandle != null) { clearInterval(intervalHandle); intervalHandle = null; }
        };
        const done = (resOrErr, isErr = false) => {
          if (settled) return;
          settled = true;
          cleanup();
          isErr ? reject(resOrErr) : resolve(resOrErr);
        };

        const onMessage = async (event) => {
          if (settled) return;
          if (event.messageType === 'individualization-request') {
            done({
              error: 'Individualization required. This device needs provisioning before license requests.',
              sessionId: session.sessionId
            });
            return;
          }
          if (event.messageType !== 'license-request') return;

          const challenge = new Uint8Array(event.message);
          if (challenge_only) {
            done({
              challenge: bytesToB64(challenge),
              challengeHex: bytesToHex(challenge),
              challengeBytes: challenge.length,
              sessionId: session.sessionId,
              messageType: event.messageType
            });
            return;
          }
          try {
            const res = await fetch(license_url, {
              method: 'POST',
              headers: { 'Content-Type': 'application/octet-stream', ...(headers || {}) },
              body: challenge.buffer.slice(challenge.byteOffset, challenge.byteOffset + challenge.byteLength),
              credentials: 'omit'
            });
            if (!res.ok) {
              const errBody = await res.text().catch(() => '');
              done(new Error(`License server returned HTTP ${res.status}${errBody ? ': ' + errBody.slice(0, 200) : ''}`), true);
              return;
            }
            const licenseBuf = await res.arrayBuffer();
            licenseInfo = { licenseSize: licenseBuf.byteLength };
            await session.update(new Uint8Array(licenseBuf));
            // session.update doesn't directly emit a useful event; the
            // CDM may fire keystatuseschange. If keys are already there
            // resolve now; otherwise let the keystatuseschange poll do it.
            if (session.keyStatuses.size > 0) finalize();
          } catch (e) {
            done(new Error(`License request failed: ${e.message}`), true);
          }
        };

        const finalize = () => {
          if (settled) return;
          const keys = [];
          session.keyStatuses.forEach((status, keyId) => {
            keys.push({ kid: bytesToHex(new Uint8Array(keyId)), status });
          });
          done({
            success: keys.some(k => k.status === 'usable'),
            sessionId: session.sessionId,
            licenseServerResponse: licenseInfo,
            keys,
            note: keys.length === 0
              ? 'No keys were obtained. The license server may require additional headers, a token, or device provisioning.'
              : undefined
          });
        };

        session.addEventListener('message', onMessage);
        session.addEventListener('keystatuseschange', () => {
          if (session.keyStatuses.size > 0) finalize();
        });

        // Belt-and-braces: some CDMs don't fire keystatuseschange after
        // session.update — poll briefly so we still return.
        intervalHandle = setInterval(() => {
          if (session.keyStatuses.size > 0) finalize();
        }, 250);

        timeoutHandle = setTimeout(() => {
          if (session.keyStatuses.size > 0) finalize();
          else done(new Error('License request timed out after 30s'), true);
        }, 30000);

        session.generateRequest('cenc', initData).catch(e => done(e, true));
      });
    }
  });

  T({
    name: 'widevine_get_content_keys',
    group: 'widevine',
    description: 'Convenience tool: parse a PSSH and request a Widevine license from the server in one call. Returns key IDs and their statuses. Equivalent to calling widevine_parse_pssh followed by widevine_request_license with the parsed PSSH.',
    parameters: OBJ({
      license_url: STR,
      pssh: STR,
      headers: OBJ()
    }, ['license_url', 'pssh']),
    handler: async ({ license_url, pssh, headers } = {}) => {
      const buf = b64ToBytes(pssh);
      const parsed = parsePsshBox(buf, 0);
      if (!parsed) throw new Error('Invalid PSSH box');

      const initData = buf;
      const keySystemConfig = await getKeySystemConfig();
      const keySystemAccess = await navigator.requestMediaKeySystemAccess(
        'com.widevine.alpha',
        keySystemConfig
      );

      const mediaKeys = await keySystemAccess.createMediaKeys();
      const session = mediaKeys.createSession('temporary');

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          reject(new Error('License request timed out after 30s'));
        }, 30000);

        let messageHandler;
        messageHandler = async (event) => {
          if (event.messageType === 'individualization-request') {
            clearTimeout(timeout);
            resolve({
              error: 'Individualization required',
              psshInfo: {
                systemId: parsed.systemId,
                keyIds: parsed.keyIds,
                systemIdGuid: parsed.systemId.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5')
              }
            });
            return;
          }

          if (event.messageType !== 'license-request') return;

          const challenge = new Uint8Array(event.message);
          try {
            const fetchHeaders = { 'Content-Type': 'application/octet-stream', ...(headers || {}) };
            const res = await fetch(license_url, {
              method: 'POST',
              headers: fetchHeaders,
              body: challenge.buffer.slice(0),
              credentials: 'omit'
            });

            if (!res.ok) {
              const errBody = await res.text().catch(() => '');
              clearTimeout(timeout);
              reject(new Error(`License server HTTP ${res.status}: ${errBody.slice(0, 200)}`));
              return;
            }

            const licenseBuf = await res.arrayBuffer();
            await session.update(new Uint8Array(licenseBuf));
          } catch (e) {
            clearTimeout(timeout);
            reject(e);
          }
        };

        session.addEventListener('message', messageHandler);

        session.addEventListener('keystatuseschange', () => {
          const kidList = [];
          const allUsable = [];
          session.keyStatuses.forEach((status, keyId) => {
            const kidHex = bytesToHex(new Uint8Array(keyId));
            kidList.push({ kid: kidHex, status });
            if (status === 'usable') allUsable.push(kidHex);
          });

          if (kidList.length > 0) {
            clearTimeout(timeout);
            session.removeEventListener('message', messageHandler);
            resolve({
              success: allUsable.length > 0,
              psshInfo: {
                systemId: parsed.systemId,
                systemIdGuid: parsed.systemId.replace(/(.{8})(.{4})(.{4})(.{4})(.{12})/, '$1-$2-$3-$4-$5'),
                keyIds: parsed.keyIds
              },
              keys: kidList,
              usableKeys: allUsable,
              sessionId: session.sessionId,
              note: allUsable.length === 0 && kidList.length > 0
                ? 'Keys were returned but none are marked as "usable" by the CDM.'
                : undefined
            });
          }
        });

        session.generateRequest('cenc', initData).catch((e) => {
          clearTimeout(timeout);
          reject(new Error(`generateRequest failed: ${e.message}`));
        });
      });
    }
  });

})();
