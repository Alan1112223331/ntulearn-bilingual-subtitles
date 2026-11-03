const N = globalThis.NTUSUB;
const $ = (s) => document.querySelector(s);

// Embedded as the side panel's 设置 tab.
if (new URLSearchParams(location.search).has('embed')) document.documentElement.classList.add('embed');

const HINTS = {
  openai: '兼容 OpenAI Chat Completions 的接口：OpenAI、DeepSeek、通义千问、OpenRouter、one-api / new-api 等。Base URL 一般以 /v1 结尾，会自动拼接 /chat/completions。',
  anthropic: 'Anthropic Messages API 或兼容代理。填写根地址即可（如 https://api.anthropic.com），会自动拼接 /v1/messages。',
  gemini: 'Google Gemini generateContent 接口或兼容代理。会自动拼接 /v1beta/models/{模型}:generateContent。',
  chatgpt: '用你的 ChatGPT 套餐额度（Sign in with ChatGPT），不需要 API Key。请求发往 OpenAI 官方 Responses API，用量计入你的 ChatGPT 套餐；只需登录一次，翻译和笔记问答共用。'
};
const BODY_PLACEHOLDER = {
  openai: '{"reasoning_effort": "low"}',
  anthropic: '{"max_tokens": 8192}',
  gemini: '{"generationConfig": {"thinkingConfig": {"thinkingBudget": 0}}}',
  chatgpt: '{"reasoning": {"effort": "low"}}'
};
const MODEL_EXAMPLES = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-haiku-5-5',
  gemini: 'gemini-2.5-flash',
  chatgpt: '登录后获取'
};
// Models that cannot do chat translation (embeddings, rerankers, speech, images…).
const NON_CHAT_MODEL = /embed|rerank|bge-|tts|whisper|voice|speech|audio|transcri|dall-e|image|imagen|moderation|sensevoice|cosyvoice|\bsd[-_]|stable-diffusion|flux/i;
const PROVIDER_FIELDS =['baseUrl', 'apiKey', 'model', 'temperature', 'extraHeaders', 'extraBody'];
const PRESET_LANGS = Array.from(document.querySelectorAll('#targetLang option')).map((o) => o.value).filter((v) => v !== '__custom');

let draft = null;
let cur = 'openai'; // selected AI format tab
let engine = 'basic'; // 'basic' (Google, no config) | 'ai'
let dirty = false;

function markDirty() {
  dirty = true;
  $('#saveMsg').textContent = '有未保存的更改';
}

// The provider id the current form represents.
const activeProvider = () => (engine === 'basic' ? N.BASIC_PROVIDER : cur);

function showEngine() {
  document.querySelectorAll('#engines .engine').forEach((b) => {
    const on = b.dataset.engine === engine;
    b.classList.toggle('on', on);
    b.setAttribute('aria-checked', String(on));
  });
  $('#basicPanel').hidden = engine !== 'basic';
  $('#aiPanel').hidden = engine !== 'ai';
  $('#aiOnlyNote').hidden = engine !== 'basic';
  $('#aiOnlyOpts').classList.toggle('dim', engine === 'basic');
  $('#assistNote').hidden = engine !== 'basic';
  $('#assistCard').classList.toggle('dim', engine === 'basic');
  $('#clearProvider').hidden = engine === 'basic';
  $('#testResult').innerHTML = '';
}

// ------------------------------------------------------------- provider tab
function readProviderForm() {
  const p = draft.providers[cur];
  for (const f of PROVIDER_FIELDS) p[f] = $('#' + f).value.trim();
  if (cur === 'chatgpt') Object.assign(p, { baseUrl: N.DEFAULTS.providers.chatgpt.baseUrl, apiKey: '', temperature: '', extraHeaders: '' });
}

function fillProviderForm() {
  const p = draft.providers[cur];
  for (const f of PROVIDER_FIELDS) $('#' + f).value = p[f] ?? '';
  document.querySelectorAll('#providerTabs button').forEach((b) => b.classList.toggle('on', b.dataset.p === cur));
  $('#providerHint').textContent = HINTS[cur];
  $('#baseUrl').placeholder = N.DEFAULTS.providers[cur].baseUrl;
  $('#extraBody').placeholder = '例如 ' + BODY_PLACEHOLDER[cur];
  $('#model').placeholder = cur === 'chatgpt' ? '登录后点「获取模型列表」选择' : `手动输入，或点「获取模型列表」选择（如 ${MODEL_EXAMPLES[cur]}）`;
  $('#aiPanel').classList.toggle('is-cgpt', cur === 'chatgpt');
  renderCgpt();
  modelPicker.setModels([]);
  $('#testResult').innerHTML = '';
}

