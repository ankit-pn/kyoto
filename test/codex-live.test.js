// Live end-to-end test: hit the real chatgpt.com Codex backend with a
// known-good token, run the raw response bytes through Kyoto's actual
// SSE wrapper + parser, and assert we accumulate text correctly.
//
// Skips itself if KYOTO_CODEX_TOKEN + KYOTO_CODEX_ACCOUNT aren't in env.

const fs = require('fs');
const path = require('path');

const TOKEN = process.env.KYOTO_CODEX_TOKEN;
const ACCOUNT = process.env.KYOTO_CODEX_ACCOUNT;
if (!TOKEN || !ACCOUNT) {
  console.log('SKIP — set KYOTO_CODEX_TOKEN + KYOTO_CODEX_ACCOUNT to run');
  process.exit(0);
}

const src = fs.readFileSync(path.join(__dirname, '..', 'sidepanel', 'sidepanel.js'), 'utf8');
function extractFn(name) {
  const start = src.indexOf(`function ${name}(`);
  if (start < 0) throw new Error(`${name} not found`);
  const open = src.indexOf('{', start);
  let depth = 0, i = open;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (!depth) { i++; break; } }
  }
  return src.slice(start, i);
}
const ToChatLines = new Function(`${extractFn('_responsesEventToChatLines')}\nreturn _responsesEventToChatLines;`)();

(async () => {
  const body = {
    model: 'gpt-5.5',
    instructions: 'You are helpful.',
    input: [{ role: 'user', content: [{ type: 'input_text', text: 'hi, in 6 words' }] }],
    stream: true,
    store: false,
    reasoning: { effort: 'medium', summary: 'auto' },
  };
  process.stdout.write('→ POST chatgpt.com/backend-api/codex/responses\n');
  const t0 = Date.now();
  const res = await fetch('https://chatgpt.com/backend-api/codex/responses', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${TOKEN}`,
      'ChatGPT-Account-ID': ACCOUNT,
      'Content-Type': 'application/json',
      'Accept': 'text/event-stream',
      'Originator': 'codex_cli_rs',
      'originator': 'codex_cli_rs',
      'x-client-request-id': crypto.randomUUID(),
    },
    body: JSON.stringify(body),
  });
  process.stdout.write(`← HTTP ${res.status} in ${Date.now() - t0}ms\n`);
  if (!res.ok) {
    const t = await res.text();
    process.stdout.write(`error body: ${t.slice(0, 500)}\n`);
    process.exit(1);
  }

  // Run Kyoto's SSE wrapper logic verbatim.
  const ctx = { toolIndex: {}, nextToolIdx: 0, errorMessage: null, emittedDeltas: 0, emittedFinish: false, seenEventTypes: new Set(), rawEvents: [] };
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let textAcc = '';
  let chunkCount = 0;
  let firstChunkAt = null;
  const lines = [];
  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    if (firstChunkAt === null) firstChunkAt = Date.now() - t0;
    chunkCount++;
    buffer += decoder.decode(value, { stream: true });
    const norm = buffer.replace(/\r\n/g, '\n');
    const events = norm.split('\n\n');
    buffer = events.pop() || '';
    for (const raw of events) {
      if (!raw.trim()) continue;
      let evType = null;
      const dataLines = [];
      for (const ln of raw.split('\n')) {
        if (ln.startsWith('event:')) evType = ln.slice(6).trim();
        else if (ln.startsWith('data:')) dataLines.push(ln.slice(5).trim());
      }
      if (!dataLines.length) continue;
      const payload = dataLines.join('\n');
      if (payload === '[DONE]') continue;
      let parsed;
      try { parsed = JSON.parse(payload); } catch { continue; }
      if (!parsed.type && evType) parsed.type = evType;
      if (parsed.type) ctx.seenEventTypes.add(parsed.type);
      const outLines = ToChatLines(parsed, ctx);
      for (const ln of outLines) {
        if (ln === '[DONE]') continue;
        try {
          const j = JSON.parse(ln);
          const content = j.choices?.[0]?.delta?.content;
          if (typeof content === 'string') textAcc += content;
        } catch {}
      }
    }
  }
  process.stdout.write(`first chunk: ${firstChunkAt}ms, total chunks: ${chunkCount}\n`);
  process.stdout.write(`seen events: ${[...ctx.seenEventTypes].join(', ')}\n`);
  process.stdout.write(`emitted chat deltas: ${ctx.emittedDeltas}\n`);
  process.stdout.write(`emitted finish: ${ctx.emittedFinish}\n`);
  process.stdout.write(`reconstructed text: ${JSON.stringify(textAcc)}\n`);
  if (!textAcc) {
    process.stdout.write('FAIL — no text reconstructed despite OK response\n');
    process.exit(2);
  }
  process.stdout.write('PASS\n');
})().catch(e => { console.error('crashed:', e); process.exit(3); });
