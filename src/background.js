importScripts('shared.js');

const N = globalThis.NTUSUB;
const OFFICIAL_HOSTS = ['api.openai.com', 'api.anthropic.com', 'generativelanguage.googleapis.com'];

class ApiError extends Error {
  constructor(message, fatal = false) {
    super(message);
    this.fatal = fatal;
  }
}

// ------------------------------------------------------------------ prompts
function buildSystemPrompt(s, titles) {
  const target = s.targetLang || '简体中文';
  const parts = [
    `You are an expert subtitle translator for university lecture videos (Nanyang Technological University, Singapore). Translate the subtitles (usually English) into ${target}.`,
    '',
    'Rules:',
    `1. Accuracy first. Render technical and academic terminology with the standard, established ${target} terms used in that field; never translate a term literally when an established term exists.`,
    s.keepTerms
      ? '2. For genuinely specialised technical terms, append the original English in parentheses after the translation, e.g. "反向传播 (backpropagation)". Do this sparingly.'
      : '2. Do not add the original English in parentheses, except for abbreviations that are normally kept in English (e.g. CPU, DNA, TCP).',
    '3. The lines come from speech recognition: a sentence may be split across several lines and words may be misrecognised. Use the context to understand the meaning, silently fix obvious recognition errors, and translate each line so that it stays aligned with its own content. Never merge, split, drop or reorder lines: every input id must get exactly one output.',
    '4. Keep translations concise and natural, suitable for on-screen subtitles. Keep formulas, code, variable names, numbers and units intact. Drop filler words (um, uh, you know) when they add nothing.',
    '5. "context_before" and "context_after" are for understanding only - do not translate or output them.',
    '6. Output ONLY a JSON object mapping each id (string) to its translation, e.g. {"1":"……","2":"……"}. No markdown fences, no explanations.'
  ];
  const t = (titles || []).filter(Boolean).filter((x, i, a) => a.indexOf(x) === i);
  if (t.length) parts.push('', 'Video / page title: ' + t.join(' | '));
  if (s.courseContext && s.courseContext.trim()) parts.push('', 'Course / subject context:', s.courseContext.trim());
  if (s.glossary && s.glossary.trim()) parts.push('', 'Glossary (always use these translations):', s.glossary.trim());
  return parts.join('\n');
}

function buildUserPrompt(msg) {
  const lines = {};
  for (const l of msg.lines) lines[l.id] = l.text;
  const obj = {};
  if (msg.before && msg.before.length) obj.context_before = msg.before;
  obj.lines = lines;
  if (msg.after && msg.after.length) obj.context_after = msg.after;
  return `Translate every entry of "lines". Return a JSON object with exactly these ids: ${msg.lines.map((l) => l.id).join(', ')}\n\n${JSON.stringify(obj)}`;
}

function parseTranslations(raw, ids) {
  let s = String(raw || '').replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/, '');
  const out = {};
  const put = (id, v) => {
    if (typeof v === 'string' && v.trim()) out[id] = v.trim();
    else if (v && typeof v === 'object') {
      const t = v.translation || v.text || v.t;
      if (typeof t === 'string' && t.trim()) out[id] = t.trim();
    }
  };
  const fromArray = (arr) => arr.forEach((item, i) => {
    if (item && typeof item === 'object' && item.id != null) put(String(item.id), item);
    else if (ids[i]) put(ids[i], item);
  });

  let obj = null;
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  const as = s.indexOf('['), bs = s.lastIndexOf(']');
  if (as >= 0 && bs > as && (a < 0 || as < a)) {
    try { obj = JSON.parse(s.slice(as, bs + 1)); } catch (e) { /* try object */ }
  }
  if (!obj && a >= 0 && b > a) { try { obj = JSON.parse(s.slice(a, b + 1)); } catch (e) { /* salvage below */ } }
  if (Array.isArray(obj)) {
    fromArray(obj);
  } else if (obj && typeof obj === 'object') {
    const src = (obj.translations && typeof obj.translations === 'object') ? obj.translations
      : (obj.lines && typeof obj.lines === 'object') ? obj.lines : obj;
    if (Array.isArray(src)) fromArray(src);
    else for (const id of ids) put(id, src[id]);
  }
  if (!Object.keys(out).length) {
    const re = /"(\d+)"\s*:\s*"((?:[^"\\]|\\.)*)"/g;
    let m;
    while ((m = re.exec(s))) {
      try { put(m[1], JSON.parse('"' + m[2] + '"')); } catch (e) { /* ignore */ }
    }
  }
  return out;
}