// ------------------------------------------------------------- model picker
// Text input with a themed dropdown. Opening it shows the full list; typing filters it.
function createModelPicker(ids) {
  const combo = $(ids.combo);
  const input = $(ids.input);
  const menu = $(ids.menu);
  let models = [];
  let shown = [];
  let active = -1;
  let filter = '';

  const isOpen = () => !menu.hidden;

  function highlight(name) {
    if (!filter) return esc(name);
    const i = name.toLowerCase().indexOf(filter.toLowerCase());
    if (i < 0) return esc(name);
    return esc(name.slice(0, i)) + '<mark>' + esc(name.slice(i, i + filter.length)) + '</mark>' + esc(name.slice(i + filter.length));
  }

  function render() {
    const q = filter.toLowerCase();
    const match = models.filter((m) => !q || m.toLowerCase().includes(q));
    const chat = match.filter((m) => !NON_CHAT_MODEL.test(m));
    const other = match.filter((m) => NON_CHAT_MODEL.test(m));
    shown = chat.concat(other);
    if (active === null) active = filter ? 0 : Math.max(0, shown.indexOf(input.value)); // fresh open
    if (active >= shown.length) active = shown.length - 1;
    const item = (m, i, dim) =>
      `<div class="combo-item${dim ? ' dim' : ''}${i === active ? ' active' : ''}" role="option" data-i="${i}"` +
      ` aria-selected="${m === input.value}"><span class="check">${m === input.value ? '✓' : ''}</span>${highlight(m)}</div>`;
    let html = `<div class="combo-head">${filter ? `匹配 ${match.length} / ${models.length} 个模型` : `共 ${models.length} 个模型 · 输入可筛选`}</div>`;
    if (!shown.length) html += '<div class="combo-empty">没有匹配的模型，可直接使用输入的名称</div>';
    html += chat.map((m, i) => item(m, i, false)).join('');
    if (other.length) {
      html += '<div class="combo-group">非对话模型（不适合翻译）</div>';
      html += other.map((m, i) => item(m, chat.length + i, true)).join('');
    }
    menu.innerHTML = html;
    // Keep the active item visible by scrolling the menu only (not the page).
    const el = menu.querySelector('.combo-item.active');
    if (el) {
      const head = menu.querySelector('.combo-head').offsetHeight;
      if (el.offsetTop - head < menu.scrollTop) menu.scrollTop = el.offsetTop - head - 4;
      else if (el.offsetTop + el.offsetHeight > menu.scrollTop + menu.clientHeight) menu.scrollTop = el.offsetTop + el.offsetHeight - menu.clientHeight + 4;
    }
  }

  function open(withFilter) {
    if (!models.length) return false;
    filter = withFilter ? input.value.trim() : '';
    active = null; // resolved against the displayed order in render()
    menu.hidden = false;
    // Fit between the input and the fixed save bar; flip upwards when there is more room above.
    const r = input.getBoundingClientRect();
    const saveBar = $('.savebar').getBoundingClientRect().top;
    const below = saveBar - r.bottom - 12;
    const above = r.top - 12;
    const up = below < 240 && above > below;
    menu.classList.toggle('up', up);
    menu.style.maxHeight = Math.max(140, Math.min(320, up ? above : below)) + 'px';
    combo.classList.add('open');
    input.setAttribute('aria-expanded', 'true');
    render();
    return true;
  }

  function close() {
    menu.hidden = true;
    combo.classList.remove('open');
    input.setAttribute('aria-expanded', 'false');
  }

  function choose(i) {
    const m = shown[i];
    if (m == null) return;
    input.value = m;
    close();
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.focus();
  }

  input.addEventListener('focus', () => { if (!isOpen()) open(false); });
  input.addEventListener('click', () => { if (!isOpen()) open(false); });
  input.addEventListener('input', (e) => {
    if (!e.isTrusted) return; // value set by choose()
    if (!isOpen()) open(true);
    else { filter = input.value.trim(); active = null; render(); }
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!isOpen()) { open(false); return; }
      const d = e.key === 'ArrowDown' ? 1 : -1;
      active = Math.max(0, Math.min(shown.length - 1, active + d));
      render();
    } else if (e.key === 'Enter' && isOpen() && active >= 0) {
      e.preventDefault();
      choose(active);
    } else if (e.key === 'Escape' && isOpen()) {
      e.preventDefault();
      close();
    } else if (e.key === 'Tab') {
      close();
    }
  });
  $(ids.toggle).addEventListener('click', () => {
    if (isOpen()) { close(); return; }
    if (!open(false)) $(ids.fetch).click();
    else input.focus();
  });
  menu.addEventListener('mousedown', (e) => e.preventDefault()); // keep focus in the input
  menu.addEventListener('click', (e) => {
    const el = e.target.closest('.combo-item');
    if (el) choose(+el.dataset.i);
  });
  document.addEventListener('mousedown', (e) => { if (!combo.contains(e.target)) close(); });

  return {
    setModels(list) { models = list; if (!list.length) close(); },
    open: () => open(false)
  };
}

