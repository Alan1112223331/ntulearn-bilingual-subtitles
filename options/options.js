const N = globalThis.NTUSUB;
const $ = (s) => document.querySelector(s);

const HINTS = {
  openai: '兼容 OpenAI Chat Completions 的接口：OpenAI、DeepSeek、通义千问、OpenRouter、one-api / new-api 等。Base URL 一般以 /v1 结尾，会自动拼接 /chat/completions。',
  anthropic: 'Anthropic Messages API 或兼容代理。填写根地址即可（如 https://api.anthropic.com），会自动拼接 /v1/messages。',
  gemini: 'Google Gemini generateContent 接口或兼容代理。会自动拼接 /v1beta/models/{模型}:generateContent。'
};
const BODY_PLACEHOLDER = {
  openai: '{"reasoning_effort": "low"}',
  anthropic: '{"max_tokens": 8192}',
  gemini: '{"generationConfig": {"thinkingConfig": {"thinkingBudget": 0}}}'
};
const PROVIDER_FIELDS = ['baseUrl', 'apiKey', 'model', 'temperature', 'extraHeaders', 'extraBody'];
const PRESET_LANGS = Array.from(document.querySelectorAll('#targetLang option')).map((o) => o.value).filter((v) => v !== '__custom');

let draft = null;
let cur = 'openai';
let dirty = false;

function markDirty() {
  dirty = true;
  $('#saveMsg').textContent = '有未保存的更改';
}

// ------------------------------------------------------------- provider tab
function readProviderForm() {
  const p = draft.providers[cur];
  for (const f of PROVIDER_FIELDS) p[f] = $('#' + f).value.trim();
}

function fillProviderForm() {
  const p = draft.providers[cur];
  for (const f of PROVIDER_FIELDS) $('#' + f).value = p[f] ?? '';
  document.querySelectorAll('#providerTabs button').forEach((b) => b.classList.toggle('on', b.dataset.p === cur));
  $('#providerHint').textContent = HINTS[cur];
  $('#baseUrl').placeholder = N.DEFAULTS.providers[cur].baseUrl;
  $('#extraBody').placeholder = '例如 ' + BODY_PLACEHOLDER[cur];
  $('#modelList').innerHTML = '';
  $('#testResult').innerHTML = '';
}

// ------------------------------------------------------------------ general
function fillForm() {
  fillProviderForm();
  const lang = draft.targetLang;
  if (PRESET_LANGS.includes(lang)) {
    $('#targetLang').value = lang;
    $('#customLangField').hidden = true;
  } else {
    $('#targetLang').value = '__custom';
    $('#customLang').value = lang;
    $('#customLangField').hidden = false;
  }
  $('#courseContext').value = draft.courseContext;
  $('#glossary').value = draft.glossary;
  $('#keepTerms').checked = draft.keepTerms;
  $('#batchSize').value = draft.batchSize;
  $('#concurrency').value = draft.concurrency;
  $('#contextLines').value = draft.contextLines;

  const d = draft.display;
  for (const k of ['mode', 'order', 'fontScale', 'origScale', 'bgOpacity', 'bottom', 'transColor', 'origColor', 'offsetMs']) $('#' + k).value = d[k];
  $('#fontWeight').value = String(d.fontWeight);
  $('#hideNative').checked = d.hideNative;
  $('#showStatus').checked = d.showStatus;
  updateOutputs();
  updatePreview();
}

