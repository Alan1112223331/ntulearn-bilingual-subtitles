// 对话 view: ask questions about the lecture. The assistant sees the transcript, the student's
// current playback position and (for long lectures) the generated notes.
globalThis.ChatView = (() => {
  const P = globalThis.Panel;
  const L = globalThis.NTUSUB_LLM;
  const MD = globalThis.MD;
  const $ = (s) => document.querySelector(s);

  const FULL_TRANSCRIPT_CHARS = 160000; // ~40k tokens; longer lectures get excerpts + notes
  const WINDOW_SEC = 90; // transcript around the playhead attached to each question
  const LONG_WINDOW_SEC = 600; // wider window when the full transcript is not in the prompt
  const MAX_TURNS = 16;
  const SUGGESTIONS = [
    '解释一下刚才这段在讲什么',
    '这节课到目前为止讲了哪些重点？',
    '列出这节课的关键术语和含义',
    '根据这节课出 3 道自测题'
  ];

  let list, scroller, input, sendBtn, ctxEl;
  let history = []; // { role, content, at?, error? }
  let key = null;
  let streaming = null; // { ctrl }
  let stickBottom = true;

  // --------------------------------------------------------------- context
  function transcriptForPrompt() {
    const full = P.transcriptText(0, P.S.cues.length, 20);
    return full.length <= FULL_TRANSCRIPT_CHARS ? { full: true, text: full } : { full: false, text: '' };
  }

  function systemPrompt() {
    const s = P.S.settings;
    const lang = s.targetLang || '简体中文';
    const tr = transcriptForPrompt();
    const outline = globalThis.NotesView.outline();
    const parts = [
      'You are a helpful teaching assistant shown next to a university lecture video (Nanyang Technological University) that the student is watching.',
      `Answer in ${lang}. Keep technical terms in English on first use.`,
      '',
      'Guidelines:',
      '- Ground answers in this lecture. When you use something from it, cite the time like [12:34] so the student can jump there.',
      '- "This part", "刚才", "现在" etc. refer to the content around the student\'s current playback position, which is given with each question.',
      '- You may add general knowledge to explain, but make clear what the lecturer said versus your own explanation. If the lecture does not cover something, say so.',
      '- The transcript is machine-generated (speech recognition) and may contain errors; interpret it sensibly.',
      '- Use concise Markdown: short paragraphs, lists, **bold** for key ideas. No LaTeX - write formulas in plain text or `code`.',
      ''
    ];
    const title = P.lectureTitle();
    if (title) parts.push(`Lecture: ${title}`);
    if (P.S.info && P.S.info.description) parts.push(`Description: ${P.S.info.description}`);
    if (s.courseContext && s.courseContext.trim()) parts.push(`Course context: ${s.courseContext.trim()}`);
    if (P.S.info && P.S.info.duration) parts.push(`Lecture length: ${P.fmt(P.S.info.duration)}`);
    if (tr.full) {
      parts.push('', 'Full lecture transcript ([time] text):', tr.text);
    } else {
      parts.push('', 'The lecture is long, so only an excerpt around the student\'s position is attached to each question.');
      if (outline) parts.push('', 'Lecture notes outline (generated from the full transcript):', outline);
    }
    return parts.join('\n');
  }

  function windowText(t, span) {
    const cues = P.S.cues;
    if (!cues.length) return '';
    const from = Math.max(0, P.cueIndexAt(t - span) );
    let to = P.cueIndexAt(t + span) + 1;
    if (to <= from) to = Math.min(cues.length, from + 1);
    return P.transcriptText(from, to, 15);
  }

  function buildMessages() {
    const done = history.filter((m) => !m.error && m.content);
    const recent = done.slice(-MAX_TURNS);
    const msgs = [];
    const longLecture = !transcriptForPrompt().full;
    recent.forEach((m, i) => {
      let content = m.content;
      if (m.role === 'user') {
        const last = i === recent.length - 1;
        const at = Number.isFinite(m.at) ? `[${P.fmt(m.at)}]` : '';
        content = last
          ? `【我正在看的位置：${at || '未知'}】\n这附近的字幕：\n${windowText(m.at || 0, longLecture ? LONG_WINDOW_SEC : WINDOW_SEC)}\n\n我的问题：${m.content}`
          : `【当时位置 ${at}】${m.content}`;
      }
      const prev = msgs[msgs.length - 1];
      if (prev && prev.role === m.role) prev.content += '\n\n' + content; // keep roles alternating
      else msgs.push({ role: m.role, content });
    });
    while (msgs.length && msgs[0].role !== 'user') msgs.shift();
    return msgs;
  }

  // ------------------------------------------------------------- rendering
  function emptyHTML() {
    const st = P.transcriptState();
    if (st.reason === 'novideo') {
      return '<div class="empty"><div class="empty-title">未检测到视频</div><p>在当前标签页打开 Media Gallery 课程视频后，就可以针对这节课提问。</p></div>';
    }
    return '<div class="chat-welcome"><div class="empty-title">问问这节课</div>' +
      '<p>AI 会结合整节课的字幕和你当前看到的位置来回答，引用的时间点可以点击跳转。</p>' +
      `<div class="chips">${SUGGESTIONS.map((s) => `<button type="button" class="chip" data-q="${P.esc(s)}">${P.esc(s)}</button>`).join('')}</div></div>`;
  }

  function msgHTML(m, i) {
    if (m.role === 'user') {
      return `<div class="msg user" data-i="${i}">${Number.isFinite(m.at) ? `<button type="button" class="ts" data-t="${m.at}">@${P.fmt(m.at)}</button>` : ''}` +
        `<div class="bubble">${P.esc(m.content).replace(/\n/g, '<br>')}</div></div>`;
    }
    const busy = streaming && i === history.length - 1;
    return `<div class="msg ai${busy ? ' streaming' : ''}" data-i="${i}"><div class="bubble md">${m.content ? MD.render(m.content) : (busy ? '<span class="thinking">思考中</span>' : '')}` +
      (m.error ? `<p class="err">出错了：${P.esc(m.error)}</p><button type="button" class="btn small" data-act="retry">重试</button>` : '') +
      '</div></div>';
  }

  function renderAll() {
    list.innerHTML = history.length ? history.map(msgHTML).join('') : emptyHTML();
    if (stickBottom) scroller.scrollTop = scroller.scrollHeight;
    updateComposer();
  }

  let rafPending = false;
  function renderLast() {
    if (rafPending) return;
    rafPending = true;
    requestAnimationFrame(() => {
      rafPending = false;
      const i = history.length - 1;
      const el = list.querySelector(`.msg[data-i="${i}"]`);
      if (!el) { renderAll(); return; }
      el.outerHTML = msgHTML(history[i], i);
      if (stickBottom) scroller.scrollTop = scroller.scrollHeight;
    });
  }

  function updateComposer() {
    const ready = P.S.cues.length > 0;
    input.disabled = !ready;
    sendBtn.textContent = streaming ? '停止' : '发送';
    sendBtn.classList.toggle('stop', !!streaming);
    sendBtn.disabled = !streaming && (!ready || !input.value.trim());
    updateCtx();
  }

  function updateCtx() {
    if (!P.S.cues.length) { ctxEl.textContent = P.S.port ? '等待字幕加载…' : '未连接到视频'; return; }
    const tr = transcriptForPrompt();
    ctxEl.innerHTML = `<span class="dot"></span>正在看 <b>${P.fmt(P.currentTime())}</b> · ` +
      (tr.full ? '已载入整节课字幕' : (globalThis.NotesView.hasNotes() ? '课程较长：使用笔记大纲 + 当前片段' : '课程较长：使用当前前后约 10 分钟字幕'));
  }

  // -------------------------------------------------------------- sending
  async function send(text) {
    text = String(text || '').trim();
    if (!text || streaming || !P.S.cues.length || !P.isAI()) return;
    history.push({ role: 'user', content: text, at: P.currentTime() });
    input.value = '';
    autosize();
    await ask();
  }

  async function ask() {
    const reply = { role: 'assistant', content: '' };
    history.push(reply);
    const ctrl = new AbortController();
    streaming = { ctrl };
    stickBottom = true;
    renderAll();
    const { provider, cfg } = P.aiConfig();
    try {
      const messages = buildMessages();
      await L.streamModel(provider, cfg, systemPrompt(), messages, (d, full) => {
        reply.content = full;
        renderLast();
      }, { signal: ctrl.signal, maxTokens: 4096 });
    } catch (e) {
      if (!ctrl.signal.aborted) reply.error = e.message || String(e);
      else if (!reply.content) reply.content = '（已停止）';
    } finally {
      streaming = null;
      renderAll();
      save();
    }
  }

  function retry() {
    if (streaming) return;
    while (history.length && history[history.length - 1].role === 'assistant') history.pop();
    if (history.length) ask();
  }

  async function save() {
    if (!key) return;
    const keep = history.filter((m) => !m.error).slice(-60);
    await P.store.set(key, keep).catch(() => {});
  }

  async function load() {
    if (streaming) streaming.ctrl.abort();
    key = P.lectureKey('h');
    history = key ? (await P.store.get(key)) || [] : [];
    stickBottom = true;
    renderAll();
  }

  function autosize() {
    input.style.height = 'auto';
    input.style.height = Math.min(160, input.scrollHeight) + 'px';
    input.classList.toggle('scroll', input.scrollHeight > 160);
  }

  function init() {
    list = $('#chatList');
    scroller = $('#chatScroll');
    input = $('#chatInput');
    sendBtn = $('#chatSend');
    ctxEl = $('#chatCtx');

    input.addEventListener('input', () => { autosize(); updateComposer(); });
    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); send(input.value); }
    });
    sendBtn.addEventListener('click', () => (streaming ? streaming.ctrl.abort() : send(input.value)));
    scroller.addEventListener('scroll', () => {
      stickBottom = scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < 40;
    });
    list.addEventListener('click', (e) => {
      const t = e.target.closest('.ts');
      if (t) { P.seek(+t.dataset.t); return; }
      const chip = e.target.closest('.chip');
      if (chip) { send(chip.dataset.q); return; }
      if (e.target.closest('[data-act="retry"]')) retry();
    });
    $('#chatClear').addEventListener('click', async () => {
      if (!history.length || !confirm('清空这节课的对话记录？')) return;
      if (streaming) streaming.ctrl.abort();
      history = [];
      if (key) await P.store.remove(key);
      renderAll();
    });

    let lastTrack = null;
    P.on('state', ({ trackChanged }) => {
      const tid = P.S.info && P.S.info.trackId;
      if (trackChanged || tid !== lastTrack) { lastTrack = tid; load(); }
      else updateComposer();
    });
    setInterval(updateCtx, 1000);
    load();
  }

  return { init, onShow: () => { renderAll(); setTimeout(() => input.focus(), 50); } };
})();