const modelPicker = createModelPicker({ combo: '#modelCombo', input: '#model', menu: '#modelMenu', toggle: '#modelToggle', fetch: '#fetchModels' });
const assistPicker = createModelPicker({ combo: '#aModelCombo', input: '#aModel', menu: '#aModelMenu', toggle: '#aModelToggle', fetch: '#aFetchModels' });

// ------------------------------------------------------- notes & chat model
// Form ids of the optional dedicated model, by settings field.
const ASSIST_IDS = { baseUrl: '#aBaseUrl', apiKey: '#aApiKey', model: '#aModel', temperature: '#aTemperature', extraHeaders: '#aExtraHeaders', extraBody: '#aExtraBody' };

let aCur = 'openai'; // selected format of the dedicated model

function readAssistForm() {
  draft.assist.provider = aCur;
  for (const f in ASSIST_IDS) draft.assist[f] = $(ASSIST_IDS[f]).value.trim();
  if (aCur === 'chatgpt') Object.assign(draft.assist, { baseUrl: '', apiKey: '', temperature: '', extraHeaders: '' });
}

function fillAssistForm() {
  const a = draft.assist;
  aCur = N.AI_PROVIDERS.includes(a.provider) ? a.provider : 'openai';
  for (const f in ASSIST_IDS) $(ASSIST_IDS[f]).value = a[f] ?? '';
  updateAssistForm();
}

// Format tabs, hint and placeholders follow the chosen format; the heading says whether the model is in use.
function updateAssistForm() {
  const p = aCur;
  document.querySelectorAll('#aProviderTabs button').forEach((b) => b.classList.toggle('on', b.dataset.p === p));
  $('#aProviderHint').textContent = HINTS[p];
  $('#aBaseUrl').placeholder = N.DEFAULTS.providers[p].baseUrl;
  $('#aExtraBody').placeholder = '例如 ' + BODY_PLACEHOLDER[p];
  $('#aModel').placeholder = p === 'chatgpt' ? '留空 = 使用上面的翻译模型；登录后可获取列表' : `留空 = 使用上面的翻译模型（如 ${MODEL_EXAMPLES[p]}）`;
  $('#assistCard').classList.toggle('is-cgpt', p === 'chatgpt');
  renderCgpt();
  const model = $('#aModel').value.trim();
  $('#assistState').innerHTML = model ? `<span class="ok">已启用</span> · 笔记与问答使用 ${esc(model)}` : '未配置 · 笔记与问答使用上面的翻译模型';
}

function assistCfg() {
  readAssistForm();
  const { provider, ...cfg } = draft.assist;
  if (!cfg.baseUrl) cfg.baseUrl = N.DEFAULTS.providers[provider].baseUrl;
  return { provider, cfg };
}