function readForm() {
  readProviderForm();
  draft.provider = cur;
  const sel = $('#targetLang').value;
  draft.targetLang = sel === '__custom' ? ($('#customLang').value.trim() || '简体中文') : sel;
  draft.courseContext = $('#courseContext').value;
  draft.glossary = $('#glossary').value;
  draft.keepTerms = $('#keepTerms').checked;
  draft.batchSize = Math.min(120, Math.max(5, +$('#batchSize').value || 30));
  draft.concurrency = Math.min(10, Math.max(1, +$('#concurrency').value || 3));
  draft.contextLines = Math.min(10, Math.max(0, +$('#contextLines').value || 0));
  const d = draft.display;
  d.mode = $('#mode').value;
  d.order = $('#order').value;
  d.fontScale = +$('#fontScale').value;
  d.origScale = +$('#origScale').value;
  d.bgOpacity = +$('#bgOpacity').value;
  d.bottom = +$('#bottom').value;
  d.transColor = $('#transColor').value;
  d.origColor = $('#origColor').value;
  d.fontWeight = +$('#fontWeight').value;
  d.offsetMs = +$('#offsetMs').value || 0;
  d.hideNative = $('#hideNative').checked;
  d.showStatus = $('#showStatus').checked;
}

function updateOutputs() {
  $('#fontScaleOut').textContent = Math.round($('#fontScale').value * 100) + '%';
  $('#origScaleOut').textContent = Math.round($('#origScale').value * 100) + '%';
  $('#bgOpacityOut').textContent = Math.round($('#bgOpacity').value * 100) + '%';
  $('#bottomOut').textContent = $('#bottom').value + '%';
}

function updatePreview() {
  const box = $('#pvBox');
  const fs = 22 * +$('#fontScale').value;
  const mode = $('#mode').value;
  box.style.bottom = $('#bottom').value + '%';
  box.style.background = `rgba(0,0,0,${$('#bgOpacity').value})`;
  box.classList.toggle('rev', $('#order').value === 'orig-top');
  const tr = box.querySelector('.pv-tr');
  const or = box.querySelector('.pv-or');
  Object.assign(tr.style, { fontSize: fs + 'px', color: $('#transColor').value, fontWeight: $('#fontWeight').value, display: mode === 'original' ? 'none' : '' });
  Object.assign(or.style, { fontSize: fs * +$('#origScale').value + 'px', color: $('#origColor').value, display: mode === 'translation' ? 'none' : '' });
}

// -------------------------------------------------------------- permissions
// Must be called synchronously inside a click handler (user gesture).
function requestOrigin(baseUrl) {
  let origin;
  try { origin = new URL(baseUrl || N.DEFAULTS.providers[cur].baseUrl).origin; } catch (e) { return Promise.resolve(false); }
  return chrome.permissions.request({ origins: [origin + '/*'] }).catch(() => false);
}

function currentCfg() {
  readProviderForm();
  const p = { ...draft.providers[cur] };
  if (!p.baseUrl) p.baseUrl = N.DEFAULTS.providers[cur].baseUrl;
  return p;
}

const esc = (s) => String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