// ---------------------------------------------------------------- providers
const trimUrl = (u) => String(u || '').trim().replace(/\/+$/, '');

function endpoint(provider, cfg, kind) {
  const b = trimUrl(cfg.baseUrl);
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
  if (kind === 'models') return root + '/models?pageSize=1000&key=' + encodeURIComponent(cfg.apiKey || '');
  const model = String(cfg.model || '').replace(/^models\//, '');
  return `${root}/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(cfg.apiKey || '')}`;
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

function checkKey(provider, cfg) {
  if (!cfg.baseUrl) throw new ApiError('未填写接口地址 (Base URL)', true);
  if (!cfg.model) throw new ApiError('未填写模型名称', true);
  let host = '';
  try { host = new URL(trimUrl(cfg.baseUrl)).host; } catch (e) { throw new ApiError('接口地址格式不正确', true); }
  if (!cfg.apiKey && OFFICIAL_HOSTS.includes(host)) throw new ApiError('未填写 API Key，请在扩展设置中配置', true);
}

async function fetchWithRetry(url, init, attempts = 3) {
  let lastErr;
  for (let i = 0; i < attempts; i++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 120000);
    try {
      const res = await fetch(url, { ...init, signal: ctrl.signal });
      if (res.ok) return res;
      const text = await res.text().catch(() => '');
      let detail = text.slice(0, 300);
      try {
        const j = JSON.parse(text);
        const e = Array.isArray(j) ? j[0] && j[0].error : j.error;
        detail = (e && (e.message || (typeof e === 'string' ? e : ''))) || j.message || detail;
      } catch (e) { /* not JSON */ }
      const retryable = res.status === 408 || res.status === 409 || res.status === 429 || res.status >= 500;
      lastErr = new ApiError(`HTTP ${res.status}: ${detail}`, !retryable);
      if (!retryable) throw lastErr;
      const ra = parseFloat(res.headers.get('retry-after'));
      await new Promise((r) => setTimeout(r, Number.isFinite(ra) ? Math.min(ra, 30) * 1000 : 1000 * 2 ** i));
    } catch (e) {
      if (e instanceof ApiError && e.fatal) throw e;
      lastErr = e instanceof ApiError ? e : new ApiError(e.name === 'AbortError' ? '请求超时' : '网络错误：' + e.message);
      if (i < attempts - 1) await new Promise((r) => setTimeout(r, 1000 * 2 ** i));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

async function callModel(provider, cfg, system, user) {
  checkKey(provider, cfg);
  const temp = cfg.temperature === '' || cfg.temperature == null || isNaN(+cfg.temperature) ? undefined : +cfg.temperature;
  let body;
  if (provider === 'openai') {
    body = {
      model: cfg.model,
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }]
    };
  } else if (provider === 'anthropic') {
    body = {
      model: cfg.model,
      max_tokens: 4096,
      system,
      messages: [{ role: 'user', content: user }]
    };
  } else {
    body = {
      systemInstruction: { parts: [{ text: system }] },
      contents: [{ role: 'user', parts: [{ text: user }] }],
      generationConfig: { responseMimeType: 'application/json' }
    };
  }
  if (temp !== undefined) {
    if (provider === 'gemini') body.generationConfig.temperature = temp;
    else body.temperature = temp;
  }
  body = N.merge(body, parseJsonField(cfg.extraBody, '额外请求体'));

  const res = await fetchWithRetry(endpoint(provider, cfg, 'chat'), {
    method: 'POST',
    headers: headersFor(provider, cfg),
    body: JSON.stringify(body)
  });
  const data = await res.json().catch(() => { throw new ApiError('接口返回的不是 JSON'); });

  let text = '';
  if (provider === 'openai') {
    const c = data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content;
    text = Array.isArray(c) ? c.map((p) => p.text || '').join('') : (c || '');
  } else if (provider === 'anthropic') {
    text = (data.content || []).filter((b) => b.type === 'text').map((b) => b.text).join('');
  } else {
    const cand = data.candidates && data.candidates[0];
    text = ((cand && cand.content && cand.content.parts) || []).filter((p) => !p.thought).map((p) => p.text || '').join('');
    if (!text && cand && cand.finishReason) throw new ApiError('Gemini 未返回内容：' + cand.finishReason);
  }
  if (!text) throw new ApiError('模型返回为空');
  return text;
}

async function listModels(provider, cfg) {
  const res = await fetchWithRetry(endpoint(provider, cfg, 'models'), {
    method: 'GET',
    headers: headersFor(provider, cfg)
  }, 1);
  const data = await res.json();
  let ids = [];
  if (provider === 'gemini') {
    ids = (data.models || [])
      .filter((m) => !m.supportedGenerationMethods || m.supportedGenerationMethods.includes('generateContent'))
      .map((m) => String(m.name || '').replace(/^models\//, ''));
  } else {
    ids = (data.data || data.models || []).map((m) => m.id || m.name);
  }
  return ids.filter(Boolean).sort();
}

// --------------------------------------------------------- basic mode (Google)
// The keyless endpoint used by browser translation add-ons. Multiple `q` params in one
// request come back as an array in the same order, so cue alignment is preserved.
const GOOGLE_URL = 'https://translate.googleapis.com/translate_a/t?client=gtx&sl=auto&format=text&tl=';
const GOOGLE_MAX_LINES = 100;
const GOOGLE_MAX_CHARS = 9000;

async function googleTranslate(texts, target) {
  const tl = N.googleLang(target);
  if (!tl) throw new ApiError(`基础模式不支持目标语言「${target}」，请在设置中选择列表里的语言，或改用 AI 模式`, true);
  const out = [];
  for (let i = 0; i < texts.length;) {
    const chunk = [];
    let chars = 0;
    while (i < texts.length && chunk.length < GOOGLE_MAX_LINES && (chars + texts[i].length < GOOGLE_MAX_CHARS || !chunk.length)) {
      chars += texts[i].length;
      chunk.push(texts[i++]);
    }
    const body = new URLSearchParams();
    chunk.forEach((t) => body.append('q', t));
    let res;
    try {
      res = await fetchWithRetry(GOOGLE_URL + encodeURIComponent(tl), {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded;charset=UTF-8' },
        body: body.toString()
      });
    } catch (e) {
      throw new ApiError('Google 翻译暂时不可用（' + e.message + '），可稍后重试或改用 AI 模式', e.fatal);
    }
    let data = await res.json().catch(() => null);
    if (typeof data === 'string') data = [data];
    if (!Array.isArray(data) || data.length !== chunk.length) throw new ApiError('Google 翻译返回格式异常');
    // sl=auto returns [translation, detectedLang] per line; sl=<code> returns plain strings.
    for (const item of data) out.push(String(Array.isArray(item) ? item[0] : item || '').trim());
  }
  return out;
}

// ----------------------------------------------------------------- handlers
const handlers = {
  async 'ntusub-translate'(msg, sender) {
    const s = await N.getSettings();
    if (N.isBasic(s)) {
      const tr = await googleTranslate(msg.lines.map((l) => l.text), s.targetLang);
      const translations = {};
      msg.lines.forEach((l, i) => { if (tr[i]) translations[l.id] = tr[i]; });
      return { translations };
    }
    const cfg = s.providers[s.provider];
    const system = buildSystemPrompt(s, [sender.tab && sender.tab.title, msg.frameTitle]);
    const raw = await callModel(s.provider, cfg, system, buildUserPrompt(msg));
    const translations = parseTranslations(raw, msg.lines.map((l) => l.id));
    if (!Object.keys(translations).length) throw new ApiError('无法解析模型输出：' + raw.slice(0, 120));
    return { translations };
  },

  async 'ntusub-test'(msg) {
    const s = N.merge(await N.getSettings(), msg.settings || {});
    const cfg = s.providers[msg.provider];
    const lines = [
      { id: '1', text: "So today we're going to derive the back propagation algorithm" },
      { id: '2', text: 'using the chain rule, and then look at how gradient descent updates the weights.' }
    ];
    const t0 = Date.now();
    if (msg.provider === N.BASIC_PROVIDER) {
      const tr = await googleTranslate(lines.map((l) => l.text), s.targetLang);
      return { ms: Date.now() - t0, lines: lines.map((l, i) => ({ src: l.text, tr: tr[i] || '' })), raw: '' };
    }
    const raw = await callModel(msg.provider, cfg, buildSystemPrompt(s, []), buildUserPrompt({ lines }));
    const tr = parseTranslations(raw, ['1', '2']);
    return { ms: Date.now() - t0, lines: lines.map((l) => ({ src: l.text, tr: tr[l.id] || '' })), raw: Object.keys(tr).length ? '' : raw.slice(0, 300) };
  },

  async 'ntusub-models'(msg) {
    return { models: await listModels(msg.provider, msg.cfg) };
  },

  async 'ntusub-cache-touch'(msg) {
    await touchCache(msg.key);
    return {};
  },

  async 'ntusub-cache-clear'() {
    const all = await chrome.storage.local.get(null);
    const keys = Object.keys(all).filter((k) => k.startsWith('c:'));
    await chrome.storage.local.remove(keys.concat('cacheIndex'));
    return { removed: keys.length };
  },

  async 'ntusub-cache-stats'() {
    const { cacheIndex } = await chrome.storage.local.get('cacheIndex');
    const bytes = await chrome.storage.local.getBytesInUse(null).catch(() => 0);
    return { videos: Object.keys(cacheIndex || {}).length, bytes };
  }
};

// Serialised LRU bookkeeping for per-video translation caches.
let cacheChain = Promise.resolve();
const MAX_CACHED_VIDEOS = 300;
function touchCache(key) {
  cacheChain = cacheChain.then(async () => {
    const { cacheIndex = {} } = await chrome.storage.local.get('cacheIndex');
    cacheIndex[key] = Date.now();
    const keys = Object.keys(cacheIndex);
    if (keys.length > MAX_CACHED_VIDEOS) {
      const old = keys.sort((a, b) => cacheIndex[a] - cacheIndex[b]).slice(0, keys.length - MAX_CACHED_VIDEOS);
      old.forEach((k) => delete cacheIndex[k]);
      await chrome.storage.local.remove(old);
    }
    await chrome.storage.local.set({ cacheIndex });
  }).catch(() => {});
  return cacheChain;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const h = msg && handlers[msg.type];
  if (!h) return;
  Promise.resolve()
    .then(() => h(msg, sender))
    .then(
      (r) => sendResponse({ ok: true, ...r }),
      (e) => sendResponse({ ok: false, error: (e && e.message) || String(e), fatal: !!(e && e.fatal) })
    );
  return true;
});

chrome.commands.onCommand.addListener(async (cmd) => {
  const s = await N.getSettings();
  if (cmd === 'toggle-subtitles') {
    await N.saveSettings({ enabled: !s.enabled });
  } else if (cmd === 'cycle-mode') {
    const modes = ['bilingual', 'translation', 'original'];
    await N.saveSettings({ display: { mode: modes[(modes.indexOf(s.display.mode) + 1) % modes.length] } });
  }
});

chrome.runtime.onInstalled.addListener((d) => {
  if (d.reason === 'install') chrome.runtime.openOptionsPage();
});