// Fetches the model list of a provider config into a picker; shared by both model fields.
async function fetchModels(picker, btn, input, resultEl, provider, cfg, perm) {
  btn.disabled = true;
  btn.textContent = '获取中…';
  await perm;
  try {
    const res = await chrome.runtime.sendMessage({ type: 'ntusub-models', provider, cfg });
    if (!res.ok) throw new Error(res.error);
    picker.setModels(res.models);
    resultEl.innerHTML = res.models.length
      ? `<span class="ok">获取到 ${res.models.length} 个模型</span>，已展开列表，可输入关键字筛选。`
      : '<span class="err">接口没有返回任何模型</span>，可直接手动输入模型名。';
    input.focus();
    picker.open();
  } catch (e) {
    resultEl.innerHTML = `<span class="err">获取模型列表失败：${esc(e.message)}</span><div class="muted small">部分代理不支持列出模型，可直接手动输入模型名。</div>`;
  } finally {
    btn.disabled = false;
    btn.textContent = '获取模型列表';
  }
}

// ------------------------------------------------------- ChatGPT sign-in
// One sign-in serves every setting that uses the subscription; both boxes show the same state.
const CGPT_ORIGINS = ['https://auth.openai.com/*', 'https://api.openai.com/*', 'http://127.0.0.1/*'];
const USAGE_URL = 'https://chatgpt.com/#settings';
let cgpt = null; // last status from the background
let welcomeDismissed = false;

function cgptHTML(st, withWelcome) {
  if (!st) return '<p class="muted">正在读取登录状态…</p>';
  const login = st.login || {};
  if (login.status === 'pending' && !login.expired) {
    return '<p>已在新标签页打开 ChatGPT 登录页。登录并授权后，那个标签页会自动关闭并回到这里。</p>' +
      '<div class="cgpt-actions"><button type="button" class="ghost" data-cgpt="cancel">取消登录</button></div>';
  }
  if (login.status === 'exchanging') return '<p>正在完成登录…</p>';
  if (st.signedIn) {
    const who = esc(st.email || st.name || 'ChatGPT 账号') + (st.plan ? ` · ${esc(st.plan)}` : '');
    const welcome = withWelcome && login.status === 'ok' && login.firstTime && !welcomeDismissed
      ? '<div class="cgpt-welcome"><b>You\'re using your ChatGPT plan</b><p class="muted small">本扩展的 AI 请求（选择了「ChatGPT 订阅」的翻译、笔记和问答）会使用你的 ChatGPT 套餐额度，可以在 ChatGPT 设置里查看和调整用量。</p>' +
        '<button type="button" class="ghost" data-cgpt="welcome-ok">Got it</button></div>'
      : '';
    return welcome +
      `<div class="cgpt-row"><span class="cgpt-dot"></span><b>Using ChatGPT plan</b><span class="muted">${who}</span></div>` +
      (st.planScope ? '' : '<p class="cgpt-err">该账号没有授予使用套餐的权限，请退出后重新登录。</p>') +
      '<p class="muted small">翻译和笔记问答共用这一个登录，在这里登录过一次，两处都不用再登录。</p>' +
      `<div class="cgpt-actions"><a href="${USAGE_URL}" target="_blank" rel="noopener">Manage usage</a>` +
      '<button type="button" class="ghost" data-cgpt="logout">退出登录</button>' +
      '<button type="button" class="linkish" data-cgpt="other">换一个账号</button></div>';
  }
  const err = login.status === 'error' ? `<p class="cgpt-err">登录失败：${esc(login.error)}</p>` : '';
  const prev = st.hasPrevious && st.previousEmail
    ? `<p class="muted small">将登录上次的账号 ${esc(st.previousEmail)} · <button type="button" class="linkish" data-cgpt="other">换一个账号</button></p>` : '';
  return err +
    `<div class="cgpt-actions"><button type="button" class="cgpt-btn" data-cgpt="login">Continue with ChatGPT</button></div>` + prev +
    '<p class="muted small">需要支持「在第三方应用中使用 ChatGPT 套餐」的方案（OpenAI 预览功能）。登录在新标签页的 OpenAI 官方页面完成，扩展不会接触你的密码。</p>';
}

function renderCgpt() {
  // The one-time welcome goes in the first box that is in use.
  const boxes = [...document.querySelectorAll('.cgpt-box')];
  const first = boxes.find((el) => el.offsetParent !== null);
  boxes.forEach((el) => { el.innerHTML = cgptHTML(cgpt, el === first); });
}

