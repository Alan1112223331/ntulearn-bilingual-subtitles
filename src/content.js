// Isolated-world content script. Runs in every NTULearn / Kaltura frame, but only
// becomes active in frames that contain a <video>.
(() => {
  if (window.__ntusubContent) return;
  window.__ntusubContent = true;

  const N = globalThis.NTUSUB;
  const P = globalThis.NTUSUB_PARSERS;
  const TAG = '__ntusub';

  // Player-rendered caption containers (Kaltura v7 PlayKit, Kaltura v2 mwEmbed, video.js).
  const NATIVE_CAPTION_SELECTORS = [
    '.playkit-subtitles',
    '.playkit-captions',
    '.captionsOverlay',
    '.captionContainer',
    '.mwPlayerContainer .track',
    '.vjs-text-track-display'
  ];
  const PLAYER_HOST_SELECTORS = '.playkit-player, .mwPlayerContainer, .kaltura-player-container, .video-js';
  // Live DOM-text translation is the last resort; give full-track sources time to arrive first.
  const DOM_FALLBACK_DELAY = 4000;

  let settings = N.DEFAULTS;
  let settingsReady = false;
  let sig = '';
  let gen = 0;
  let dead = false;

  const S = {
    video: null,
    videoSince: 0,
    videoOff: [],
    ro: null,
    tracks: new Map(),
    active: null,
    trans: new Map(),
    inflight: new Set(),
    fails: new Map(),
    running: 0,
    cacheKey: '',
    cacheLoaded: false,
    halted: false,
    pauseUntil: 0,
    errStreak: 0,
    error: '',
    captionAssets: null,
    entry: null,
    triedScan: false,
    triedAssets: false,
    ttTried: new WeakSet(),
    dom: { text: '', history: [], trans: new Map(), inflight: false, pending: '' },
    ov: null,
    last: { orig: null, tr: null, wait: null }
  };

  // ------------------------------------------------------------------ utils
  const log = (...a) => console.info('[NTU双语字幕]', ...a);
  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

  function alive() {
    if (dead) return false;
    try {
      if (chrome.runtime && chrome.runtime.id) return true;
    } catch (e) { /* context invalidated */ }
    dead = true;
    return false;
  }

  function send(msg) {
    if (!alive()) return Promise.reject(new Error('扩展已重新加载，请刷新页面'));
    return chrome.runtime.sendMessage(msg);
  }

  function postToInject(type, data) {
    window.postMessage(Object.assign({ [TAG]: 'content', type }, data || {}), '*');
  }

  function entryKey() {
    const m = /(?:entry_?id)[=\/]([01]_[a-z0-9]{8})/i.exec(location.href);
    return m ? m[1] : location.host + location.pathname;
  }

  function trackIdFromUrl(url) {
    const m = /captionAssetId[\/=]([^\/&?#]+)/i.exec(url);
    if (m) return 'ca:' + m[1];
    return 'url:' + url.replace(/[?#].*$/, '').replace(/\/segmentIndex\/-?\d+/i, '').replace(/\/ks\/[^\/]+/i, '');
  }

  // --------------------------------------------------------------- settings
  function applySettings(s) {
    const prevSig = sig;
    settings = s;
    sig = N.sigOf(s);
    S.halted = false;
    S.pauseUntil = 0;
    S.errStreak = 0;
    S.error = '';
    const first = !settingsReady;
    settingsReady = true;
    if (first) chooseTrack();
    else if (S.active && prevSig !== sig) activate(S.active);
    updateStyle();
    render();
    pump();
  }

  N.getSettings().then(applySettings).catch(() => applySettings(N.DEFAULTS));
  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.settings && alive()) {
      applySettings(N.merge(N.DEFAULTS, ch.settings.newValue || {}));
    }
  });

  // ----------------------------------------------------- caption ingestion
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data[TAG] !== 'inject') return;
    const d = e.data;
    try {
      if (d.type === 'captions') onCaptionText(d.url, d.text);
      else if (d.type === 'captionList') onCaptionList(d);
      else if (d.type === 'entryInfo') onEntryInfo(d.text);
      else if (d.type === 'segmentsDone') onSegmentsDone(d.url);
    } catch (err) { /* ignore malformed */ }
  });
  postToInject('hello');

  // The lecture's own entry (not the dual-screen child stream) with the longest duration.
  function onEntryInfo(text) {
    let data;
    try { data = JSON.parse(text); } catch (e) { return; }
    let best = null;
    (function walk(o, depth) {
      if (!o || typeof o !== 'object' || depth > 8) return;
      if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return; }
      if (/MediaEntry$/.test(o.objectType || '') && o.id && o.name && !o.parentEntryId) {
        if (!best || (o.duration || 0) > (best.duration || 0)) best = o;
      }
      for (const k in o) if (o[k] && typeof o[k] === 'object') walk(o[k], depth + 1);
    })(data, 0);
    if (!best) return;
    S.entry = { id: best.id, name: String(best.name).slice(0, 200), description: String(best.description || '').slice(0, 1000), duration: best.duration || 0, at: Date.now() };
    sendPanelStateSoon();
  }

  function onCaptionText(url, text) {
    const cues = P.parseCaptions(text);
    if (!cues.length) return;
    const segmented = /segmentIndex\/\d+/i.test(url);
    addTrack({
      id: trackIdFromUrl(url),
      cues,
      source: 'network',
      segmented,
      complete: !segmented // a whole caption file is complete as soon as it arrives
    });
  }

  // All caption segments of a track have been fetched.
  const completedTracks = new Set();
  function onSegmentsDone(url) {
    const id = trackIdFromUrl(url);
    completedTracks.add(id);
    const t = S.tracks.get(id);
    if (t) t.complete = true;
    sendPanelStateSoon();
  }

  function addTrack(t) {
    const old = S.tracks.get(t.id);
    if (old) {
      old.cues = old.segmented || t.segmented || t.source === 'texttrack' ? P.mergeCues(old.cues, t.cues) : t.cues;
      old.receivedAt = Date.now();
      old.sourceLike = P.isSourceLike(old.cues);
      if (t.ref) old.ref = t.ref;
      if (t.complete || completedTracks.has(t.id)) old.complete = true;
    } else {
      t.receivedAt = Date.now();
      t.sourceLike = P.isSourceLike(t.cues);
      if (completedTracks.has(t.id)) t.complete = true;
      S.tracks.set(t.id, t);
    }
    chooseTrack();
    sendPanelStateSoon();
  }

  function onCaptionList(d) {
    let data;
    try { data = JSON.parse(d.text); } catch (e) { return; }
    const assets = [];
    let respKs = '';
    (function walk(o, depth) {
      if (!o || typeof o !== 'object' || depth > 8) return;
      if (Array.isArray(o)) { for (const x of o) walk(x, depth + 1); return; }
      if (o.objectType === 'KalturaCaptionAsset' && o.id) assets.push(o);
      if (!respKs && typeof o.ks === 'string' && o.ks.length > 20 && /Session/i.test(o.objectType || '')) respKs = o.ks;
      for (const k in o) if (o[k] && typeof o[k] === 'object') walk(o[k], depth + 1);
    })(data, 0);
    if (!assets.length) return;

    let ks = '';
    try {
      const body = JSON.parse(d.body || '{}');
      (function findKs(o, depth) {
        if (ks || !o || typeof o !== 'object' || depth > 4) return;
        if (typeof o.ks === 'string' && o.ks.length > 20 && o.ks[0] !== '{') { ks = o.ks; return; }
        for (const k in o) findKs(o[k], depth + 1);
      })(body, 0);
    } catch (e) { /* not JSON */ }
    if (!ks) {
      const m = /[?&\/]ks[=\/]([^&\/?#]+)/.exec(d.url);
      if (m && m[1].length > 20) ks = decodeURIComponent(m[1]);
    }
    ks = ks || respKs;
    const i = d.url.indexOf('/api_v3');
    if (i < 0) return;
    S.captionAssets = { base: d.url.slice(0, i + 7), ks, assets, at: Date.now() };
  }

  // Captions are switched off in the player → fetch the English asset ourselves.
  function fetchFromAssets() {
    S.triedAssets = true;
    const ca = S.captionAssets;
    if (!ca) return;
    const isEn = (a) => /^en/i.test(a.languageCode || '') || /english/i.test(a.language || '') || /english/i.test(a.label || '');
    const ready = ca.assets.filter((a) => a.status === undefined || a.status === 2);
    let pool = ready.filter(isEn);
    if (!pool.length && ready.every((a) => !a.language && !a.languageCode)) pool = ready;
    pool.sort((a, b) => (b.accuracy || 0) - (a.accuracy || 0) || (b.updatedAt || 0) - (a.updatedAt || 0));
    const pick = pool[0];
    if (!pick) return;
    let url = `${ca.base}/service/caption_captionasset/action/serve?captionAssetId=${encodeURIComponent(pick.id)}`;
    if (ca.ks) url += '&ks=' + encodeURIComponent(ca.ks);
    log(`播放器字幕未开启，主动拉取英文字幕 ${pick.id}（${pick.label || pick.language || ''}）`);
    postToInject('fetch', { url });
  }

  function tryTextTracks() {
    const tts = S.video && S.video.textTracks;
    if (!tts) return;
    for (let i = 0; i < tts.length; i++) {
      const tt = tts[i];
      if (tt.kind !== 'subtitles' && tt.kind !== 'captions') continue;
      const lang = (tt.language || '').toLowerCase();
      if (lang && !lang.startsWith('en') && !/english/i.test(tt.label || '')) continue;
      if (tt.mode === 'disabled' && !S.ttTried.has(tt)) {
        S.ttTried.add(tt);
        try { tt.mode = 'hidden'; } catch (e) { /* ignore */ }
        continue;
      }
      if (tt.cues && tt.cues.length) {
        const cues = P.fromTextTrackCues(tt.cues);
        if (cues.length && P.isSourceLike(cues)) {
          addTrack({ id: 'tt:' + entryKey() + ':' + (tt.label || tt.language || i), cues, source: 'texttrack', ref: tt, rawCount: tt.cues.length });
          return;
        }
      }
    }
  }

  function refreshTextTrack() {
    const t = S.active;
    if (!t || !t.ref || !t.ref.cues || t.ref.cues.length === t.rawCount) return;
    t.rawCount = t.ref.cues.length;
    addTrack({ id: t.id, cues: P.fromTextTrackCues(t.ref.cues), source: 'texttrack', ref: t.ref });
  }

  function domCaptionText() {
    for (const sel of NATIVE_CAPTION_SELECTORS) {
      const el = document.querySelector(sel);
      if (el) {
        const tx = P.clean(el.innerText || el.textContent || '');
        if (tx) return tx;
      }
    }
    return '';
  }

  // Last resort: captions only exist as rendered DOM text → translate line by line.
  function domTick() {
    const text = domCaptionText();
    if (text === S.dom.text) return;
    S.dom.text = text;
    if (text) {
      if (!S.dom.history.length) log('未获取到完整字幕文件，使用实时逐句翻译模式');
      S.dom.history.push(text);
      if (S.dom.history.length > 6) S.dom.history.shift();
      if (!S.dom.trans.has(text)) {
        S.dom.pending = text;
        if (!S.dom.inflight) runDomTranslation();
      }
    }
    updateStyle();
    render();
  }

  async function runDomTranslation() {
    S.dom.inflight = true;
    while (S.dom.pending && settings.enabled && !S.halted) {
      const text = S.dom.pending;
      S.dom.pending = '';
      if (S.dom.trans.has(text)) continue;
      try {
        const res = await send({
          type: 'ntusub-translate',
          lines: [{ id: '1', text }],
          before: S.dom.history.slice(0, -1).slice(-3),
          after: [],
          frameTitle: document.title
        });
        if (res && res.ok && res.translations['1']) {
          S.dom.trans.set(text, res.translations['1']);
          S.error = '';
        } else if (res && !res.ok) {
          S.error = res.error;
          if (res.fatal) S.halted = true;
        }
      } catch (e) {
        S.error = e.message;
      }
      render();
    }
    S.dom.inflight = false;
  }

  // ------------------------------------------------------ track selection
  function chooseTrack() {
    if (!settingsReady) return;
    let best = null, bestPri = -1;
    for (const t of S.tracks.values()) {
      if (!t.sourceLike) continue;
      const pri = t.source === 'network' ? 2 : 1;
      if (pri > bestPri || (pri === bestPri && t.receivedAt > best.receivedAt)) {
        best = t;
        bestPri = pri;
      }
    }
    if (best !== S.active) {
      if (best) activate(best);
      else { gen++; S.active = null; updateStyle(); render(); sendPanelStateSoon(); }
    } else if (best) {
      pump();
      render();
    }
  }

  function activate(t) {
    gen++;
    const myGen = gen;
    S.active = t;
    S.trans = new Map();
    S.inflight = new Set();
    S.fails = new Map();
    S.running = 0;
    S.halted = false;
    S.cacheLoaded = false;
    const key = 'c:' + N.hash(sig + '|' + t.id);
    S.cacheKey = key;
    chrome.storage.local.get(key).then((got) => {
      if (myGen !== gen) return;
      const m = got[key] && got[key].m;
      if (m) for (const k in m) if (!S.trans.has(k)) S.trans.set(k, m[k]);
      S.cacheLoaded = true;
      log(`使用字幕轨 ${t.id}（来源 ${t.source}，${t.cues.length} 条，缓存命中 ${S.trans.size} 条）`);
      if (m) send({ type: 'ntusub-cache-touch', key }).catch(() => {});
      render();
      pump();
      sendPanelStateSoon();
    }).catch(() => { S.cacheLoaded = true; pump(); });
    ensureOverlay();
    updateStyle();
    render();
  }

  let saveTimer = 0;
  function saveCacheSoon() {
    clearTimeout(saveTimer);
    const key = S.cacheKey;
    saveTimer = setTimeout(() => {
      if (key !== S.cacheKey || !alive() || !S.trans.size) return;
      const m = Object.fromEntries(S.trans);
      chrome.storage.local.set({ [key]: { m, t: Date.now() } })
        .then(() => send({ type: 'ntusub-cache-touch', key }))
        .catch(() => {});
    }, 1200);
  }

  // ------------------------------------------------------------- scheduler
  function playbackTime() {
    return S.video ? S.video.currentTime + (settings.display.offsetMs || 0) / 1000 : 0;
  }

  // Index of the last cue whose start <= t (or -1).
  function lastStartLE(cues, t) {
    let lo = 0, hi = cues.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (cues[mid].start <= t) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  function currentIndex(cues) {
    const t = playbackTime();
    const i = lastStartLE(cues, t);
    if (i < 0) return 0;
    return cues[i].end >= t ? i : i + 1;
  }

  function needs(c) {
    return !S.trans.has(c.key) && !S.inflight.has(c.key) && (S.fails.get(c.key) || 0) < 3;
  }

  function hasApi() {
    if (N.isBasic(settings)) return true;
    const cfg = settings.providers[settings.provider];
    return cfg && cfg.baseUrl && cfg.model;
  }

  function pump() {
    const t = S.active;
    if (!t || !settingsReady || !settings.enabled || !S.cacheLoaded || S.halted || !alive()) return;
    if (!hasApi()) { S.error = '未配置模型接口，请在扩展设置中填写'; S.halted = true; return; }
    if (Date.now() < S.pauseUntil) return;
    const cues = t.cues;
    const conc = clamp(+settings.concurrency || 3, 1, 10);
    // Basic mode has no prompt overhead and answers fast, so it takes much larger batches.
    const bs = N.isBasic(settings) ? 80 : clamp(+settings.batchSize || 30, 5, 120);
    const cur = currentIndex(cues);
    while (S.running < conc) {
      let start = -1;
      for (let i = Math.max(0, cur - 1); i < cues.length; i++) if (needs(cues[i])) { start = i; break; }
      if (start < 0) for (let i = 0; i < cur; i++) if (needs(cues[i])) { start = i; break; }
      if (start < 0) break;
      // The batch the viewer is waiting on right now is kept small so it returns fast.
      const urgent = start <= cur + 2 && !(cues[cur] && S.trans.has(cues[cur].key));
      const size = urgent ? Math.min(bs, 8) : bs;
      const idxs = [];
      for (let i = start; i < cues.length && idxs.length < size; i++) {
        if (needs(cues[i])) idxs.push(i);
        else break;
      }
      runBatch(t, idxs);
    }
  }

  async function runBatch(t, idxs) {
    const myGen = gen;
    const cues = t.cues;
    const keys = idxs.map((i) => cues[i].key);
    S.running++;
    keys.forEach((k) => S.inflight.add(k));
    const ctxN = clamp(+settings.contextLines || 0, 0, 10);
    const first = idxs[0], last = idxs[idxs.length - 1];
    const lines = idxs.map((i, n) => ({ id: String(n + 1), text: cues[i].text }));
    let wait = 0;
    try {
      const res = await send({
        type: 'ntusub-translate',
        lines,
        before: cues.slice(Math.max(0, first - ctxN), first).map((c) => c.text),
        after: cues.slice(last + 1, last + 1 + ctxN).map((c) => c.text),
        frameTitle: document.title
      });
      if (myGen !== gen) return;
      if (!res || !res.ok) {
        const err = new Error((res && res.error) || '未知错误');
        err.fatal = res && res.fatal;
        throw err;
      }
      keys.forEach((k, n) => {
        const tr = res.translations[String(n + 1)];
        if (tr) S.trans.set(k, tr);
        else S.fails.set(k, (S.fails.get(k) || 0) + 1);
      });
      if (S.error) panelPost({ type: 'status', error: '', halted: false });
      S.error = '';
      S.errStreak = 0;
      saveCacheSoon();
      render();
      sendPanelTrans(keys);
    } catch (e) {
      if (myGen !== gen) return;
      S.error = e.message || String(e);
      console.warn('[NTU双语字幕] 翻译失败：', S.error);
      if (e.fatal) S.halted = true;
      panelPost({ type: 'status', error: S.error, halted: S.halted });
      keys.forEach((k) => S.fails.set(k, (S.fails.get(k) || 0) + 1));
      S.errStreak++;
      wait = Math.min(30000, 1500 * 2 ** (S.errStreak - 1));
      S.pauseUntil = Date.now() + wait;
    } finally {
      if (myGen === gen) {
        keys.forEach((k) => S.inflight.delete(k));
        S.running--;
      }
    }
    if (wait) await sleep(wait);
    if (myGen === gen) pump();
  }

  // --------------------------------------------------------------- overlay
  const OVERLAY_CSS = `
    .wrap { position:absolute; left:0; right:0; bottom:var(--ntusub-bottom,9%);
      display:flex; justify-content:center; pointer-events:none; }
    .box { pointer-events:auto; cursor:grab; max-width:92%; box-sizing:border-box;
      display:flex; flex-direction:column; align-items:center; gap:.12em;
      padding:.22em .7em .28em; border-radius:.35em;
      background:rgba(0,0,0,var(--ntusub-bg,.5)); text-align:center; line-height:1.38;
      font-family:"PingFang SC","Hiragino Sans GB","Microsoft YaHei","Noto Sans CJK SC","Source Han Sans SC",system-ui,-apple-system,"Segoe UI",sans-serif;
      -webkit-font-smoothing:antialiased; user-select:none; -webkit-user-select:none;
      transition:opacity .1s; }
    .box.rev { flex-direction:column-reverse; }
    .box.empty { opacity:0; pointer-events:none; }
    .box.dragging { cursor:grabbing; outline:1px dashed rgba(255,255,255,.6); }
    .line { white-space:pre-line; word-break:break-word; overflow-wrap:anywhere;
      text-shadow:0 0 2px rgba(0,0,0,.95),0 1px 3px rgba(0,0,0,.9); }
    .line:empty { display:none; }
    .tr { font-size:var(--ntusub-fs,22px); color:var(--ntusub-trc,#fff); font-weight:var(--ntusub-fw,600); letter-spacing:.02em; }
    .or { font-size:calc(var(--ntusub-fs,22px) * var(--ntusub-os,.78)); color:var(--ntusub-orc,#d6dde6); font-weight:400; }
    .tr.wait { display:block; min-height:1em; }
    .tr.wait::before { content:"• • •"; font-size:.6em; opacity:.55; letter-spacing:.2em; animation:ntusubBlink 1s ease-in-out infinite; }
    @keyframes ntusubBlink { 50% { opacity:.2; } }
    .status { position:absolute; top:8px; left:8px; max-width:70%;
      font:12px/1.4 system-ui,"Microsoft YaHei",sans-serif; color:#fff;
      background:rgba(20,20,20,.62); padding:3px 9px; border-radius:999px;
      opacity:0; transition:opacity .3s; pointer-events:none;
      white-space:nowrap; overflow:hidden; text-overflow:ellipsis; }
    .status.show { opacity:.9; }
    .status.err { background:rgba(170,35,35,.85); }
  `;

  function findHost(v) {
    return v.closest(PLAYER_HOST_SELECTORS) || v.parentElement;
  }

  function ensureOverlay() {
    const v = S.video;
    if (!v) return;
    if (!S.ov) {
      const root = document.createElement('div');
      root.setAttribute('data-ntusub', 'overlay');
      root.style.cssText = 'position:absolute;left:0;top:0;width:0;height:0;margin:0;padding:0;border:0;pointer-events:none;z-index:2147483000;';
      const sh = root.attachShadow({ mode: 'open' });
      sh.innerHTML = `<style>${OVERLAY_CSS}</style><div class="status"></div><div class="wrap"><div class="box empty"><div class="line tr"></div><div class="line or"></div></div></div>`;
      S.ov = {
        root,
        box: sh.querySelector('.box'),
        tr: sh.querySelector('.tr'),
        or: sh.querySelector('.or'),
        status: sh.querySelector('.status'),
        host: null,
        geo: ''
      };
      setupDrag(S.ov);
    }
    const host = findHost(v);
    if (!host) return;
    if (S.ov.root.parentNode !== host) {
      host.appendChild(S.ov.root);
      S.ov.geo = '';
    }
    S.ov.host = host;
    if (getComputedStyle(host).position === 'static') host.style.position = 'relative';
  }

  function setupDrag(ov) {
    let drag = null;
    const stop = (e) => e.stopPropagation();
    ['click', 'dblclick', 'mousedown', 'mouseup', 'touchstart'].forEach((ev) => ov.box.addEventListener(ev, stop));
    ov.box.addEventListener('pointerdown', (e) => {
      if (e.button !== 0) return;
      e.stopPropagation();
      e.preventDefault();
      ov.box.setPointerCapture(e.pointerId);
      const rr = ov.root.getBoundingClientRect();
      drag = { rr, offset: ov.box.getBoundingClientRect().bottom - e.clientY, pct: null };
      ov.box.classList.add('dragging');
    });
    ov.box.addEventListener('pointermove', (e) => {
      if (!drag) return;
      e.stopPropagation();
      const px = drag.rr.bottom - (e.clientY + drag.offset);
      drag.pct = clamp((px / drag.rr.height) * 100, 0, 90);
      ov.root.style.setProperty('--ntusub-bottom', drag.pct + '%');
    });
    const end = (e) => {
      if (!drag) return;
      e.stopPropagation();
      ov.box.classList.remove('dragging');
      const pct = drag.pct;
      drag = null;
      if (pct != null && alive()) N.saveSettings({ display: { bottom: Math.round(pct * 10) / 10 } }).catch(() => {});
    };
    ov.box.addEventListener('pointerup', end);
    ov.box.addEventListener('pointercancel', end);
  }

  function layout() {
    const v = S.video;
    if (!v) return;
    ensureOverlay();
    const ov = S.ov;
    if (!ov || !ov.host) return;
    const host = ov.host;
    const vr = v.getBoundingClientRect();
    const hr = host.getBoundingClientRect();
    const left = vr.left - hr.left - host.clientLeft + host.scrollLeft;
    const top = vr.top - hr.top - host.clientTop + host.scrollTop;
    // Size text from the actual picture height (object-fit: contain letterboxing).
    let ch = vr.height;
    if (v.videoWidth && v.videoHeight && vr.width && vr.height) {
      ch = Math.min(vr.height, (vr.width * v.videoHeight) / v.videoWidth);
    }
    const fs = clamp(ch * 0.05, 13, 64) * (+settings.display.fontScale || 1);
    const geo = [left, top, vr.width, vr.height, fs].map((x) => Math.round(x * 10) / 10).join(',');
    if (geo === ov.geo) return;
    ov.geo = geo;
    const st = ov.root.style;
    st.left = left + 'px';
    st.top = top + 'px';
    st.width = vr.width + 'px';
    st.height = vr.height + 'px';
    st.setProperty('--ntusub-fs', fs.toFixed(1) + 'px');
  }

  let styleEl = null;
  function ensureGlobalStyle() {
    if (styleEl && styleEl.isConnected) return;
    styleEl = document.createElement('style');
    styleEl.setAttribute('data-ntusub', 'native');
    const hidden = NATIVE_CAPTION_SELECTORS.map((s) => `html.ntusub-hide-native ${s}`).join(',\n');
    styleEl.textContent = `
      html.ntusub-hide-native video::cue { color: transparent !important; background: transparent !important; text-shadow: none !important; }
      ${hidden} { opacity: 0 !important; }
    `;
    (document.head || document.documentElement).appendChild(styleEl);
  }

  function updateStyle() {
    const d = settings.display;
    const showing = settings.enabled && !!S.video && (!!S.active || !!S.dom.text);
    const hide = showing && d.hideNative;
    if (hide) ensureGlobalStyle();
    document.documentElement.classList.toggle('ntusub-hide-native', !!hide);
    if (!S.ov) return;
    const st = S.ov.root.style;
    st.setProperty('--ntusub-bottom', clamp(+d.bottom || 0, 0, 90) + '%');
    st.setProperty('--ntusub-bg', String(clamp(+d.bgOpacity, 0, 1)));
    st.setProperty('--ntusub-trc', d.transColor);
    st.setProperty('--ntusub-orc', d.origColor);
    st.setProperty('--ntusub-os', String(+d.origScale || 0.78));
    st.setProperty('--ntusub-fw', String(d.fontWeight || 600));
    S.ov.box.classList.toggle('rev', d.order === 'orig-top');
    S.ov.geo = '';
    layout();
    S.last = { orig: null, tr: null, wait: null };
  }

  function activeCues(cues, t) {
    const i = lastStartLE(cues, t);
    const out = [];
    for (let j = i; j >= 0 && j > i - 4; j--) {
      if (cues[j].end > t) out.unshift(cues[j]);
    }
    return out;
  }

  function render() {
    if (!S.ov) return;
    let orig = '', tr = '', wait = false;
    if (settings.enabled && S.video) {
      if (S.active) {
        const cs = activeCues(S.active.cues, playbackTime());
        if (cs.length) {
          orig = cs.map((c) => c.text).join('\n');
          const trs = cs.map((c) => S.trans.get(c.key));
          tr = trs.filter(Boolean).join('\n');
          wait = trs.some((x) => !x) && !S.halted;
        }
      } else if (S.dom.text) {
        orig = S.dom.text;
        tr = S.dom.trans.get(orig) || '';
        wait = !tr && !S.halted;
      }
    }
    const mode = settings.display.mode;
    let showTr = tr, showOr = orig, showWait = false;
    if (mode === 'original') { showTr = ''; }
    else if (mode === 'translation') {
      if (tr && !wait) showOr = '';
      else if (!tr) showWait = false; // fall back to the original until translated
    } else {
      showWait = wait && !tr;
    }
    const L = S.last;
    if (L.orig === showOr && L.tr === showTr && L.wait === showWait) return;
    L.orig = showOr; L.tr = showTr; L.wait = showWait;
    S.ov.tr.textContent = showTr;
    S.ov.or.textContent = showOr;
    S.ov.tr.classList.toggle('wait', showWait);
    S.ov.box.classList.toggle('empty', !showTr && !showOr && !showWait);
  }

  function progress() {
    const t = S.active;
    if (!t) return { total: 0, done: 0 };
    let done = 0;
    for (const c of t.cues) if (S.trans.has(c.key)) done++;
    return { total: t.cues.length, done };
  }

  function updateStatus() {
    if (!S.ov) return;
    let text = '', err = false;
    if (settings.enabled && settings.display.showStatus) {
      if (S.error && (S.halted || S.errStreak > 0)) { text = '翻译出错：' + S.error; err = true; }
      else if (S.active && S.cacheLoaded) {
        const { total, done } = progress();
        if (done < total && (S.running > 0 || Date.now() < S.pauseUntil)) text = `${N.isBasic(settings) ? '' : 'AI '}翻译中 ${Math.floor((done / total) * 100)}%`;
      }
    }
    S.ov.status.textContent = text;
    S.ov.status.classList.toggle('show', !!text);
    S.ov.status.classList.toggle('err', err);
  }

  // ----------------------------------------------------------------- video
  let rafId = 0;
  function startLoop() {
    if (rafId) return;
    const tick = () => {
      rafId = 0;
      if (!S.active && settings.enabled && Date.now() - S.videoSince > DOM_FALLBACK_DELAY) domTick();
      render();
      if (S.video && !S.video.paused && !S.video.ended) rafId = requestAnimationFrame(tick);
    };
    rafId = requestAnimationFrame(tick);
  }

  function detachVideo() {
    for (const [ev, fn] of S.videoOff) S.video && S.video.removeEventListener(ev, fn);
    S.videoOff = [];
    if (S.ro) { S.ro.disconnect(); S.ro = null; }
    S.video = null;
  }

  function attachVideo(v) {
    detachVideo();
    log(`检测到视频 ${v.clientWidth}x${v.clientHeight}（${location.host}）`);
    S.video = v;
    S.videoSince = Date.now();
    S.triedScan = false;
    S.triedAssets = false;
    const on = (ev, fn) => { v.addEventListener(ev, fn); S.videoOff.push([ev, fn]); };
    const seek = () => { S.last.orig = null; render(); pump(); };
    on('play', startLoop);
    on('playing', startLoop);
    on('pause', render);
    on('seeking', seek);
    on('seeked', seek);
    on('timeupdate', () => { if (v.paused) render(); });
    on('loadedmetadata', () => { if (S.ov) S.ov.geo = ''; layout(); sendPanelStateSoon(); });
    for (const ev of ['play', 'pause', 'seeked', 'timeupdate', 'ratechange']) on(ev, sendPanelTick);
    on('emptied', onEmptied);
    S.ro = new ResizeObserver(() => layout());
    S.ro.observe(v);
    ensureOverlay();
    updateStyle();
    if (!v.paused) startLoop();
  }

  // A new media source was loaded into the same <video>: forget stale tracks.
  function onEmptied() {
    const cutoff = Date.now() - 8000;
    for (const [id, t] of S.tracks) if (t.receivedAt < cutoff) S.tracks.delete(id);
    if (S.captionAssets && S.captionAssets.at < cutoff) S.captionAssets = null;
    S.videoSince = Date.now();
    S.triedScan = false;
    S.triedAssets = false;
    S.dom.text = '';
    if (S.entry && S.entry.at < cutoff) S.entry = null;
    chooseTrack();
    sendPanelStateSoon();
  }

  function findVideo() {
    const vids = document.getElementsByTagName('video');
    let best = null, area = 0;
    for (const v of vids) {
      const a = v.clientWidth * v.clientHeight;
      if (a > area) { area = a; best = v; }
    }
    if (best && best !== S.video) attachVideo(best);
    else if (S.video && !S.video.isConnected) detachVideo();
  }

  document.addEventListener('fullscreenchange', () => { if (S.ov) S.ov.geo = ''; ensureOverlay(); layout(); });
  window.addEventListener('resize', () => layout());

  const hb = setInterval(() => {
    if (!alive()) {
      clearInterval(hb);
      document.documentElement.classList.remove('ntusub-hide-native');
      if (S.ov) S.ov.root.remove();
      return;
    }
    findVideo();
    if (!S.video) return;
    layout();
    updateStatus();
    if (!settings.enabled) { render(); return; }
    const since = Date.now() - S.videoSince;
    if (!S.active) {
      if (since > 1500 && !S.triedScan) { S.triedScan = true; postToInject('scan'); }
      if (since > 2500) tryTextTracks();
      if (since > 3000 && !S.triedAssets && S.captionAssets) fetchFromAssets();
      if (since > DOM_FALLBACK_DELAY) domTick();
    } else if (S.active.source === 'texttrack') {
      refreshTextTrack();
    }
    pump();
    if (S.video.paused) render();
  }, 300);

  // ------------------------------------------------------------ side panel
  // The side panel pings the tab; a frame that has the video connects a port and streams the
  // transcript, translations and playback position to it, and accepts seek requests.
  let panelPort = null;
  let stateTimer = 0;

  function panelPost(msg) {
    if (!panelPort) return;
    try { panelPort.postMessage(msg); } catch (e) { panelPort = null; }
  }

  function panelConnect() {
    if (panelPort || !S.video || !alive()) return;
    try { panelPort = chrome.runtime.connect({ name: 'ntusub-frame' }); } catch (e) { panelPort = null; return; }
    panelPort.onDisconnect.addListener(() => { void chrome.runtime.lastError; panelPort = null; });
    panelPort.onMessage.addListener(onPanelMessage);
    sendPanelState();
  }

  function panelTick() {
    const v = S.video;
    return { time: playbackTime(), playing: !!v && !v.paused && !v.ended, rate: (v && v.playbackRate) || 1 };
  }

  function sendPanelState() {
    clearTimeout(stateTimer);
    stateTimer = 0;
    if (!panelPort || !S.video) return;
    const t = S.active;
    const trans = {};
    if (t) for (const c of t.cues) { const v = S.trans.get(c.key); if (v) trans[c.key] = v; }
    panelPost({
      type: 'state',
      info: {
        title: (S.entry && S.entry.name) || document.title || '',
        description: (S.entry && S.entry.description) || '',
        trackId: t ? t.id : null,
        source: t ? t.source : (S.dom.text ? 'dom' : null),
        complete: !!(t && t.complete),
        duration: Number.isFinite(S.video.duration) ? S.video.duration : 0,
        error: S.error,
        halted: S.halted
      },
      cues: t ? t.cues.map((c) => [c.start, c.end, c.text, c.key]) : [],
      trans,
      tick: panelTick()
    });
  }

  // Track loading fires many updates in a burst (one per caption segment), so coalesce them.
  function sendPanelStateSoon() {
    if (panelPort && !stateTimer) stateTimer = setTimeout(sendPanelState, 400);
  }

  function sendPanelTick() {
    if (panelPort && S.video) panelPost({ type: 'tick', ...panelTick() });
  }

  function sendPanelTrans(keys) {
    if (!panelPort) return;
    const trans = {};
    for (const k of keys) { const v = S.trans.get(k); if (v) trans[k] = v; }
    panelPost({ type: 'trans', trans });
  }

  function retranslate() {
    if (!S.active) return;
    const t = S.active;
    gen++; // stop in-flight batches from writing old results back
    S.trans = new Map();
    S.dom.trans.clear();
    chrome.storage.local.remove(S.cacheKey).catch(() => {}).finally(() => {
      if (S.active === t) activate(t);
    });
  }

  function onPanelMessage(msg) {
    if (!msg || !S.video) return;
    if (msg.type === 'seek' && Number.isFinite(msg.time)) {
      S.video.currentTime = Math.max(0, msg.time - (settings.display.offsetMs || 0) / 1000);
      if (msg.play && S.video.paused) S.video.play().catch(() => {});
    } else if (msg.type === 'get-state') {
      sendPanelState();
    } else if (msg.type === 'retranslate') {
      retranslate();
    }
  }

  chrome.runtime.onMessage.addListener((msg) => {
    if (msg && msg.type === 'ntusub-panel-ping' && S.video) panelConnect();
  });
})();
