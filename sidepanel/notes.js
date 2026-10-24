// 笔记 view: AI study notes generated from the lecture transcript, organised by knowledge
// point with timestamps, highlighted and scrolled to follow the video.
globalThis.NotesView = (() => {
  const P = globalThis.Panel;
  const N = globalThis.NTUSUB;
  const L = globalThis.NTUSUB_LLM;
  const MD = globalThis.MD;
  const $ = (s) => document.querySelector(s);

  const NOTES_VERSION = 1;
  // ~6 minutes of lecture per request keeps each reply well inside the output-token limit.
  const CHUNK_SEC = 360;
  const CHUNK_MAX_SEC = 480;
  const CHUNK_WORDS = 1500;
  const MAX_TOKENS = 8192;
  const CONCURRENCY = 3;

  let body, scroller, followerCtl;
  let visible = false;
  let data = null; // { v, sig, lang, model, chunks: { [ci]: sections[] }, overview, createdAt }
  let chunks = [];
  let storeKey = null;
  let job = null; // { ctrl }
  const running = new Set();
  const failed = new Map();
  let overviewState = ''; // '' | 'running' | error message
  let secEls = [];
  let activeSec = -1;

  // ------------------------------------------------------------- chunking
  function makeChunks(cues) {
    const out = [];
    let from = 0, words = 0;
    for (let i = 0; i < cues.length; i++) {
      words += cues[i].text.split(/\s+/).length;
      const dur = cues[i].end - cues[from].start;
      const next = cues[i + 1];
      const boundary = !next || next.start - cues[i].end > 1.2 || /[.?!]$/.test(cues[i].text);
      if (!next || ((dur >= CHUNK_SEC || words >= CHUNK_WORDS) && boundary) || dur >= CHUNK_MAX_SEC) {
        out.push({ from, to: i + 1, start: cues[from].start, end: cues[i].end });
        from = i + 1;
        words = 0;
      }
    }
    return out;
  }

  // --------------------------------------------------------------- prompts
  function systemPrompt() {
    const s = P.S.settings;
    const lang = s.targetLang || '简体中文';
    return [
      `You turn a university lecture's auto-generated transcript into clear study notes for students. Write everything in ${lang}; keep technical terms in English on first use, e.g. "反向传播 (backpropagation)".`,
      '',
      'Principles:',
      '- Faithful: only write what the lecture actually covers. The transcript comes from speech recognition and may contain errors - fix obvious ones silently, never invent content. Background knowledge the lecturer did not say goes only into "aside".',
      '- Teach, do not just list: every point is a complete, self-contained explanation (what it is, why / how it works, conditions, pitfalls), not a vague phrase. Keep the lecturer\'s examples, numbers and formulas (plain text or `code`, no LaTeX).',
      '- Traceable: sections and emphasis items carry the transcript timestamps where they are discussed.',
      '- Skip greetings, small talk and logistics, unless they concern exams, assessments, deadlines or what will be tested - those go into "emphasis".',
      s.courseContext && s.courseContext.trim() ? `\nCourse context: ${s.courseContext.trim()}` : '',
      s.glossary && s.glossary.trim() ? `\nGlossary (use these translations):\n${s.glossary.trim()}` : '',
      '',
      'Output JSON only, without markdown fences.'
    ].join('\n');
  }

  function chunkPrompt(ci) {
    const c = chunks[ci];
    const prev = ci > 0 && data.chunks[ci - 1];
    const prevTitle = prev && prev.length ? prev[prev.length - 1].title : '';
    const title = P.lectureTitle();
    return [
      title ? `Lecture: ${title}` : '',
      `This is part ${ci + 1} of ${chunks.length} (${P.fmt(c.start)}-${P.fmt(c.end)}).` + (prevTitle ? ` The previous part ended with the topic "${prevTitle}".` : ''),
      'Split this part into 1-4 sections, one per knowledge point the lecturer actually discusses, in time order. Sections must not overlap and together should cover this part.',
      '',
      'Return:',
      '{"sections":[{"start":"h:mm:ss","end":"h:mm:ss","title":"short, specific topic title",' +
        '"points":["complete explanatory bullet; Markdown **bold** and `code` allowed"],' +
        '"terms":[{"en":"English term","tr":"translation","note":"one-line meaning"}],' +
        '"emphasis":[{"time":"h:mm:ss","quote":"what the lecturer said, short and translated","note":"why it matters / exam hint"}],' +
        '"examples":["worked example with the numbers used in class"],' +
        '"aside":"optional short background explanation not said in the lecture"}]}',
      'Use [] or "" for empty fields. Timestamps must come from the transcript. Keep each point to 1-3 sentences and each section to about 3-6 points.',
      '',
      'Transcript:',
      P.transcriptText(c.from, c.to, 15)
    ].filter((x) => x !== '').join('\n');
  }

  function overviewPrompt() {
    const lang = P.S.settings.targetLang || '简体中文';
    const outline = allSections().map((s) => `## [${P.fmt(s.start)}] ${s.title}\n${s.points.map((p) => '- ' + p).join('\n')}` +
      (s.emphasis.length ? '\n' + s.emphasis.map((e) => `- (emphasis) ${e.quote} ${e.note}`).join('\n') : '')).join('\n\n');
    return `Below are the study-note sections of one lecture. Write the lecture overview in ${lang}. Return JSON only:\n` +
      '{"title":"concise lecture title","summary":"3-5 sentences: what the lecture covers and how the topics connect",' +
      '"takeaways":["key conclusion"],"self_check":[{"q":"a question that needs reasoning or applying the ideas","a":"answer with the reasoning and the common mistake"}]}\n' +
      `3-6 takeaways, 3-5 self_check questions.\n\nSections:\n${outline}`;
  }

  // ------------------------------------------------------------ generation
  const str = (v) => (typeof v === 'string' ? v.trim() : '');
  const arr = (v) => (Array.isArray(v) ? v : []);

  function normalizeSections(list, c) {
    const out = arr(list).map((s) => {
      let start = P.parseTime(s && s.start);
      if (!Number.isFinite(start) || start < c.start - 5 || start > c.end) start = c.start;
      return {
        start: Math.max(c.start, start),
        title: str(s && s.title) || '（未命名）',
        points: arr(s && s.points).map(str).filter(Boolean),
        terms: arr(s && s.terms).map((t) => ({ en: str(t && t.en), tr: str(t && (t.tr || t.zh)), note: str(t && t.note) })).filter((t) => t.en || t.tr),
        emphasis: arr(s && s.emphasis).map((e) => {
          const t = P.parseTime(e && e.time);
          return { time: Number.isFinite(t) ? t : null, quote: str(e && e.quote), note: str(e && e.note) };
        }).filter((e) => e.quote || e.note),
        examples: arr(s && s.examples).map(str).filter(Boolean),
        aside: str(s && s.aside)
      };
    }).filter((s) => s.points.length || s.title !== '（未命名）');
    out.sort((a, b) => a.start - b.start);
    out.forEach((s, i) => { s.end = i + 1 < out.length ? out[i + 1].start : c.end; });
    if (out.length) out[0].start = c.start; // the first section owns the start of the part
    return out;
  }

  // Streaming keeps slow providers alive (no total timeout, only an idle one) and lets the
  // placeholder card show live progress.
  const progress = new Map();
  function showProgress(ci, chars) {
    progress.set(ci, chars);
    const el = body && body.querySelector(`.sec.placeholder[data-ci="${ci}"] .prog`);
    if (el) el.textContent = `已生成 ${chars} 字`;
  }

  // A reply cut off by the output limit still holds complete sections before the cut.
  function salvageSections(raw) {
    const s = String(raw || '');
    const i = s.indexOf('[', s.indexOf('"sections"'));
    if (i < 0) return null;
    const body = s.slice(i);
    let end = body.lastIndexOf('}');
    for (let tries = 0; end > 0 && tries < 200; tries++) {
      try {
        const arr = JSON.parse(body.slice(0, end + 1) + ']');
        if (Array.isArray(arr) && arr.length) return arr;
      } catch (e) { /* keep cutting */ }
      end = body.lastIndexOf('}', end - 1);
    }
    return null;
  }

  async function genChunk(ci, signal) {
    const { provider, cfg } = P.aiConfig();
    let partial = null;
    for (let attempt = 0; attempt < 2; attempt++) {
      const raw = await L.streamModel(provider, cfg, systemPrompt(), chunkPrompt(ci),
        (d, full) => showProgress(ci, full.length), { json: true, signal, maxTokens: MAX_TOKENS });
      const j = L.extractJson(raw);
      const list = j && (Array.isArray(j) ? j : j.sections);
      if (Array.isArray(list)) {
        const secs = normalizeSections(list, chunks[ci]);
        if (secs.length) return secs;
      }
      // Invalid or cut-off JSON: retry once, and keep the complete sections as a fallback.
      const salvaged = salvageSections(raw);
      if (salvaged && (!partial || salvaged.length > partial.length)) partial = salvaged;
      console.warn('[NTU双语字幕] 笔记输出无法完整解析，' + (attempt ? '使用可解析的部分' : '重试'), raw.slice(-200));
    }
    if (partial) {
      const secs = normalizeSections(partial, chunks[ci]);
      if (secs.length) return secs;
    }
    throw new Error('模型输出无法解析为笔记');
  }

  async function genOverview(signal) {
    const { provider, cfg } = P.aiConfig();
    const raw = await L.streamModel(provider, cfg, systemPrompt(), overviewPrompt(), () => {}, { json: true, signal, maxTokens: MAX_TOKENS });
    const j = L.extractJson(raw) || {};
    return {
      title: str(j.title),
      summary: str(j.summary),
      takeaways: arr(j.takeaways).map(str).filter(Boolean),
      selfCheck: arr(j.self_check || j.selfCheck).map((q) => ({ q: str(q && q.q), a: str(q && q.a) })).filter((q) => q.q)
    };
  }

  function allSections() {
    const out = [];
    chunks.forEach((c, ci) => { if (data && data.chunks[ci]) out.push(...data.chunks[ci]); });
    return out;
  }

  const complete = () => !!data && chunks.length > 0 && chunks.every((c, ci) => data.chunks[ci]);

  async function loadForLecture() {
    cancelJob();
    data = null;
    chunks = [];
    failed.clear();
    overviewState = '';
    storeKey = null;
    const st = P.transcriptState();
    if (!st.ready || !P.isAI()) { render(); return; }
    chunks = makeChunks(P.S.cues);
    const lang = P.S.settings.targetLang;
    storeKey = P.lectureKey('n') + ':' + N.hash(lang);
    const sig = N.hash(chunks.map((c) => c.from + '-' + c.to).join(','));
    const saved = await P.store.get(storeKey);
    data = saved && saved.v === NOTES_VERSION && saved.sig === sig ? saved
      : { v: NOTES_VERSION, sig, lang, model: P.aiConfig().cfg.model, chunks: {}, overview: null, createdAt: Date.now() };
    render();
    if (visible) generate();
  }

  function cancelJob() {
    if (job) job.ctrl.abort();
    job = null;
    running.clear();
  }

  async function generate() {
    if (job || !data || !P.isAI() || (complete() && data.overview)) return;
    const ctrl = new AbortController();
    const myJob = { ctrl };
    job = myJob;
    failed.clear();
    const key = storeKey;
    data.model = P.aiConfig().cfg.model;
    // Start with the part being watched, then continue forward, then fill in earlier parts.
    const now = P.currentTime();
    let cur = chunks.findIndex((c) => now < c.end);
    if (cur < 0) cur = 0;
    const order = chunks.map((c, ci) => ci).sort((a, b) => (a < cur) - (b < cur) || (a < cur ? b - a : a - b));
    const todo = order.filter((ci) => !data.chunks[ci]);
    const worker = async () => {
      while (todo.length && !ctrl.signal.aborted) {
        const ci = todo.shift();
        running.add(ci);
        progress.delete(ci);
        render();
        try {
          const secs = await genChunk(ci, ctrl.signal);
          if (ctrl.signal.aborted) return;
          data.chunks[ci] = secs;
          await P.store.set(key, data);
        } catch (e) {
          if (ctrl.signal.aborted) return;
          failed.set(ci, e.message || String(e));
          if (e.fatal) { todo.length = 0; }
        } finally {
          running.delete(ci);
          if (!ctrl.signal.aborted) render();
        }
      }
    };
    await Promise.all(Array.from({ length: CONCURRENCY }, worker));
    if (!ctrl.signal.aborted && complete() && !data.overview) {
      overviewState = 'running';
      render();
      try {
        data.overview = await genOverview(ctrl.signal);
        overviewState = '';
        await P.store.set(key, data);
      } catch (e) {
        if (!ctrl.signal.aborted) overviewState = e.message || String(e);
      }
    }
    if (job === myJob) job = null;
    if (!ctrl.signal.aborted) render();
  }

  async function regenerate() {
    if (!data) return;
    if (!confirm('重新生成整节课的笔记？已有笔记会被替换，并重新消耗 API 额度。')) return;
    cancelJob();
    data = { ...data, chunks: {}, overview: null, createdAt: Date.now(), model: P.aiConfig().cfg.model };
    overviewState = '';
    await P.store.remove(storeKey);
    render();
    generate();
  }

  // ------------------------------------------------------------- rendering
  const ts = (t, label) => `<button type="button" class="ts" data-t="${t}">${label || P.fmt(t)}</button>`;

  function sectionHTML(s) {
    const md = MD.inline;
    let h = `<article class="sec" data-s="${s.start}" data-e="${s.end}">` +
      `<header>${ts(s.start, `${P.fmt(s.start)}–${P.fmt(s.end)}`)}<h3>${md(s.title)}</h3></header>`;
    if (s.points.length) h += `<ul class="points">${s.points.map((p) => `<li>${md(p)}</li>`).join('')}</ul>`;
    if (s.examples.length) h += `<div class="blk ex"><h4>例子</h4><ul>${s.examples.map((e) => `<li>${md(e)}</li>`).join('')}</ul></div>`;
    if (s.emphasis.length) {
      h += `<div class="blk emph"><h4>老师强调</h4><ul>${s.emphasis.map((e) =>
        `<li>${e.time != null ? ts(e.time) : ''}${e.quote ? `<q>${md(e.quote)}</q>` : ''}${e.note ? ` <span class="note">${md(e.note)}</span>` : ''}</li>`).join('')}</ul></div>`;
    }
    if (s.terms.length) {
      h += `<div class="blk terms"><h4>术语</h4><dl>${s.terms.map((t) =>
        `<div><dt><b>${P.esc(t.en)}</b>${t.tr ? ` · ${P.esc(t.tr)}` : ''}</dt>${t.note ? `<dd>${md(t.note)}</dd>` : ''}</div>`).join('')}</dl></div>`;
    }
    if (s.aside) h += `<div class="blk aside"><h4>补充说明 <small>非课堂原话</small></h4><p>${md(s.aside)}</p></div>`;
    return h + '</article>';
  }

  function emptyHTML(st) {
    const msg = {
      novideo: ['未检测到视频', '在当前标签页打开 Media Gallery 课程视频后，会根据整节课字幕自动生成笔记。'],
      dom: ['无法生成笔记', '这个视频没有可下载的完整字幕（实时模式），无法生成整节课笔记。'],
      waiting: ['等待字幕…', '正在获取这节课的字幕。'],
      loading: ['正在加载完整字幕…', `已获取 ${st.count || 0} 条，全部加载后自动开始生成笔记。`],
      settling: ['正在加载完整字幕…', `已获取 ${st.count || 0} 条，全部加载后自动开始生成笔记。`]
    }[st.reason] || ['准备中…', ''];
    return `<div class="empty"><div class="empty-title">${msg[0]}</div><p>${msg[1]}</p></div>`;
  }

  function render() {
    if (!body) return;
    secEls = [];
    activeSec = -1;
    const st = P.transcriptState();
    if (!data) { body.innerHTML = emptyHTML(st); return; }

    const done = chunks.filter((c, ci) => data.chunks[ci]).length;
    const busy = !!job;
    let status;
    if (busy && done < chunks.length) status = `生成中 ${done}/${chunks.length} 段…`;
    else if (overviewState === 'running') status = '正在生成概览与自测题…';
    else if (failed.size) status = `${failed.size} 段生成失败`;
    else if (complete()) status = `已生成 · ${data.model || ''}`;
    else status = `已生成 ${done}/${chunks.length} 段`;

    const ov = data.overview;
    let h = `<div class="notes-head"><div class="nh-text"><div class="nh-title">${MD.inline((ov && ov.title) || P.lectureTitle() || '课堂笔记')}</div>` +
      `<div class="nh-meta${failed.size ? ' err' : ''}">${P.esc(status)}</div></div><div class="nh-actions">` +
      (!busy && !complete() && done < chunks.length ? '<button type="button" class="btn small primary" data-act="continue">继续生成</button>' : '') +
      `<div class="menu-wrap"><button type="button" class="btn small" data-act="export"${done ? '' : ' disabled'}>导出</button>` +
      '<div class="menu" id="notesExportMenu" hidden><button type="button" data-fmt="md">Markdown (.md)</button><button type="button" data-fmt="html">网页 (.html)</button></div></div>' +
      `<button type="button" class="icon-btn" data-act="regen" title="重新生成"${busy ? ' disabled' : ''}>↻</button></div></div>`;

    if (ov && (ov.summary || ov.takeaways.length)) {
      h += `<article class="overview"><h3>本节概览</h3>${ov.summary ? `<p>${MD.inline(ov.summary)}</p>` : ''}` +
        (ov.takeaways.length ? `<ul>${ov.takeaways.map((t) => `<li>${MD.inline(t)}</li>`).join('')}</ul>` : '') + '</article>';
    }

    chunks.forEach((c, ci) => {
      const secs = data.chunks[ci];
      if (secs) { h += secs.map(sectionHTML).join(''); return; }
      const range = `${P.fmt(c.start)}–${P.fmt(c.end)}`;
      if (failed.has(ci)) {
        h += `<article class="sec placeholder failed" data-s="${c.start}" data-e="${c.end}"><header>${ts(c.start, range)}<h3>这一段生成失败</h3></header>` +
          `<p class="err">${P.esc(failed.get(ci))}</p><button type="button" class="btn small" data-act="continue">重试</button></article>`;
      } else {
        const prog = running.has(ci) && progress.get(ci) ? `已生成 ${progress.get(ci)} 字` : '';
        h += `<article class="sec placeholder${running.has(ci) ? ' running' : ''}" data-ci="${ci}" data-s="${c.start}" data-e="${c.end}"><header>${ts(c.start, range)}` +
          `<h3>${running.has(ci) ? '正在整理这一段…' : '等待生成'}</h3><span class="prog">${prog}</span></header><div class="skeleton"><i></i><i></i><i></i></div></article>`;
      }
    });

    if (ov && ov.selfCheck.length) {
      h += `<article class="selfcheck"><h3>自测题</h3>${ov.selfCheck.map((q, i) =>
        `<details><summary><b>${i + 1}.</b> ${MD.inline(q.q)}</summary><div class="ans">${MD.render(q.a)}</div></details>`).join('')}</article>`;
    } else if (overviewState && overviewState !== 'running') {
      h += `<p class="err small">概览生成失败：${P.esc(overviewState)}</p>`;
    }
    h += '<p class="disclaimer">笔记由 AI 根据课堂自动字幕生成，可能存在识别或理解错误，请以课件和老师原话为准。</p>';

    const top = scroller.scrollTop;
    body.innerHTML = h;
    scroller.scrollTop = top;
    secEls = [...body.querySelectorAll('.sec')];
    position(P.currentTime(), false);
  }

  function position(t, jump) {
    let idx = -1;
    for (let i = 0; i < secEls.length; i++) {
      if (+secEls[i].dataset.s <= t + 0.5) idx = i; else break;
    }
    if (idx === activeSec && !jump) return;
    if (secEls[activeSec]) secEls[activeSec].classList.remove('active');
    activeSec = idx;
    body.classList.toggle('has-active', idx >= 0);
    if (idx < 0) return;
    secEls[idx].classList.add('active');
    if (jump) followerCtl.jump(secEls[idx]); else followerCtl.follow(secEls[idx]);
  }

  // ---------------------------------------------------------------- export
  function toMarkdown() {
    const ov = data.overview;
    const title = (ov && ov.title) || P.lectureTitle() || '课堂笔记';
    const L2 = [`# ${title}`, '', `> 由「NTU 双语字幕」根据课堂自动字幕生成（模型：${data.model || '未知'}，${new Date(data.createdAt).toLocaleDateString()}）。可能存在识别或理解错误，请以课件和老师原话为准。`, ''];
    if (ov) {
      L2.push('## 本节概览', '', ov.summary, '');
      ov.takeaways.forEach((t) => L2.push(`- ${t}`));
      L2.push('');
    }
    for (const s of allSections()) {
      L2.push(`## [${P.fmt(s.start)}–${P.fmt(s.end)}] ${s.title}`, '');
      s.points.forEach((p) => L2.push(`- ${p}`));
      if (s.examples.length) { L2.push('', '**例子**', ''); s.examples.forEach((e) => L2.push(`- ${e}`)); }
      if (s.emphasis.length) {
        L2.push('', '**老师强调**', '');
        s.emphasis.forEach((e) => L2.push(`- ${e.time != null ? `[${P.fmt(e.time)}] ` : ''}${e.quote ? `“${e.quote}”` : ''}${e.note ? ` — ${e.note}` : ''}`));
      }
      if (s.terms.length) {
        L2.push('', '**术语**', '');
        s.terms.forEach((t) => L2.push(`- **${t.en}**${t.tr ? `（${t.tr}）` : ''}${t.note ? `：${t.note}` : ''}`));
      }
      if (s.aside) L2.push('', `> 补充说明（非课堂原话）：${s.aside}`);
      L2.push('');
    }
    if (ov && ov.selfCheck.length) {
      L2.push('## 自测题', '');
      ov.selfCheck.forEach((q, i) => L2.push(`${i + 1}. ${q.q}`, `   - 参考答案：${q.a.replace(/\n+/g, ' ')}`));
    }
    return L2.join('\n');
  }

  function toHTML(md) {
    const title = P.esc((data.overview && data.overview.title) || P.lectureTitle() || '课堂笔记');
    const content = MD.render(md).replace(/<button type="button" class="ts" data-t="[\d.]+">([^<]*)<\/button>/g, '<span class="ts">$1</span>');
    return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>${title}</title><style>
body{max-width:820px;margin:40px auto;padding:0 20px;font:16px/1.75 system-ui,-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;color:#1d2330;background:#fff}
h3{font-size:1.6rem;margin:0 0 .6em}h4{font-size:1.2rem;margin:2em 0 .5em;padding-top:.8em;border-top:1px solid #e4e7ee}h5{font-size:1rem}
.ts{display:inline-block;font:600 .8em ui-monospace,Consolas,monospace;color:#c8102e;background:#fdecef;border-radius:6px;padding:0 6px;margin-right:4px}
blockquote{margin:1em 0;padding:.6em 1em;border-left:4px solid #c8102e;background:#f7f8fb;color:#4a5263}code{background:#f1f3f7;padding:1px 5px;border-radius:4px}
pre{background:#15202e;color:#eef3fb;padding:12px;border-radius:8px;overflow:auto}table{border-collapse:collapse}th,td{border:1px solid #dde2ea;padding:6px 10px}
@media print{body{margin:0}}
</style></head><body>${content}</body></html>`;
  }

  function exportAs(fmt) {
    if (!data) return;
    const name = P.safeName((data.overview && data.overview.title) || P.lectureTitle() || '课堂笔记');
    const md = toMarkdown();
    if (fmt === 'md') P.download(name + '.notes.md', md, 'text/markdown');
    else P.download(name + '.notes.html', toHTML(md), 'text/html');
  }

  // Compact outline for the chat assistant (used for long lectures).
  function outline() {
    if (!data) return '';
    return allSections().map((s) => `[${P.fmt(s.start)}] ${s.title}: ${s.points.join(' ')}`).join('\n');
  }

  function init() {
    body = $('#notesBody');
    scroller = $('#notesScroll');
    followerCtl = P.follower(scroller, $('#notesBack'), {
      align: 'start',
      topInset: () => { const h = body.querySelector('.notes-head'); return h ? h.offsetHeight : 0; }
    });

    body.addEventListener('click', (e) => {
      const t = e.target.closest('.ts');
      if (t) { P.seek(+t.dataset.t); return; }
      const act = e.target.closest('[data-act]');
      if (act) {
        const a = act.dataset.act;
        if (a === 'continue') generate();
        else if (a === 'regen') regenerate();
        else if (a === 'export') { e.stopPropagation(); const m = $('#notesExportMenu'); m.hidden = !m.hidden; }
        return;
      }
      const f = e.target.closest('#notesExportMenu button[data-fmt]');
      if (f) { $('#notesExportMenu').hidden = true; exportAs(f.dataset.fmt); }
    });
    document.addEventListener('click', () => { const m = $('#notesExportMenu'); if (m) m.hidden = true; });

    let lastKey = '';
    const refresh = () => {
      const st = P.transcriptState();
      const key = st.ready && P.isAI() ? `${P.S.info.trackId}|${P.S.cues.length}|${P.S.settings.targetLang}` : '';
      if (key !== lastKey) { lastKey = key; loadForLecture(); }
      else if (!data) render();
    };
    P.on('state', refresh);
    P.on('settings', refresh);
    // The transcript only counts as ready once it has been stable for a moment.
    setInterval(() => { if (!data && P.S.cues.length) refresh(); }, 1000);
    P.on('position', () => position(P.currentTime(), false));
    P.on('seeked', () => position(P.currentTime(), true));
    refresh();
  }

  return {
    init,
    outline,
    hasNotes: () => !!data && allSections().length > 0,
    onShow() {
      visible = true;
      if (data && !job && !complete() && !failed.size) generate();
      position(P.currentTime(), true);
    },
    onHide() { visible = false; }
  };
})();