async function refreshCgpt() {
  try {
    const res = await chrome.runtime.sendMessage({ type: 'ntusub-cgpt-status' });
    if (res && res.ok) cgpt = res;
  } catch (e) { /* worker restarting */ }
  renderCgpt();
}

function initCgpt() {
  document.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-cgpt]');
    if (!b) return;
    const act = b.dataset.cgpt;
    if (act === 'login' || act === 'other') {
      // Permission prompt must start synchronously inside the click.
      const perm = chrome.permissions.request({ origins: CGPT_ORIGINS }).catch(() => false);
      welcomeDismissed = false;
      if (!(await perm)) {
        cgpt = { ...(cgpt || {}), login: { status: 'error', error: '需要允许访问 auth.openai.com、api.openai.com 和本机回调地址才能登录' } };
        renderCgpt();
        return;
      }
      const res = await chrome.runtime.sendMessage({ type: 'ntusub-cgpt-login', newAccount: act === 'other' || (cgpt && cgpt.signedIn) });
      if (!res || !res.ok) { cgpt = { ...(cgpt || {}), login: { status: 'error', error: (res && res.error) || '无法开始登录' } }; renderCgpt(); }
    } else if (act === 'cancel') {
      await chrome.runtime.sendMessage({ type: 'ntusub-cgpt-cancel' });
    } else if (act === 'logout') {
      if (!confirm('退出 ChatGPT 登录？选择了「ChatGPT 订阅」的翻译和笔记问答将无法使用，直到重新登录。')) return;
      const res = await chrome.runtime.sendMessage({ type: 'ntusub-cgpt-logout' });
      if (res && res.ok && !res.revoked) alert('已在本机退出登录，但未能确认 OpenAI 端已撤销授权；如有需要，可在 ChatGPT 设置中断开本扩展。');
    } else if (act === 'welcome-ok') {
      welcomeDismissed = true;
      renderCgpt();
      return;
    }
    refreshCgpt();
  });
  chrome.storage.onChanged.addListener((ch, area) => {
    if ((area === 'local' && ch.chatgptAuth) || (area === 'session' && ch.chatgptLogin)) refreshCgpt();
  });
  refreshCgpt();
}

