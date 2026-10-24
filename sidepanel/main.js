// Side panel controller: tabs, header status, AI-mode locks, settings frame, playback loop.
(() => {
  const P = globalThis.Panel;
  const N = globalThis.NTUSUB;
  const $ = (s) => document.querySelector(s);
  const views = { chat: globalThis.ChatView, notes: globalThis.NotesView, transcript: globalThis.TranscriptView, settings: null };
  const AI_ONLY = ['chat', 'notes'];
  let current = null;

  if (new URLSearchParams(location.search).has('popup')) document.body.classList.add('popup');

  // ------------------------------------------------------------------ tabs
  function show(tab) {
    if (!(tab in views)) tab = 'transcript';
    if (current && views[current] && views[current].onHide) views[current].onHide();
    current = tab;
    document.querySelectorAll('.tabs button').forEach((b) => {
      const on = b.dataset.tab === tab;
      b.classList.toggle('on', on);
      b.setAttribute('aria-selected', String(on));
    });
    document.querySelectorAll('.view').forEach((v) => { v.hidden = v.id !== 'view-' + tab; });
    if (tab === 'settings') {
      const f = $('#settingsFrame');
      if (!f.src) f.src = '../options/options.html?embed=1';
    }
    try { localStorage.setItem('ntusub-tab', tab); } catch (e) { /* ignore */ }
    if (views[tab] && views[tab].onShow && !(AI_ONLY.includes(tab) && !P.isAI())) views[tab].onShow();
  }

  function applyLocks() {
    const ai = P.isAI();
    for (const tab of AI_ONLY) {
      const view = $('#view-' + tab);
      view.classList.toggle('locked', !ai);
      document.querySelector(`.tabs [data-tab="${tab}"]`).classList.toggle('needs-ai', !ai);
    }
    if (current && AI_ONLY.includes(current) && ai && views[current].onShow) views[current].onShow();
  }

  // ---------------------------------------------------------------- header
  function updateHeader() {
    const S = P.S;
    $('#lectureTitle').textContent = P.lectureTitle() || 'NTU 双语字幕';
    $('#enabled').checked = !!S.settings.enabled;
    const st = $('#status');
    st.classList.remove('err');
    if (!S.port) { st.textContent = '未检测到视频 · 打开 Media Gallery 课程视频后自动连接'; return; }
    if (!S.info || !S.cues.length) {
      st.textContent = S.info && S.info.source === 'dom' ? '实时模式 · 未获取到完整字幕' : '已连接视频 · 等待字幕…';
      return;
    }
    let done = 0;
    for (const c of S.cues) if (S.trans.has(c.key)) done++;
    const pct = Math.floor((done / S.cues.length) * 100);
    const mode = N.isBasic(S.settings) ? '基础模式' : 'AI 模式';
    if (!S.settings.enabled) st.textContent = `视频字幕已关闭 · ${S.cues.length} 条字幕`;
    else st.textContent = `${mode} · ${S.cues.length} 条字幕 · 已翻译 ${pct}%`;
    if (S.info.error && (S.info.halted || pct < 100)) {
      st.textContent += ' · ' + S.info.error;
      st.classList.add('err');
    }
  }

  // ------------------------------------------------------- playback loop
  let lastIdx = -2;
  let lastT = 0;
  function frame() {
    const t = P.currentTime();
    if (Math.abs(t - lastT) > 4) P.emit('seeked'); // the video jumped (seek in player or panel)
    lastT = t;
    const idx = P.cueIndexAt(t);
    if (idx !== lastIdx) { lastIdx = idx; P.emit('position', idx, t); }
    requestAnimationFrame(frame);
  }

  // ------------------------------------------------------------------ init
  function init() {
    const tpl = $('#lockTpl');
    document.querySelectorAll('.lock-card').forEach((el) => {
      el.appendChild(tpl.content.cloneNode(true));
      el.querySelector('.lock-title').textContent = el.closest('#view-chat') ? '对话需要 AI 精准模式' : '笔记需要 AI 精准模式';
    });
    document.addEventListener('click', (e) => {
      const g = e.target.closest('[data-goto]');
      if (g) show(g.dataset.goto);
    });
    document.querySelectorAll('.tabs button').forEach((b) => b.addEventListener('click', () => show(b.dataset.tab)));
    $('#enabled').addEventListener('change', (e) => N.saveSettings({ enabled: e.target.checked }));

    TranscriptView.init();
    NotesView.init();
    ChatView.init();

    P.on('state', updateHeader);
    P.on('trans', updateHeader);
    P.on('status', updateHeader);
    P.on('settings', () => { updateHeader(); applyLocks(); });

    let saved = null;
    try { saved = localStorage.getItem('ntusub-tab'); } catch (e) { /* ignore */ }
    show(saved || 'transcript');
    applyLocks();
    updateHeader();
    requestAnimationFrame(frame);
    P.init();
  }

  init();
})();
