// 译文 view: the whole transcript as readable paragraphs, following playback.
globalThis.TranscriptView = (() => {
  const P = globalThis.Panel;
  const $ = (s) => document.querySelector(s);

  let body, scroller, followerCtl;
  let mode = 'both';
  let zh = [], en = [], paraOf = [], paraEls = [], keyIdx = new Map();
  let activeIdx = -1, activePara = -1;
  let builtFor = '';

  // Paragraphs break at pauses and sentence ends, and never run on too long.
  function paragraphs(cues) {
    const out = [];
    let cur = null;
    for (const c of cues) {
      const prev = cur && cur.cues[cur.cues.length - 1];
      const dur = cur ? c.start - cur.start : 0;
      const sentenceEnd = prev && /[.?!。？！]["')\]]?$/.test(prev.text);
      if (!cur || c.start - prev.end > 2.5 || (sentenceEnd && (cur.cues.length >= 5 || dur > 40)) ||
          cur.cues.length >= 12 || dur > 90) {
        cur = { start: c.start, cues: [] };
        out.push(cur);
      }
      cur.cues.push(c);
    }
    return out;
  }

  function emptyHTML() {
    const ts = P.transcriptState();
    const msg = {
      novideo: ['未检测到视频', '在当前标签页打开 NTULearn Media Gallery 的课程视频，译文会在这里逐段显示。'],
      dom: ['实时模式', '这个视频没有可下载的完整字幕，只能在视频上逐句显示，暂不支持整段译文。'],
      waiting: ['等待字幕…', '已检测到视频，正在获取字幕。若长时间没有反应，请在播放器里打开一次 CC。']
    }[ts.reason] || ['等待字幕…', ''];
    return `<div class="empty"><div class="empty-title">${msg[0]}</div><p>${msg[1]}</p></div>`;
  }

  function rebuild() {
    const S = P.S;
    zh = []; en = []; paraOf = []; paraEls = []; keyIdx = new Map();
    activeIdx = -1; activePara = -1;
    if (!S.cues.length) {
      body.innerHTML = emptyHTML();
      builtFor = '';
      return;
    }
    const paras = paragraphs(S.cues);
    const esc = P.esc;
    body.innerHTML = paras.map((p, pi) => {
      const zhSpans = p.cues.map((c) => {
        const tr = S.trans.get(c.key);
        return `<span class="cue${tr ? '' : ' pending'}" data-i="${c.i}">${tr ? esc(tr) : ''}</span>`;
      }).join('');
      const enSpans = p.cues.map((c) => `<span class="cue" data-i="${c.i}">${esc(c.text)} </span>`).join('');
      return `<div class="para" data-p="${pi}"><button type="button" class="ts" data-t="${p.start}">${P.fmt(p.start)}</button>` +
        `<div class="pt"><p class="zh">${zhSpans}</p><p class="en">${enSpans}</p></div></div>`;
    }).join('');
    body.querySelectorAll('.zh .cue').forEach((el) => { zh[+el.dataset.i] = el; });
    body.querySelectorAll('.en .cue').forEach((el) => { en[+el.dataset.i] = el; });
    paraEls = [...body.querySelectorAll('.para')];
    paras.forEach((p, pi) => p.cues.forEach((c) => { paraOf[c.i] = pi; }));
    S.cues.forEach((c) => keyIdx.set(c.key, c.i));
    builtFor = (S.info && S.info.trackId) + ':' + S.cues.length;
    position(P.cueIndexAt(P.currentTime()), true);
  }

  function updateTrans(keys) {
    for (const k of keys) {
      const i = keyIdx.get(k);
      const el = i != null && zh[i];
      if (!el) continue;
      el.textContent = P.S.trans.get(k);
      el.classList.remove('pending');
    }
  }

  function position(idx, jump) {
    if (idx === activeIdx && !jump) return;
    if (zh[activeIdx]) zh[activeIdx].classList.remove('on');
    if (en[activeIdx]) en[activeIdx].classList.remove('on');
    activeIdx = idx;
    if (idx < 0) return;
    if (zh[idx]) zh[idx].classList.add('on');
    if (en[idx]) en[idx].classList.add('on');
    const pi = paraOf[idx];
    if (pi !== activePara || jump) {
      if (paraEls[activePara]) paraEls[activePara].classList.remove('cur');
      activePara = pi;
      if (paraEls[pi]) {
        paraEls[pi].classList.add('cur');
        if (jump) followerCtl.jump(paraEls[pi]); else followerCtl.follow(paraEls[pi]);
      }
    }
  }

  function setMode(m) {
    mode = m;
    body.dataset.mode = m;
    document.querySelectorAll('#trMode button').forEach((b) => b.classList.toggle('on', b.dataset.v === m));
    try { localStorage.setItem('ntusub-tr-mode', m); } catch (e) { /* ignore */ }
  }

  // ----------------------------------------------------------------- export
  function srtTime(t) {
    const ms = Math.max(0, Math.round(t * 1000));
    const p = (n, w) => String(n).padStart(w, '0');
    return `${p(Math.floor(ms / 3600000), 2)}:${p(Math.floor(ms / 60000) % 60, 2)}:${p(Math.floor(ms / 1000) % 60, 2)},${p(ms % 1000, 3)}`;
  }

  function exportAs(fmt) {
    const S = P.S;
    if (!S.cues.length) return;
    const name = P.safeName(P.lectureTitle() || 'lecture');
    if (fmt === 'srt') {
      const origTop = S.settings.display.order === 'orig-top';
      const blocks = S.cues.map((c, i) => {
        const tr = S.trans.get(c.key);
        const lines = origTop ? [c.text, tr] : [tr, c.text];
        return `${i + 1}\n${srtTime(c.start)} --> ${srtTime(c.end)}\n${lines.filter(Boolean).join('\n')}\n`;
      });
      P.download(name + '.bilingual.srt', '﻿' + blocks.join('\n'), 'application/x-subrip');
    } else {
      const text = paragraphs(S.cues).map((p) => {
        const tr = p.cues.map((c) => S.trans.get(c.key) || '').join('');
        const src = p.cues.map((c) => c.text).join(' ');
        return `[${P.fmt(p.start)}]\n${tr ? tr + '\n' : ''}${src}\n`;
      }).join('\n');
      const head = `${P.lectureTitle() || '课堂文稿'}\n（自动字幕及其翻译，可能存在识别错误；仅供个人学习使用）\n\n`;
      P.download(name + '.transcript.txt', '﻿' + head + text, 'text/plain');
    }
  }

  function init() {
    body = $('#trBody');
    scroller = $('#trScroll');
    followerCtl = P.follower(scroller, $('#trBack'), { align: 'center' });
    let saved = 'both';
    try { saved = localStorage.getItem('ntusub-tr-mode') || 'both'; } catch (e) { /* ignore */ }
    setMode(saved);
    document.querySelectorAll('#trMode button').forEach((b) => b.addEventListener('click', () => setMode(b.dataset.v)));

    body.addEventListener('click', (e) => {
      const ts = e.target.closest('.ts');
      if (ts) { P.seek(+ts.dataset.t); return; }
      const cue = e.target.closest('.cue');
      if (cue && P.S.cues[+cue.dataset.i]) P.seek(P.S.cues[+cue.dataset.i].start);
    });

    $('#trRetranslate').addEventListener('click', () => {
      if (!P.S.cues.length) return;
      if (confirm('清除这节课已缓存的译文并重新翻译？（AI 模式会重新消耗 API 额度）')) P.post({ type: 'retranslate' });
    });
    const menu = $('#trExportMenu');
    $('#trExport').addEventListener('click', (e) => { e.stopPropagation(); menu.hidden = !menu.hidden; });
    menu.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-fmt]');
      if (b) { menu.hidden = true; exportAs(b.dataset.fmt); }
    });
    document.addEventListener('click', () => { menu.hidden = true; });

    P.on('state', ({ trackChanged }) => {
      const key = (P.S.info && P.S.info.trackId) + ':' + P.S.cues.length;
      if (trackChanged || key !== builtFor) rebuild();
      else updateTrans([...P.S.trans.keys()]);
    });
    P.on('trans', updateTrans);
    P.on('position', (idx) => position(idx, false));
    P.on('seeked', () => position(P.cueIndexAt(P.currentTime()), true));
    rebuild();
  }

  return { init, onShow: () => position(P.cueIndexAt(P.currentTime()), true) };
})();