// ------------------------------------------------------------------ general
function fillForm() {
  fillProviderForm();
  fillAssistForm();
  showEngine();
  $('#notesEnabled').checked = draft.notesEnabled !== false;
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
  readAssistForm();
  draft.notesEnabled = $('#notesEnabled').checked;
  draft.provider = activeProvider();
  draft.aiProvider = cur;
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
function requestOrigin(...baseUrls) {
  const origins = [];
  for (const u of baseUrls) {
    try { origins.push(new URL(u || N.DEFAULTS.providers[cur].baseUrl).origin + '/*'); } catch (e) { /* skip */ }
  }
  if (!origins.length) return Promise.resolve(false);
  return chrome.permissions.request({ origins: [...new Set(origins)] }).catch(() => false);
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
  engine = N.isBasic(draft) ? 'basic' : 'ai';
  cur = N.AI_PROVIDERS.includes(draft.provider) ? draft.provider
    : (N.AI_PROVIDERS.includes(draft.aiProvider) ? draft.aiProvider : 'openai');
  fillForm();
  initCgpt();
  refreshCacheStats();

  document.querySelectorAll('#engines .engine').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.engine === engine) return;
    engine = b.dataset.engine;
    showEngine();
    markDirty();
  }));

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

  $('#fetchModels').addEventListener('click', () => {
    const cfg = currentCfg();
    const perm = requestOrigin(cfg.baseUrl);
    fetchModels(modelPicker, $('#fetchModels'), $('#model'), $('#testResult'), cur, cfg, perm);
  });

  $('#clearProvider').addEventListener('click', () => {
    const what = cur === 'chatgpt' ? '的模型名称和高级参数（不会退出 ChatGPT 登录）' : '的接口地址、API Key、模型名称和高级参数';
    if (!confirm(`清空「${N.PROVIDER_LABELS[cur]}」${what}？保存后生效。`)) return;
    for (const f of PROVIDER_FIELDS) $('#' + f).value = '';
    modelPicker.setModels([]);
    $('#testResult').innerHTML = '<span class="muted">已清空，点「保存设置」后生效。</span>';
    markDirty();
  });

  // ---- notes & chat model
  document.querySelectorAll('#aProviderTabs button').forEach((b) => b.addEventListener('click', () => {
    if (b.dataset.p === aCur) return;
    aCur = b.dataset.p;
    assistPicker.setModels([]);
    updateAssistForm();
    markDirty();
  }));
  $('#aModel').addEventListener('input', updateAssistForm);
  $('#aToggleKey').addEventListener('click', () => {
    const k = $('#aApiKey');
    k.type = k.type === 'password' ? 'text' : 'password';
    $('#aToggleKey').textContent = k.type === 'password' ? '显示' : '隐藏';
  });
  $('#aFetchModels').addEventListener('click', () => {
    const { provider, cfg } = assistCfg();
    const perm = requestOrigin(cfg.baseUrl);
    fetchModels(assistPicker, $('#aFetchModels'), $('#aModel'), $('#aTestResult'), provider, cfg, perm);
  });
  $('#aClear').addEventListener('click', () => {
    if (!confirm('清空笔记与问答的专用模型配置？保存后笔记与问答改用上面的翻译模型。')) return;
    aCur = N.DEFAULTS.assist.provider;
    for (const f in ASSIST_IDS) $(ASSIST_IDS[f]).value = '';
    assistPicker.setModels([]);
    updateAssistForm();
    $('#aTestResult').innerHTML = '<span class="muted">已清空，点「保存设置」后生效。</span>';
    markDirty();
  });
  $('#aTest').addEventListener('click', async () => {
    const { provider, cfg } = assistCfg();
    const out = $('#aTestResult');
    if (!cfg.model) { out.innerHTML = '<span class="err">请先填写模型名称</span>'; return; }
    const perm = requestOrigin(cfg.baseUrl);
    const btn = $('#aTest');
    btn.disabled = true;
    out.innerHTML = '<span class="muted">正在请求模型…</span>';
    await perm;
    try {
      const settingsDraft = structuredClone(draft);
      settingsDraft.providers[provider] = cfg;
      const res = await chrome.runtime.sendMessage({ type: 'ntusub-test', provider, settings: settingsDraft });
      if (!res.ok) throw new Error(res.error);
      out.innerHTML = `<span class="ok">连接成功</span> <span class="muted">· ${res.ms} ms</span>` +
        res.lines.map((l) => `<div class="pair">${esc(l.tr || '（无）')}<div class="muted small">${esc(l.src)}</div></div>`).join('');
    } catch (e) {
      out.innerHTML = `<span class="err">失败：${esc(e.message)}</span>`;
    } finally {
      btn.disabled = false;
    }
  });

  $('#test').addEventListener('click', async () => {
    const basic = engine === 'basic';
    const cfg = currentCfg();
    const perm = basic ? Promise.resolve(true) : requestOrigin(cfg.baseUrl);
    const btn = $('#test');
    btn.disabled = true;
    $('#testResult').innerHTML = `<span class="muted">${basic ? '正在请求 Google 翻译…' : '正在请求模型…'}</span>`;
    await perm;
    readForm();
    try {
      const settingsDraft = structuredClone(draft);
      settingsDraft.providers[cur] = cfg;
      const res = await chrome.runtime.sendMessage({ type: 'ntusub-test', provider: activeProvider(), settings: settingsDraft });
      if (!res.ok) throw new Error(res.error);
      const ok = res.lines.every((l) => l.tr);
      const okText = basic ? '翻译正常' : '连接成功';
      $('#testResult').innerHTML =
        `<span class="${ok ? 'ok' : 'err'}">${ok ? okText : '已连接，但输出解析失败'}</span> <span class="muted">· ${res.ms} ms</span>` +
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
    const assist = assistCfg();
    const perm = engine === 'basic' ? Promise.resolve(true)
      : (assist.cfg.model ? requestOrigin(cfg.baseUrl, assist.cfg.baseUrl) : requestOrigin(cfg.baseUrl));
    readForm();
    for (const [name, v] of [['额外请求头', draft.providers[cur].extraHeaders], ['额外请求体', draft.providers[cur].extraBody],
      ['专用模型的额外请求头', draft.assist.extraHeaders], ['专用模型的额外请求体', draft.assist.extraBody]]) {
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
    if (!confirm('确定清空所有视频的译文、笔记和对话记录吗？')) return;
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
