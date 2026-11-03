// Shared LLM client for the supported API formats (OpenAI / Anthropic / Gemini, and the
// user's ChatGPT subscription through the Responses API).
// Used by the background worker (subtitle translation) and the side panel (chat, notes).
// Requires shared.js (globalThis.NTUSUB) to be loaded first.
globalThis.NTUSUB_LLM = (() => {
  const N = globalThis.NTUSUB;
  const OFFICIAL_HOSTS = ['api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com'];

  class ApiError extends Error {
    constructor(message, fatal = false) {
      super(message);
      this.fatal = fatal;
    }
  }

  const trimUrl = (u) => String(u || '').trim().replace(/\/+$/, '');

  // "chatgpt" requests carry an OAuth access token from Sign in with ChatGPT. The background
  // worker owns the token (see chatgpt.js); other pages fetch it from there.
  let tokenProvider = null;
  const setTokenProvider = (fn) => { tokenProvider = fn; };

  // kind: 'chat' | 'stream' | 'models'
  function endpoint(provider, cfg, kind) {
    const b = trimUrl(cfg.baseUrl);
    if (provider === 'chatgpt') return kind === 'models' ? 'https://api.openai.com/v1/models' : 'https://api.openai.com/v1/responses';
    if (provider === 'openai') {
      const root = b.replace(/\/(chat\/completions|models)$/, '');
      return kind === 'models' ? root + '/models' : root + '/chat/completions';
    }
    if (provider === 'anthropic') {
      let root = b.replace(/\/(messages|models)$/, '');
      if (!/\/v1$/.test(root)) root += '/v1';
      return kind === 'models' ? root + '/models?limit=1000' : root + '/messages';
    }
    // gemini
    let root = b.replace(/\/models(\/[^/]*)?$/, '');
    if (!/\/v1(alpha|beta)?\d*$/.test(root)) root += '/v1beta';
    const key = encodeURIComponent(cfg.apiKey || '');
    if (kind === 'models') return `${root}/models?pageSize=1000&key=${key}`;
    const model = encodeURIComponent(String(cfg.model || '').replace(/^models\//, ''));
    return kind === 'stream'
      ? `${root}/models/${model}:streamGenerateContent?alt=sse&key=${key}`
      : `${root}/models/${model}:generateContent?key=${key}`;
  }

  function parseJsonField(v, name) {
    if (!v || !String(v).trim()) return {};
    try {
      const o = JSON.parse(v);
      if (o && typeof o === 'object' && !Array.isArray(o)) return o;
    } catch (e) { /* fallthrough */ }
    throw new ApiError(`${name} 不是合法的 JSON 对象`, true);
  }

  function headersFor(provider, cfg) {
    const h = { 'Content-Type': 'application/json' };
    if (provider === 'openai') {
      if (cfg.apiKey) h.Authorization = 'Bearer ' + cfg.apiKey;
    } else if (provider === 'anthropic') {
      if (cfg.apiKey) h['x-api-key'] = cfg.apiKey;
      h['anthropic-version'] = '2023-06-01';
      h['anthropic-dangerous-direct-browser-access'] = 'true';
    } else if (cfg.apiKey) {
      h['x-goog-api-key'] = cfg.apiKey;
    }
    return Object.assign(h, parseJsonField(cfg.extraHeaders, '额外请求头'));
  }

  async function requestHeaders(provider, cfg) {
    if (provider !== 'chatgpt') return headersFor(provider, cfg);
    if (!tokenProvider) throw new ApiError('ChatGPT 登录不可用', true);
    let token;
    try { token = await tokenProvider(); } catch (e) { throw new ApiError(e.message, e.fatal !== false); }
    return { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token };
  }

  // Errors of ChatGPT plan usage (Sign in with ChatGPT "Errors and recovery").
  function chatgptError(code, message, status) {
    if (/usage_limit_exceeded/.test(code)) {
      return new ApiError('ChatGPT 套餐额度已用完（也可能是给本扩展设的额度上限），可在 ChatGPT 设置 → 用量中查看和调整', true);
    }
    if (/subscription_sharing_(usage|user)_unavailable/.test(code)) return new ApiError('ChatGPT 暂时无法确认套餐用量，稍后会自动重试');
    if (/invalid_user/.test(code) || status === 401) {
      return new ApiError('ChatGPT 授权未通过（可能已在 ChatGPT 设置中断开本扩展），请在设置里重新登录' + (message ? '：' + message : ''), true);
    }
    return null;
  }

  function checkConfig(provider, cfg) {
    if (!cfg || !N.AI_PROVIDERS.includes(provider)) throw new ApiError('当前不是 AI 精准模式', true);
    if (!cfg.model) throw new ApiError('未填写模型名称', true);
    if (provider === 'chatgpt') return;
    if (!cfg.baseUrl) throw new ApiError('未填写接口地址 (Base URL)', true);
    let host = '';
    try { host = new URL(trimUrl(cfg.baseUrl)).host; } catch (e) { throw new ApiError('接口地址格式不正确', true); }
    if (!cfg.apiKey && OFFICIAL_HOSTS.includes(host)) throw new ApiError('未填写 API Key，请在扩展设置中配置', true);
  }

  // Retries 408/409/429/5xx and network errors. The timeout covers the time to response headers.
  async function fetchWithRetry(url, init, { attempts = 3, timeoutMs = 120000, signal } = {}) {
    let lastErr;
    for (let i = 0; i < attempts; i++) {
      if (signal && signal.aborted) throw new ApiError('已取消');
      const ctrl = new AbortController();
      const timer = setTimeout(() => ctrl.abort(), timeoutMs);
      const onAbort = () => ctrl.abort();
      if (signal) signal.addEventListener('abort', onAbort);
      try {
        const res = await fetch(url, { ...init, signal: ctrl.signal });
        if (res.ok) {
          // Keep the caller's signal wired to this request so streams can still be stopped.
          if (signal) signal.addEventListener('abort', () => ctrl.abort(), { once: true });
          return res;
        }
        const text = await res.text().catch(() => '');
        let detail = text.slice(0, 300);
        let code = '';
        try {
          const j = JSON.parse(text);
          const e = Array.isArray(j) ? j[0] && j[0].error : j.error;
          detail = (e && (e.message || (typeof e === 'string' ? e : ''))) || j.message || j.detail || detail;
          code = (e && e.code) || j.code || '';
        } catch (e) { /* not JSON */ }
        if (/^https:\/\/api\.openai\.com\/v1\/(responses|models)/.test(url)) {
          const ce = chatgptError(String(code), detail, res.status);
          if (ce && ce.fatal) throw ce;
        }
        const retryable = res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500;
        lastErr = new ApiError(`HTTP ${res.status}: ${detail}`, !retryable);
        if (!retryable) throw lastErr;
        const ra = parseFloat(res.headers.get('retry-after'));
        await new Promise((r) => setTimeout(r, Number.isFinite(ra) ? Math.min(ra, 30) * 1000 : 1000 * 2 ** i));
      } catch (e) {
        if (e instanceof ApiError && e.fatal) throw e;
        if (signal && signal.aborted) throw new ApiError('已取消');
        lastErr = e instanceof ApiError ? e : new ApiError(e.name === 'AbortError' ? '请求超时' : '网络错误：' + e.message);
        if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
      } finally {
        clearTimeout(timer);
        if (signal) signal.removeEventListener('abort', onAbort);
      }
    }
    throw lastErr;
  }

  // messages: string (single user turn) or [{ role: 'user' | 'assistant', content }]
  function buildBody(provider, cfg, system, messages, { json = false, maxTokens = 4096, stream = false } = {}) {
    const msgs = typeof messages === 'string' ? [{ role: 'user', content: messages }] : messages;
    const temp = cfg.temperature === '' || cfg.temperature == null || isNaN(+cfg.temperature) ? undefined : +cfg.temperature;
    let body;
    if (provider === 'chatgpt') {
      // Plan usage requires store:false and stream:true; system text goes in `instructions`, and
      // temperature / max_output_tokens are not accepted.
      body = { model: cfg.model, instructions: system, input: msgs.map((m) => ({ role: m.role, content: m.content })), store: false, stream: true };
      return N.merge(body, parseJsonField(cfg.extraBody, '额外请求体'));
    }
    if (provider === 'openai') {
      body = { model: cfg.model, messages: [{ role: 'system', content: system }, ...msgs] };
      if (stream) body.stream = true;
    } else if (provider === 'anthropic') {
      body = { model: cfg.model, max_tokens: maxTokens, system, messages: msgs };
      if (stream) body.stream = true;
    } else {
      body = {
        systemInstruction: { parts: [{ text: system }] },
        contents: msgs.map((m) => ({ role: m.role === 'assistant' ? 'model' : 'user', parts: [{ text: m.content }] }))
      };
      if (json) body.generationConfig = { responseMimeType: 'application/json' };
    }
    if (temp !== undefined) {
      if (provider === 'gemini') body.generationConfig = Object.assign(body.generationConfig || {}, { temperature: temp });
      else body.temperature = temp;
    }
    return N.merge(body, parseJsonField(cfg.extraBody, '额外请求体'));
  }

  function textOfResponse(provider, data) {
    if (provider === 'chatgpt') {
      return (data.output || []).flatMap((o) => o.content || []).filter((c) => c.type === 'output_text').map((c) => c.text || '').join('');
    }
    if (provider === 'openai') {
      const c = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
      return Array.isArray(c) ? c.map((p) => p.text || '').join('') : (c || '');
    }
    if (provider === 'anthropic') {
      return (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
    }
    const cand = data.candidates && data.candidates[0];
    const text = ((cand && cand.content && cand.content.parts) || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
    if (!text && cand && cand.finishReason && cand.finishReason !== 'STOP') throw new ApiError('Gemini 未返回内容：' + cand.finishReason);
    return text;
  }

  // Text delta carried by one streamed event (SSE `data:` payload), or '' if none.
  function textOfEvent(provider, j) {
    if (provider === 'chatgpt') {
      if (j.type === 'response.output_text.delta') return j.delta || '';
      if (j.type === 'response.failed' || j.type === 'error') {
        const e = (j.response && j.response.error) || j.error || j;
        throw chatgptError(String(e.code || ''), e.message || '') || new ApiError('ChatGPT 返回错误：' + (e.message || e.code || '未知错误'));
      }
      return '';
    }
    if (j.error) throw new ApiError((j.error && j.error.message) || String(j.error));
    if (provider === 'openai') {
      const d = j.choices && j.choices[0] && j.choices[0].delta;
      if (!d) return '';
      return Array.isArray(d.content) ? d.content.map((p) => p.text || '').join('') : (d.content || '');
    }
    if (provider === 'anthropic') {
      if (j.type === 'error') throw new ApiError((j.error && j.error.message) || '流式响应出错');
      return j.type === 'content_block_delta' && j.delta && j.delta.type === 'text_delta' ? j.delta.text || '' : '';
    }
    const cand = j.candidates && j.candidates[0];
    return ((cand && cand.content && cand.content.parts) || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
  }

  async function callModel(provider, cfg, system, messages, opts = {}) {
    checkConfig(provider, cfg);
    if (provider === 'chatgpt') return streamModel(provider, cfg, system, messages, () => {}, opts); // streaming only
    const res = await fetchWithRetry(endpoint(provider, cfg, 'chat'), {
      method: 'POST',
      headers: headersFor(provider, cfg),
      body: JSON.stringify(buildBody(provider, cfg, system, messages, opts))
    }, opts);
    const data = await res.json().catch(() => { throw new ApiError('接口返回的不是 JSON'); });
    const text = textOfResponse(provider, data);
    if (!text) throw new ApiError('模型返回为空');
    return text;
  }

  // Streams the reply, calling onText(delta, fullSoFar). Resolves with the full text.
  async function streamModel(provider, cfg, system, messages, onText, opts = {}) {
    checkConfig(provider, cfg);
    const res = await fetchWithRetry(endpoint(provider, cfg, 'stream'), {
      method: 'POST',
      headers: await requestHeaders(provider, cfg),
      body: JSON.stringify(buildBody(provider, cfg, system, messages, { ...opts, stream: true }))
    }, { ...opts, attempts: opts.attempts || 2 });

    let full = '';
    let finished = provider !== 'chatgpt'; // Responses streams end with response.completed / .incomplete
    const emit = (t) => { if (t) { full += t; onText(t, full); } };
    // Some compatible proxies ignore `stream` and answer with plain JSON.
    if (/application\/json/i.test(res.headers.get('content-type') || '')) {
      emit(textOfResponse(provider, await res.json()));
      finished = true;
      if (!full) throw new ApiError('模型返回为空');
      return full;
    }

    const reader = res.body.getReader();
    const dec = new TextDecoder();
    let buf = '';
    const idleMs = opts.idleMs || 90000;
    const handleLine = (line) => {
      if (!line.startsWith('data:')) return;
      const payload = line.slice(5).trim();
      if (!payload || payload === '[DONE]') return;
      let j;
      try { j = JSON.parse(payload); } catch (e) { return; }
      if (j.type === 'response.completed' || j.type === 'response.incomplete') finished = true;
      emit(textOfEvent(provider, j));
    };
    for (;;) {
      let timer;
      const idle = new Promise((_, rej) => { timer = setTimeout(() => rej(new ApiError('响应超时')), idleMs); });
      let chunk;
      try {
        chunk = await Promise.race([reader.read(), idle]);
      } catch (e) {
        reader.cancel().catch(() => {});
        if (opts.signal && opts.signal.aborted) throw new ApiError('已取消');
        throw e instanceof ApiError ? e : new ApiError('网络错误：' + e.message);
      } finally {
        clearTimeout(timer);
      }
      if (chunk.done) break;
      buf += dec.decode(chunk.value, { stream: true });
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        handleLine(buf.slice(0, i).replace(/\r$/, ''));
        buf = buf.slice(i + 1);
      }
    }
    handleLine(buf.trim());
    if (!finished) throw new ApiError(full ? '响应在完成前中断' : '模型返回为空');
    if (!full) throw new ApiError('模型返回为空');
    return full;
  }

  async function listModels(provider, cfg) {
    const res = await fetchWithRetry(endpoint(provider, cfg, 'models'), {
      method: 'GET',
      headers: await requestHeaders(provider, cfg)
    }, { attempts: 1 });
    const data = await res.json();
    let ids = [];
    if (provider === 'chatgpt') {
      // Account-specific catalog: keep the models meant to be listed.
      ids = (data.data || data.models || []).filter((m) => !m.visibility || m.visibility === 'list').map((m) => m.slug || m.id);
    } else if (provider === 'gemini') {
      ids = (data.models || [])
        .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
        .map((m) => String(m.name || '').replace(/^models\//, ''));
    } else {
      ids = (data.data || data.models || []).map((m) => m.id || m.name);
    }
    return ids.filter(Boolean).sort();
  }

  // Models often put unescaped ASCII quotes inside Chinese strings (的"免费"误差) or raw line
  // breaks. Inside a string, treat a quote as closing only when , } ] or : follows it.
  function repairJson(s) {
    let out = '', inStr = false, esc = false;
    for (let i = 0; i < s.length; i++) {
      const ch = s[i];
      if (!inStr) {
        if (ch === '"') inStr = true;
        out += ch;
        continue;
      }
      if (esc) { out += ch; esc = false; continue; }
      if (ch === '\\') { out += ch; esc = true; continue; }
      if (ch === '"') {
        let j = i + 1;
        while (j < s.length && /\s/.test(s[j])) j++;
        if (j >= s.length || ',}]:'.includes(s[j])) { inStr = false; out += ch; } else out += '\\"';
        continue;
      }
      out += ch === '\n' ? '\\n' : ch === '\r' ? '' : ch === '\t' ? '\\t' : ch;
    }
    return out;
  }

  // Best-effort JSON extraction from model output (fences, <think> blocks, surrounding prose).
  function extractJson(raw) {
    const s = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '')
      .replace(/^\s*```(?:json)?\s*/i, '').replace(/```\s*$/, '').trim();
    const a = s.indexOf('{'), b = s.lastIndexOf('}');
    const as = s.indexOf('['), bs = s.lastIndexOf(']');
    const tryParse = (x) => {
      try { return JSON.parse(x); } catch (e) { /* try repaired */ }
      try { return JSON.parse(repairJson(x)); } catch (e) { return undefined; }
    };
    if (as >= 0 && bs > as && (a < 0 || as < a)) {
      const v = tryParse(s.slice(as, bs + 1));
      if (v !== undefined) return v;
    }
    if (a >= 0 && b > a) {
      const v = tryParse(s.slice(a, b + 1));
      if (v !== undefined) return v;
    }
    return null;
  }

  // Models often write LaTeX inside JSON strings with single backslashes. "\alpha" is an invalid
  // escape and "\frac" / "\times" silently parse as form feed / tab, so double the backslash of
  // anything that is not a real JSON escape, and of \b \f \n \r \t when a LaTeX command follows.
  const TEX_CMD = /^(?:frac|dfrac|tfrac|forall|beta|bar|binom|bmod|boldsymbol|bot|bullet|big[lr]?|nabla|neq?|neg|nu|not|notin|nmid|times|text\w*|theta|tau|tanh?|to|top|tilde|triangle|rho|right\w*|rangle|rceil|rfloor|rm)$/;
  function fixTexEscapes(raw) {
    return String(raw || '').replace(/\\(\\|u[0-9a-fA-F]{4}|[a-zA-Z]+|[\s\S])/g, (m, x) => {
      if (x === '\\' || x === '"' || x === '/' || /^u[0-9a-fA-F]{4}$/.test(x)) return m;
      if (/^[bfnrt]/.test(x)) return TEX_CMD.test(x) ? '\\' + m : m;
      return '\\' + m;
    });
  }

  return { ApiError, setTokenProvider, endpoint, headersFor, checkConfig, fetchWithRetry, buildBody, callModel, streamModel, listModels, extractJson, repairJson, fixTexEscapes };
})();
