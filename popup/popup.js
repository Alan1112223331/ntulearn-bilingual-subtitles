const N = globalThis.NTUSUB;
const $ = (s) => document.querySelector(s);
let settings = N.DEFAULTS;
let tabId = null;

function save(patch) {
  return N.saveSettings(patch).then((s) => { settings = s; });
}

function fillUI() {
  const d = settings.display;
  $('#enabled').checked = settings.enabled;
  const cfg = settings.providers[settings.provider];
  $('#model').textContent = `${N.PROVIDER_LABELS[settings.provider]} · ${cfg.model || '未设置模型'} → ${settings.targetLang}`;
  document.querySelectorAll('#mode button').forEach((b) => b.classList.toggle('on', b.dataset.v === d.mode));
  $('#fontScale').value = d.fontScale;
  $('#fontScaleOut').textContent = Math.round(d.fontScale * 100) + '%';
  $('#bgOpacity').value = d.bgOpacity;
  $('#bgOpacityOut').textContent = Math.round(d.bgOpacity * 100) + '%';
  $('#transTop').checked = d.order === 'trans-top';
  $('#hideNative').checked = d.hideNative;
}

const SOURCE_LABEL = {
  network: '已获取完整字幕',
  texttrack: '已获取字幕轨道',
  dom: '实时模式（逐句翻译）'
};

function setStatus({ text, cls = '', pct = null, err = '' }) {
  $('#statusText').textContent = text;
  $('#dot').className = 'dot ' + cls;
  $('#bar').parentElement.style.display = pct == null ? 'none' : '';
  if (pct != null) $('#bar').style.width = pct + '%';
  $('#err').textContent = err;
}

async function refreshStatus() {
  if (tabId == null) return;
  let st = null;
  try {
    st = await chrome.tabs.sendMessage(tabId, { type: 'ntusub-status' });
  } catch (e) { /* no content script / no video in this tab */ }
  const hasTrack = !!(st && st.source && st.source !== 'dom');
  $('#export').disabled = !hasTrack;
  $('#retranslate').disabled = !(st && st.source);
  if (!st) {
    setStatus({ text: '当前页面未检测到 Media Gallery 视频' });
    return;
  }
  if (!settings.enabled) {
    setStatus({ text: '已关闭' });
    return;
  }
  if (!st.source) {
    setStatus({ text: '已检测到视频，等待字幕…（若无字幕请在播放器中打开 CC）', cls: 'busy', err: st.error || '' });
    return;
  }
  if (st.source === 'dom') {
    setStatus({ text: SOURCE_LABEL.dom, cls: st.error ? 'err' : 'ok', err: st.error || '' });
    return;
  }
  const pct = st.total ? Math.floor((st.done / st.total) * 100) : 0;
  const done = st.done >= st.total;
  let cls = done ? 'ok' : 'busy';
  if (st.halted || (st.error && !st.running)) cls = 'err';
  setStatus({
    text: `${SOURCE_LABEL[st.source]} · ${st.total} 条 · 已翻译 ${pct}%`,
    cls,
    pct,
    err: st.error || ''
  });
}

async function init() {
  settings = await N.getSettings();
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  tabId = tab ? tab.id : null;
  fillUI();
  refreshStatus();
  setInterval(refreshStatus, 1000);

  $('#enabled').addEventListener('change', (e) => save({ enabled: e.target.checked }).then(refreshStatus));
  document.querySelectorAll('#mode button').forEach((b) => b.addEventListener('click', () => {
    save({ display: { mode: b.dataset.v } }).then(fillUI);
  }));
  $('#fontScale').addEventListener('input', (e) => {
    $('#fontScaleOut').textContent = Math.round(e.target.value * 100) + '%';
    save({ display: { fontScale: +e.target.value } });
  });
  $('#bgOpacity').addEventListener('input', (e) => {
    $('#bgOpacityOut').textContent = Math.round(e.target.value * 100) + '%';
    save({ display: { bgOpacity: +e.target.value } });
  });
  $('#transTop').addEventListener('change', (e) => save({ display: { order: e.target.checked ? 'trans-top' : 'orig-top' } }));
  $('#hideNative').addEventListener('change', (e) => save({ display: { hideNative: e.target.checked } }));
  $('#options').addEventListener('click', () => chrome.runtime.openOptionsPage());

  $('#retranslate').addEventListener('click', async () => {
    try { await chrome.tabs.sendMessage(tabId, { type: 'ntusub-retranslate' }); } catch (e) { /* ignore */ }
    refreshStatus();
  });

  $('#export').addEventListener('click', async () => {
    let res;
    try { res = await chrome.tabs.sendMessage(tabId, { type: 'ntusub-export' }); } catch (e) { /* ignore */ }
    if (!res || !res.ok) { $('#err').textContent = (res && res.error) || '导出失败'; return; }
    const name = ((tab && tab.title) || 'subtitles').replace(/[\\/:*?"<>|]+/g, '_').slice(0, 80) + '.bilingual.srt';
    const url = URL.createObjectURL(new Blob(['﻿' + res.srt], { type: 'application/x-subrip;charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: name });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  });
}

init();