// --------------------------------------------------------------------- init
async function init() {
  draft = structuredClone(await N.getSettings());
  cur = draft.provider;
  fillForm();
  refreshCacheStats();

  document.querySelectorAll('#providerTabs button').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.p === cur) return;
    readProviderForm();
    cur = b.dataset.p;
    fillProviderForm();
    markDirty();
  }));

  $('#toggleKey').addEventListener('click', () => {
    const k = $('#apiKey');
    k.type = k.type === 'password' ? 'text' : 'password';
    $('#toggleKey').textContent = k.type === 'password' ? '显示' : '隐藏';
  });

  $('#targetLang').addEventListener('change', () => {
    $('#customLangField').hidden = $('#targetLang').value !== '__custom';
  });

  document.querySelectorAll('input, select, textarea').forEach((el) => {
    el.addEventListener('input', () => { markDirty(); updateOutputs(); updatePreview(); });
    el.addEventListener('change', () => { markDirty(); updatePreview(); });
  });

  $('#fetchModels').addEventListener('click', async () => {
    const cfg = currentCfg();
    const perm = requestOrigin(cfg.baseUrl);
    const btn = $('#fetchModels');
    btn.disabled = true;
    btn.textContent = '获取中…';
    await perm;
    try {
      const res = await chrome.runtime.sendMessage({ type: 'ntusub-models', provider: cur, cfg });
      if (!res.ok) throw new Error(res.error);
      $('#modelList').innerHTML = res.models.map((m) => `<option value="${esc(m)}">`).join('');
      $('#testResult').innerHTML = `<span class="ok">获取到 ${res.models.length} 个模型</span>，点击模型输入框即可选择。`;
      $('#model').focus();
    } catch (e) {
      $('#testResult').innerHTML = `<span class="err">获取模型列表失败：${esc(e.message)}</span><div class="muted small">部分代理不支持列出模型，可直接手动输入模型名。</div>`;
    } finally {
      btn.disabled = false;
      btn.textContent = '获取模型列表';
    }
  });

  $('#test').addEventListener('click', async () => {
    const cfg = currentCfg();
    const perm = requestOrigin(cfg.baseUrl);
    const btn = $('#test');
    btn.disabled = true;
    $('#testResult').innerHTML = '<span class="muted">正在请求模型…</span>';
    await perm;
    readForm();
    try {
      const settingsDraft = structuredClone(draft);
      settingsDraft.providers[cur] = cfg;
      const res = await chrome.runtime.sendMessage({ type: 'ntusub-test', provider: cur, settings: settingsDraft });
      if (!res.ok) throw new Error(res.error);
      const ok = res.lines.every((l) => l.tr);
      $('#testResult').innerHTML =
        `<span class="${ok ? 'ok' : 'err'}">${ok ? '连接成功' : '已连接，但输出解析失败'}</span> <span class="muted">· ${res.ms} ms</span>` +
        res.lines.map((l) => `<div class="pair">${esc(l.tr || '（无）')}<div class="muted small">${esc(l.src)}</div></div>`).join('') +
        (res.raw ? `<div class="muted small">原始输出：${esc(res.raw)}</div>` : '');
    } catch (e) {
      $('#testResult').innerHTML = `<span class="err">失败：${esc(e.message)}</span>`;
    } finally {
      btn.disabled = false;
    }
  });

  $('#save').addEventListener('click', async () => {
    const cfg = currentCfg();
    const perm = requestOrigin(cfg.baseUrl);
    readForm();
    for (const [name, v] of [['额外请求头', draft.providers[cur].extraHeaders], ['额外请求体', draft.providers[cur].extraBody]]) {
      if (v && v.trim()) {
        try { JSON.parse(v); } catch (e) { $('#saveMsg').textContent = `${name} 不是合法 JSON，未保存`; return; }
      }
    }
    const granted = await perm;
    await chrome.storage.local.set({ settings: draft });
    dirty = false;
    $('#saveMsg').textContent = granted === false
      ? '已保存（未授予接口域名权限，若请求被 CORS 拦截请重新保存并允许）'
      : '已保存 ✓ 已打开的视频页面会自动应用新设置';
  });

  $('#clearCache').addEventListener('click', async () => {
    if (!confirm('确定清空所有视频的翻译缓存吗？')) return;
    const res = await chrome.runtime.sendMessage({ type: 'ntusub-cache-clear' });
    refreshCacheStats(res && res.ok ? `已清除 ${res.removed} 个视频的缓存` : '');
  });

  window.addEventListener('beforeunload', (e) => {
    if (dirty) { e.preventDefault(); e.returnValue = ''; }
  });

  document.addEventListener('keydown', (e) => {
    if ((e.ctrlKey || e.metaKey) && e.key === 's') { e.preventDefault(); $('#save').click(); }
  });
}

async function refreshCacheStats(prefix) {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'ntusub-cache-stats' });
    if (!res || !res.ok) return;
    const mb = (res.bytes / 1024 / 1024).toFixed(2);
    $('#cacheStats').textContent = (prefix ? prefix + ' · ' : '') + `已缓存 ${res.videos} 个视频 · 本地占用约 ${mb} MB`;
  } catch (e) { /* ignore */ }
}

init();
