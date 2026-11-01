// Provider layer — definitions + pure helpers for the non-trivial providers.
//
// Loaded before sidepanel.js as a plain IIFE that attaches `window.KyotoProviders`.
// Everything exported here is a PURE function (no chrome.* access, no DOM) so it
// can be unit-tested in node via a VM sandbox — see test/providers.test.js.
//
// Two providers live here because they need more than a static config:
//   * OpenRouter — rich per-model metadata, provider routing, structured reasoning.
//   * OpenCode Go — subscription gateway that requires a per-conversation header.
//
// The generic providers (deepseek / openai / minimax) stay in sidepanel.js;
// sidepanel.js merges these definitions into its PROVIDERS map.
//
// ── OpenRouter notes (verified 2026-11-01) ─────────────────────────────
//   * `usage:{include:true}` and `stream_options.include_usage` are BOTH
//     deprecated no-ops — usage is always returned. We still send
//     `include_usage` for SDK-shaped compatibility; it is harmless.
//   * `transforms` no longer exists; `route` is a deprecated alias for
//     `provider.sort.partition`. We send neither.
//   * Reasoning: canonical output is `reasoning` (string|null) plus
//     `reasoning_details` (array). There is no `reasoning_content` on the
//     response side (it is an *input* alias) and no `delta.thinking`.
//   * For agentic tool loops `reasoning_details` MUST be echoed back
//     verbatim and in order, encrypted blocks included.
//   * `tools`/`response_format` are silently dropped unless some provider
//     supports them, so set `provider.require_parameters = true`.
//   * Cost is `usage.cost` (not `total_cost`, which is /generations only).
//   * Keep-alive lines start with `:` and must never reach JSON.parse.
//   * Mid-stream failures arrive in-band: a top-level `error` plus
//     `finish_reason:"error"` while the HTTP status stays 200.
//   * Model ids carry two different kinds of suffix: *catalog* variants
//     (`:free`, `:batch`) are real entries with their own metadata, while
//     *routing* variants (`:nitro`, `:floor`, `:exacto`) are request-time
//     toggles that must not be sent to metadata lookups.
//
// ── OpenCode Go notes (verified 2026-11-01) ────────────────────────────
//   * Go is a subscription gateway: base path /inference/go (pay-as-you-go
//     is /inference). Chat Completions lives under
//     /inference/go/openai/v1/chat/completions.
//   * Every request MUST carry `x-opencode-session: ses_…` (stable per
//     conversation); omitting it yields HTTP 400 MissingSessionID *before*
//     auth is evaluated.
//   * `GET /inference/go/v1/models` is public (no auth) and is NOT under the
//     /openai/v1 prefix — do not let an SDK append /models.
//   * Reasoning deltas arrive as `reasoning_content`; usage carries
//     `usage.cost` and `usage.opencode.billing_source`.

(() => {
  'use strict';

  // ── Small utilities ──────────────────────────────────
  const str = (v) => (typeof v === 'string' ? v : '');
  const num = (v) => {
    const n = typeof v === 'number' ? v : parseFloat(v);
    return Number.isFinite(n) ? n : null;
  };
  // pricing values are decimal strings in USD per *token* (not per million).
  const price = (v) => {
    const n = num(v);
    return n == null ? null : n;
  };

  // ── OpenRouter ───────────────────────────────────────
  // Catalog variants that are real, selectable models (own pricing/limits).
  const OR_CATALOG_VARIANTS = [':free', ':batch'];
  // Routing variants: request-time toggles, never part of the catalog id.
  const OR_ROUTING_VARIANTS = [':nitro', ':floor', ':exacto'];
  // Never offered: deprecated / hard-fail.
  const OR_DEAD_VARIANTS = [':online', ':extended', ':thinking'];

  /**
   * Split an OpenRouter model id into its catalog id and any routing variants.
   *   "openai/gpt-5.2:nitro:exacto" -> { catalogId: "openai/gpt-5.2",
   *                                      routing: [":nitro", ":exacto"] }
   *   "deepseek/deepseek-r1:free"   -> { catalogId: "deepseek/deepseek-r1:free",
   *                                      routing: [] }
   * Catalog suffixes are preserved (stripping :free would resolve to the paid
   * entry with the wrong context/pricing); routing suffixes are dropped from
   * the lookup key but re-appended at request time.
   */
  function splitModelId(rawId) {
    const id = str(rawId);
    if (!id) return { catalogId: '', routing: [] };
    const parts = id.split(':');
    if (parts.length === 1) return { catalogId: id, routing: [] };
    const head = parts[0];
    const suffixes = parts.slice(1).map((s) => ':' + s);
    let catalogId = head;
    const routing = [];
    for (const suf of suffixes) {
      if (OR_DEAD_VARIANTS.includes(suf)) continue;      // never send
      if (OR_CATALOG_VARIANTS.includes(suf)) { catalogId += suf; continue; }
      if (OR_ROUTING_VARIANTS.includes(suf)) { routing.push(suf); continue; }
      // Unknown suffix: keep it on the catalog id so we don't corrupt a real id.
      catalogId += suf;
    }
    return { catalogId, routing };
  }

  /** Provider routing variant currently selected in settings, e.g. ":exacto". */
  function orRoutingVariant(settings) {
    const v = str(settings?.orVariant);
    return OR_ROUTING_VARIANT_SET.has(v) ? v : '';
  }
  const OR_ROUTING_VARIANT_SET = new Set(OR_ROUTING_VARIANTS);

  /** The model id to put on the wire: catalog id + selected routing variant. */
  function orRequestModelId(model, settings) {
    const { catalogId, routing } = splitModelId(model);
    const extra = orRoutingVariant(settings);
    const all = [...routing];
    if (extra && !all.includes(extra)) all.push(extra);
    return catalogId + all.join('');
  }

  const OR_REASONING_EFFORTS = ['minimal', 'low', 'medium', 'high', 'xhigh', 'max'];

  /**
   * Parse GET https://openrouter.ai/api/v1/models into picker entries.
   * Drops models that cannot return text (image generation etc.).
   */
  function orParseModels(data) {
    const list = Array.isArray(data?.data) ? data.data : [];
    const out = [];
    for (const m of list) {
      const id = str(m?.id);
      if (!id) continue;
      if (OR_DEAD_VARIANTS.some((s) => id.endsWith(s))) continue;
      const arch = m.architecture || {};
      const outMods = Array.isArray(arch.output_modalities) ? arch.output_modalities : null;
      // Text chat only: skip image/audio-output models (they 400 on tools).
      if (outMods && !outMods.includes('text')) continue;
      const inMods = Array.isArray(arch.input_modalities) ? arch.input_modalities : [];
      const params = Array.isArray(m.supported_parameters) ? m.supported_parameters : [];
      const vendor = id.includes('/') ? id.split('/')[0] : 'other';
      const tp = m.top_provider || {};
      const context = num(m.context_length) || num(tp.context_length) || null;
      // max output: top_provider is a per-request ceiling; fall back to context.
      const maxOutput = num(tp.max_completion_tokens) || (context ? Math.min(context, 8192) : null);
      const reasoningMeta = m.reasoning && typeof m.reasoning === 'object' ? m.reasoning : null;
      out.push({
        id,
        name: str(m.name) || id,
        group: vendor,
        context,
        maxOutput,
        supportsTools: params.includes('tools'),
        vision: inMods.includes('image'),
        modalities: { input: inMods, output: outMods || ['text'] },
        reasoning: reasoningMeta
          ? {
              supported: true,
              mandatory: reasoningMeta.mandatory === true,
              defaultEnabled: reasoningMeta.default_enabled,
              efforts: Array.isArray(reasoningMeta.supported_efforts) ? reasoningMeta.supported_efforts : [],
              defaultEffort: reasoningMeta.default_effort || null,
              supportsMaxTokens: reasoningMeta.supports_max_tokens === true
            }
          : null,
        supportsStructuredOutputs: params.includes('structured_outputs'),
        pricing: m.pricing ? { prompt: price(m.pricing.prompt), completion: price(m.pricing.completion) } : null,
        canonicalSlug: str(m.canonical_slug) || id
      });
    }
    return out;
  }

  /**
   * Extra request-body fields for OpenRouter.
   * @param {{model:string, settings:object, hasTools:boolean, hasStructuredOutput:boolean}} ctx
   */
  function orBuildExtras(ctx) {
    const { settings = {}, hasTools = false, hasStructuredOutput = false } = ctx || {};
    const extras = {};

    // Provider routing. Only send fields the user actually configured —
    // absent params are omitted upstream rather than defaulted.
    const provider = {};
    if (settings.orAllowFallbacks === false) provider.allow_fallbacks = false;
    if (settings.orDataCollection === 'deny') provider.data_collection = 'deny';
    const sort = str(settings.orSort);
    if (['price', 'throughput', 'latency', 'exacto'].includes(sort)) provider.sort = sort;
    // tools / json_schema are silent no-ops unless a provider supports them.
    if (hasTools || hasStructuredOutput) provider.require_parameters = true;
    if (Object.keys(provider).length) extras.provider = provider;

    // Reasoning effort. OpenRouter wants `reasoning.effort`; the legacy
    // top-level `reasoning_effort` is equivalent but 400s if both differ.
    const effort = orEffectiveEffort(settings);
    if (effort) extras.reasoning = { effort };

    return extras;
  }

  /** Resolve the reasoning effort to send, or '' when reasoning is off. */
  function orEffectiveEffort(settings) {
    const e = str(settings?.orReasoningEffort);
    return OR_REASONING_EFFORTS.includes(e) ? e : '';
  }

  // ── OpenCode Go ──────────────────────────────────────
  const OCGO_BASE = 'https://opencode.ai/inference/go';

  /**
   * Stable per-conversation session id. The gateway requires
   * `x-opencode-session: ses_…` and expects it to stay constant across the
   * turns of one conversation, so this is a deterministic function of the
   * session id — NOT random. Two independent FNV-1a passes give 16 hex chars.
   */
  function ocgoSessionId(session) {
    const seed = session?.id ? String(session.id) : 'kyoto-extension';
    let h1 = 2166136261;
    let h2 = 3735928559;
    for (let i = 0; i < seed.length; i++) {
      const c = seed.charCodeAt(i);
      h1 ^= c; h1 = Math.imul(h1, 16777619);
      h2 ^= (c + i); h2 = Math.imul(h2, 2246822519);
    }
    const a = (h1 >>> 0).toString(16).padStart(8, '0');
    const b = (h2 >>> 0).toString(16).padStart(8, '0');
    return `ses_kyoto${a}${b}`;
  }

  /** Parse the public GET /inference/go/v1/models payload. */
  function ocgoParseModels(data) {
    const list = Array.isArray(data?.data) ? data.data : [];
    const out = [];
    for (const m of list) {
      const id = str(m?.id);
      if (!id) continue;
      const caps = m.capabilities || {};
      const lim = m.limit || {};
      const mods = m.modalities || {};
      const inMods = Array.isArray(mods.input) ? mods.input : [];
      const reasoning = caps.reasoning || {};
      const tools = caps.tools;
      const supportsTools = tools === true || (tools && typeof tools === 'object' ? tools.supported !== false : true);
      const cost = m.cost?.text || {};
      out.push({
        id,
        name: str(m.name) || id,
        group: str(m.family) || 'opencode-go',
        context: num(lim.context),
        maxOutput: num(lim.output),
        supportsTools,
        vision: inMods.includes('image'),
        modalities: { input: inMods, output: Array.isArray(mods.output) ? mods.output : ['text'] },
        reasoning: reasoning.supported
          ? {
              supported: true,
              mandatory: false,
              efforts: Array.isArray(reasoning.effort) ? reasoning.effort : [],
              defaultEffort: (Array.isArray(reasoning.effort) ? reasoning.effort[0] : null) || null,
              supportsMaxTokens: false
            }
          : null,
        supportsStructuredOutputs: caps.structured_output === true,
        pricing: cost.input?.price != null
          ? { prompt: perMillion(cost.input.price), completion: perMillion(cost.output?.price) }
          : null,
        canonicalId: str(m.canonical_id) || id,
        openWeights: m.open_weights === true
      });
    }
    return out;
  }

  // OpenCode Go reports prices per *million* tokens (`price: 1.4` = $1.40/M),
  // whereas OpenRouter reports per-token decimal strings. Normalise both to
  // USD-per-token so the shared cost maths stays consistent.
  function perMillion(v) {
    const n = num(v);
    return n == null ? null : n / 1_000_000;
  }

  // ── Provider definitions ─────────────────────────────
  const openrouter = {
    label: 'OpenRouter',
    chatUrl: 'https://openrouter.ai/api/v1/chat/completions',
    modelsUrl: 'https://openrouter.ai/api/v1/models',
    keysUrl: 'https://openrouter.ai/keys',
    placeholder: 'sk-or-v1-…',
    headers: (key) => ({
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      // Attribution: HTTP-Referer is what actually registers an app;
      // X-OpenRouter-Title is the current name for X-Title (both accepted).
      'HTTP-Referer': 'https://github.com/ankit-pn/kyoto',
      'X-Title': 'Kyoto',
      'X-OpenRouter-Title': 'Kyoto'
    }),
    parseModels: orParseModels,
    defaultModel: 'openai/gpt-4o-mini',
    // Used when /models is unreachable or returns nothing.
    fallbackModels: [
      { id: 'openai/gpt-4o-mini',                name: 'GPT-4o mini',       group: 'openai',    supportsTools: true, vision: true },
      { id: 'openai/gpt-4o',                     name: 'GPT-4o',            group: 'openai',    supportsTools: true, vision: true },
      { id: 'anthropic/claude-3.5-sonnet',       name: 'Claude 3.5 Sonnet', group: 'anthropic', supportsTools: true, vision: true },
      { id: 'anthropic/claude-3.5-haiku',        name: 'Claude 3.5 Haiku',  group: 'anthropic', supportsTools: true, vision: true },
      { id: 'google/gemini-2.0-flash-exp',       name: 'Gemini 2.0 Flash',  group: 'google',    supportsTools: true, vision: true },
      { id: 'meta-llama/llama-3.3-70b-instruct', name: 'Llama 3.3 70B',     group: 'meta-llama', supportsTools: true, vision: false },
      { id: 'deepseek/deepseek-chat',            name: 'DeepSeek V3',       group: 'deepseek',  supportsTools: true, vision: false },
      { id: 'deepseek/deepseek-r1',              name: 'DeepSeek R1',       group: 'deepseek',  supportsTools: true, vision: false }
    ],
    // Hooks used by sidepanel.js. Generic providers leave these undefined.
    isRich: true,
    buildExtras: orBuildExtras,
    requestModelId: orRequestModelId,
    buildFailure: orDescribeFailure
  };

  const opencodeGo = {
    label: 'OpenCode Go',
    chatUrl: `${OCGO_BASE}/openai/v1/chat/completions`,
    // NOTE: the catalogue endpoint is NOT under the /openai/v1 prefix.
    modelsUrl: `${OCGO_BASE}/v1/models`,
    keysUrl: 'https://opencode.ai/console',
    placeholder: 'oc_sk_…',
    headers: (key, ctx) => ({
      'Authorization': `Bearer ${key}`,
      'Content-Type': 'application/json',
      // Required by the Go gateway. Omitting it returns 400 MissingSessionID
      // before credentials are even checked.
      'x-opencode-session': ctx?.sessionId || 'ses_kyoto00000000'
    }),
    parseModels: ocgoParseModels,
    defaultModel: 'glm-5.3',
    // Live catalogue returns 28 models; this keeps the picker usable offline.
    fallbackModels: [
      { id: 'glm-5.3',            name: 'GLM-5.3',            group: 'glm',      supportsTools: true, vision: false },
      { id: 'glm-5.3-flash',      name: 'GLM-5.3 Flash',      group: 'glm',      supportsTools: true, vision: false },
      { id: 'glm-5.2',            name: 'GLM-5.2',            group: 'glm',      supportsTools: true, vision: false },
      { id: 'deepseek-v4.1-flash',name: 'DeepSeek V4.1 Flash', group: 'deepseek', supportsTools: true, vision: false },
      { id: 'deepseek-v4-pro',    name: 'DeepSeek V4 Pro',    group: 'deepseek', supportsTools: true, vision: false },
      { id: 'claude-haiku-5-5',   name: 'Claude Haiku 5.5',   group: 'anthropic',supportsTools: true, vision: false },
      { id: 'gpt-5.6-luna',       name: 'GPT-5.6 Luna',       group: 'openai',   supportsTools: true, vision: false },
      { id: 'gpt-6-luna',         name: 'GPT-6 Luna',         group: 'openai',   supportsTools: true, vision: false },
      { id: 'kimi-k3',            name: 'Kimi K3',            group: 'kimi',     supportsTools: true, vision: false },
      { id: 'kimi-k3.1-pro',      name: 'Kimi K3.1 Pro',      group: 'kimi',     supportsTools: true, vision: false },
      { id: 'qwen3.8-max',        name: 'Qwen3.8 Max',        group: 'qwen',     supportsTools: true, vision: false },
      { id: 'minimax-m3',         name: 'MiniMax M3',         group: 'minimax',  supportsTools: true, vision: false },
      { id: 'grok-4.7',           name: 'Grok 4.7',           group: 'xai',      supportsTools: true, vision: false },
      { id: 'gemini-4-argon',     name: 'Gemini 4 Argon',     group: 'google',   supportsTools: true, vision: false }
    ],
    isRich: true,
    // Go needs no provider-specific body fields — the session lives in a header.
    sessionHeader: true,
    requiresSession: true,
    // `GET /inference/go/v1/models` needs no credentials, so the picker can
    // populate before the user has pasted a key.
    publicModels: true,
    requestModelId: (model) => model,
    buildFailure: ocgoDescribeFailure
  };

  /**
   * Decode an OpenRouter HTTP failure into a message that names the real cause.
   * @param {{status:number, body:any, headers?:Headers}} f
   */
  function orDescribeFailure(f) {
    const { status, body } = f || {};
    const meta = body?.error?.metadata || {};
    const base = str(body?.error?.message) || str(body?.message);
    const limitSource = str(meta.limit_source);
    if (status === 402) {
      if (limitSource === 'openrouter_in_flight_budget') {
        return `Out of in-flight budget (transient) — retry shortly. ${base}`.trim();
      }
      if (limitSource === 'weight_exceeds_budget') {
        return `Request exceeds your spending limit — lower max_tokens or raise the limit. ${base}`.trim();
      }
      if (limitSource === 'openrouter_key_limit' || limitSource === 'openrouter_credits') {
        return `OpenRouter credits/limit reached — top up at openrouter.ai/credits. ${base}`.trim();
      }
      return `Payment required (402) — top up your OpenRouter balance. ${base}`.trim();
    }
    if (status === 401) {
      if (/no cookie auth credentials/i.test(base)) return 'No API key sent — add your OpenRouter key in Settings.';
      if (/user not found/i.test(base)) return 'OpenRouter rejected the key — check it at openrouter.ai/keys.';
    }
    if (status === 429) {
      const providerCode = str(meta.provider_code);
      const errorType = str(meta.error_type);
      const who = providerCode ? `upstream provider (${providerCode})` : (errorType === 'provider_rate_limit' ? 'the upstream provider' : 'OpenRouter');
      return `Rate limited by ${who} — back off and retry. ${base}`.trim();
    }
    if (status === 403) {
      // Most commonly the free-model training toggle. Providers that log or
      // train are not routed to unless the user opts in, and the failure is a
      // hard error rather than a silent skip.
      const source = str(meta.limit_source);
      if (source) return `Blocked by OpenRouter (${source}) — check your budget/guardrail limits. ${base}`.trim();
      return `Blocked by OpenRouter (403). Free models need the "allow training" toggle on your account; a "deny" data-collection setting can cause this too. ${base}`.trim();
    }
    return base || `HTTP ${status}`;
  }

  /** Decode an OpenCode Go HTTP failure. */
  function ocgoDescribeFailure(f) {
    const { status, body } = f || {};
    const type = str(body?.error?.type || body?.type);
    const base = str(body?.error?.message || body?.message);
    if (type === 'MissingSessionID' || /missing x-opencode-session/i.test(base)) {
      return 'OpenCode Go requires an x-opencode-session header — this is a Kyoto bug; please report it.';
    }
    if (status === 401) return 'OpenCode Go rejected the key — check it at opencode.ai/console.';
    if (status === 403) return `OpenCode Go refused this model (free-tier models only run inside OpenCode). ${base}`.trim();
    if (status === 402) return `OpenCode Go allowance exhausted — check usage at opencode.ai/console. ${base}`.trim();
    if (status === 429) return `OpenCode Go rate limited — retry shortly. ${base}`.trim();
    return base || `HTTP ${status}`;
  }

  // ── Streaming: delta reduction ───────────────────────
  // Accumulator contract (owned by streamOnce):
  //   {
  //     text: '', reasoningText: '', reasoningField: null,
  //     reasoningDetails: [], sawDetails: false, toolBuf: []
  //   }
  /**
   * Merge streamed `reasoning_details` blocks into `acc`, keyed by `index`.
   * Re-sending the same index replaces the previous block (providers either
   * stream incremental or cumulative fragments); the array order is never
   * rearranged, because replaying it out of order breaks the model.
   */
  function mergeReasoningDetails(acc, incoming) {
    for (const block of incoming) {
      if (!block || typeof block !== 'object') continue;
      const idx = Number.isInteger(block.index) ? block.index : null;
      if (idx != null) {
        const at = acc.findIndex((b) => b && b.index === idx);
        if (at !== -1) { acc[at] = block; continue; }
      }
      acc.push(block);
    }
  }

  /** Extract user-displayable text from a reasoning_details array. */
  function reasoningTextFromDetails(blocks) {
    let out = '';
    for (const b of blocks || []) {
      if (!b || typeof b !== 'object') continue;
      if (b.type === 'reasoning.text' && typeof b.text === 'string') out += b.text;
      else if (b.type === 'reasoning.summary' && typeof b.summary === 'string') out += b.summary;
    }
    return out;
  }

  /**
   * Fold one SSE `choices[0].delta` into the accumulator.
   * Returns the incremental text/derived-reasoning for UI rendering, or null
   * when the chunk carried nothing renderable.
   */
  function reduceDelta(acc, delta) {
    if (!delta || typeof delta !== 'object') return null;
    const out = { textChunk: null, reasoningChunk: null };

    // Structured reasoning (OpenRouter canonical).
    if (Array.isArray(delta.reasoning_details) && delta.reasoning_details.length) {
      acc.sawDetails = true;
      if (!Array.isArray(acc.reasoningDetails)) acc.reasoningDetails = [];
      mergeReasoningDetails(acc.reasoningDetails, delta.reasoning_details);
      // Only the incremental pieces matter for the UI.
      const t = reasoningTextFromDetails(delta.reasoning_details);
      if (t) {
        out.reasoningChunk = t;
      }
    }

    // Plain reasoning channels. `reasoning_content` is what OpenCode Go and
    // DeepSeek use; `reasoning` is OpenRouter's canonical string; `thinking`
    // is a legacy provider dialect we keep for compatibility.
    const rChunk = delta.reasoning_content ?? delta.reasoning ?? delta.thinking;
    if (typeof rChunk === 'string' && rChunk.length) {
      if (!acc.reasoningField) {
        if (delta.reasoning_content !== undefined) acc.reasoningField = 'reasoning_content';
        else if (delta.reasoning !== undefined) acc.reasoningField = 'reasoning';
        else acc.reasoningField = 'thinking';
      }
      acc.reasoningText = (acc.reasoningText || '') + rChunk;
      // Avoid double-rendering when OpenRouter sends both `reasoning` and
      // `reasoning_details` carrying the same content.
      if (!acc.sawDetails) out.reasoningChunk = rChunk;
    }

    if (typeof delta.content === 'string' && delta.content.length) {
      acc.text = (acc.text || '') + delta.content;
      out.textChunk = delta.content;
    }

    if (Array.isArray(delta.tool_calls)) {
      if (!Array.isArray(acc.toolBuf)) acc.toolBuf = [];
      for (const inc of delta.tool_calls) {
        const idx = Number.isInteger(inc?.index) ? inc.index : 0;
        if (!acc.toolBuf[idx]) acc.toolBuf[idx] = { id: '', function: { name: '', arguments: '' } };
        const slot = acc.toolBuf[idx];
        if (inc.id) slot.id = inc.id;
        // The function name arrives complete in the first fragment; append
        // only the argument fragments (which genuinely stream incrementally).
        if (inc.function?.name) slot.function.name = inc.function.name;
        if (inc.function?.arguments) slot.function.arguments += inc.function.arguments;
      }
    }

    return (out.textChunk || out.reasoningChunk) ? out : null;
  }

  /**
   * Fields to replay on the assistant message so multi-turn tool loops keep
   * working. `reasoning_details` wins when present: it is the only form that
   * preserves encrypted/summarised blocks, and OpenRouter requires the exact
   * sequence back.
   */
  function reasoningEchoFields(acc) {
    if (!acc) return {};
    if (Array.isArray(acc.reasoningDetails) && acc.reasoningDetails.length) {
      return { reasoning_details: acc.reasoningDetails };
    }
    if (acc.reasoningText) {
      return { [acc.reasoningField || 'reasoning']: acc.reasoningText };
    }
    return {};
  }

  /** True for SSE comment / keep-alive lines (`: OPENROUTER PROCESSING`). */
  function isSseComment(line) {
    return str(line).trimStart().startsWith(':');
  }

  /**
   * Detect an in-band error event. OpenRouter keeps HTTP 200 and reports the
   * failure as a top-level `error` plus `finish_reason:"error"`.
   */
  function streamError(payload) {
    if (!payload || typeof payload !== 'object') return null;
    const top = payload.error;
    if (top && typeof top === 'object') {
      return {
        message: str(top.message) || 'Upstream error',
        code: top.code ?? null,
        errorType: str(top.metadata?.error_type),
        providerCode: str(top.metadata?.provider_code)
      };
    }
    const fr = payload.choices?.[0]?.finish_reason;
    if (fr === 'error') return { message: 'Upstream error (finish_reason=error)', code: null, errorType: '', providerCode: '' };
    return null;
  }

  /**
   * Normalise the usage object. Cost lives in `usage.cost` on OpenRouter and
   * OpenCode Go (NOT `total_cost`, which only exists on /api/v1/generations).
   */
  function normaliseUsage(usage) {
    if (!usage || typeof usage !== 'object') return null;
    const cost = num(usage.cost);
    const out = {
      prompt_tokens: num(usage.prompt_tokens) ?? 0,
      completion_tokens: num(usage.completion_tokens) ?? 0,
      total_tokens: num(usage.total_tokens) ?? ((num(usage.prompt_tokens) || 0) + (num(usage.completion_tokens) || 0)),
      cost: cost,
      cached_tokens: num(usage.prompt_tokens_details?.cached_tokens),
      cache_write_tokens: num(usage.prompt_tokens_details?.cache_write_tokens),
      reasoning_tokens: num(usage.completion_tokens_details?.reasoning_tokens)
    };
    const oc = usage.opencode;
    if (oc && typeof oc === 'object') {
      out.billing_source = str(oc.billing_source) || null;
      out.allowance = num(oc.allowance);
    }
    return out;
  }

  window.KyotoProviders = {
    // provider definitions
    openrouter,
    opencodeGo,
    // OpenRouter helpers
    splitModelId,
    orRequestModelId,
    orBuildExtras,
    orEffectiveEffort,
    orDescribeFailure,
    orParseModels,
    OR_REASONING_EFFORTS,
    // OpenCode Go helpers
    ocgoSessionId,
    ocgoDescribeFailure,
    ocgoParseModels,
    OCGO_BASE,
    // shared streaming helpers
    reduceDelta,
    reasoningEchoFields,
    reasoningTextFromDetails,
    isSseComment,
    streamError,
    normaliseUsage
  };
})();
