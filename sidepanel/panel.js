// Side panel core: finds the video frame of the active tab, mirrors its transcript,
// translations and playback position, and offers helpers shared by the views.
globalThis.Panel = (() => {
  const N = globalThis.NTUSUB;

  const listeners = {};
  const on = (ev, fn) => { (listeners[ev] = listeners[ev] || []).push(fn); };
  const emit = (ev, ...args) => (listeners[ev] || []).forEach((fn) => {
    try { fn(...args); } catch (e) { console.error('[NTU双语字幕]', ev, e); }
  });

  const S = {
    settings: N.DEFAULTS,
    windowId: null,
    tabId: null,
    port: null,
    info: null, // { title, description, trackId, source, duration, error, halted }
    cues: [], // [{ i, start, end, text, key }]
    trans: new Map(), // cue key -> translation
    tick: { time: 0, playing: false, rate: 1, at: 0 },
    stateAt: 0,
    cuesChangedAt: 0
  };
  const ports = new Map(); // tabId -> port of the frame that has the video

  // ------------------------------------------------------------- formatting
  const pad = (n) => String(n).padStart(2, '0');
  function fmt(sec) {
    sec = Math.max(0, Math.floor(sec || 0));
    const h = Math.floor(sec / 3600), m = Math.floor(sec / 60) % 60, s = sec % 60;
    return h ? `${h}:${pad(m)}:${pad(s)}` : `${m}:${pad(s)}`;
  }
  function parseTime(v) {
    if (typeof v === 'number') return v;
    const m = /^\s*(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(String(v || ''));
    if (!m) return NaN;
    return m[3] != null ? +m[1] * 3600 + +m[2] * 60 + +m[3] : +m[1] * 60 + +m[2];
  }
  const esc = (s) => globalThis.MD.esc(s);

  // --------------------------------------------------------------- settings
  const isAI = () => {
    const s = S.settings;
    const cfg = s.providers[s.provider];
    return N.AI_PROVIDERS.includes(s.provider) && !!(cfg && cfg.baseUrl && cfg.model);
  };
  const aiConfig = () => ({ provider: S.settings.provider, cfg: S.settings.providers[S.settings.provider] });

  chrome.storage.onChanged.addListener((ch, area) => {
    if (area === 'local' && ch.settings) {
      S.settings = N.merge(N.DEFAULTS, ch.settings.newValue || {});
      emit('settings');
    }
  });

  // ----------------------------------------------------------- connection
  function resetLecture() {
    S.info = null;
    S.cues = [];
    S.trans = new Map();
    S.tick = { time: 0, playing: false, rate: 1, at: performance.now() };
    S.stateAt = 0;
    S.cuesChangedAt = 0;
  }

  function setTab(tabId) {
    if (tabId === S.tabId) return;
    S.tabId = tabId;
    S.port = ports.get(tabId) || null;
    resetLecture();
    emit('state', { trackChanged: true });
    if (S.port) post({ type: 'get-state' });
    else ping();
  }

  function ping() {
    if (S.tabId == null || S.port) return;
    chrome.tabs.sendMessage(S.tabId, { type: 'ntusub-panel-ping' }).catch(() => {});
  }

  function post(msg) {
    if (!S.port) return false;
    try { S.port.postMessage(msg); return true; } catch (e) { return false; }
  }

  function onFrameMessage(msg) {
    if (!msg) return;
    if (msg.type === 'state') {
      const prevTrack = S.info && S.info.trackId;
      const prevCount = S.cues.length;
      S.info = msg.info;
      S.cues = msg.cues.map(([start, end, text, key], i) => ({ i, start, end, text, key }));
      S.trans = new Map(Object.entries(msg.trans || {}));
      setTick(msg.tick);
      S.stateAt = Date.now();
      const trackChanged = prevTrack !== msg.info.trackId;
      if (trackChanged || prevCount !== S.cues.length) S.cuesChangedAt = Date.now();
      emit('state', { trackChanged });
    } else if (msg.type === 'trans') {
      const keys = Object.keys(msg.trans || {});
      for (const k of keys) S.trans.set(k, msg.trans[k]);
      emit('trans', keys);
    } else if (msg.type === 'tick') {
      setTick(msg);
      emit('tick');
    } else if (msg.type === 'status') {
      if (S.info) { S.info.error = msg.error; S.info.halted = msg.halted; }
      emit('status');
    }
  }

  function setTick(t) {
    if (!t) return;
    S.tick = { time: t.time || 0, playing: !!t.playing, rate: t.rate || 1, at: performance.now() };
  }

  chrome.runtime.onConnect.addListener((port) => {
    if (port.name !== 'ntusub-frame' || !port.sender || !port.sender.tab) return;
    const tid = port.sender.tab.id;
    ports.set(tid, port);
    port.onMessage.addListener((msg) => { if (S.port === port) onFrameMessage(msg); });
    port.onDisconnect.addListener(() => {
      if (ports.get(tid) === port) ports.delete(tid);
      if (S.port === port) {
        S.port = null;
        resetLecture();
        emit('state', { trackChanged: true });
      }
    });
    if (tid === S.tabId) {
      S.port = port;
      port.postMessage({ type: 'get-state' });
    }
  });

  async function init() {
    S.settings = await N.getSettings();
    try {
      const win = await chrome.windows.getCurrent();
      S.windowId = win.id;
    } catch (e) { /* popup fallback */ }
    const [tab] = await chrome.tabs.query(S.windowId != null ? { active: true, windowId: S.windowId } : { active: true, lastFocusedWindow: true });
    if (tab) setTab(tab.id);
    chrome.tabs.onActivated.addListener(({ tabId, windowId }) => {
      if (S.windowId == null || windowId === S.windowId) setTab(tabId);
    });
    chrome.tabs.onRemoved.addListener((tabId) => ports.delete(tabId));
    setInterval(ping, 1500);
    emit('settings');
  }

  // --------------------------------------------------------------- timing
  function currentTime() {
    const t = S.tick;
    return t.playing ? t.time + ((performance.now() - t.at) / 1000) * t.rate : t.time;
  }

  // Index of the cue being spoken at time t (the last cue that has started), or -1.
  function cueIndexAt(t) {
    const c = S.cues;
    let lo = 0, hi = c.length - 1, ans = -1;
    while (lo <= hi) {
      const mid = (lo + hi) >> 1;
      if (c[mid].start <= t + 0.05) { ans = mid; lo = mid + 1; } else hi = mid - 1;
    }
    return ans;
  }

  function seek(time, play = false) {
    post({ type: 'seek', time, play });
    S.tick = { ...S.tick, time, at: performance.now() };
    emit('tick');
  }

  // Ready for whole-lecture AI features: transcript fully loaded and stable.
  function transcriptState() {
    const info = S.info;
    if (!S.port) return { ready: false, reason: 'novideo' };
    if (!info || !S.cues.length) return { ready: false, reason: info && info.source === 'dom' ? 'dom' : 'waiting' };
    // The frame reports when every caption segment has been fetched. Sources without that
    // signal (e.g. a player text track) count as complete once they stop growing for a while.
    // Do not compare with the video length: recordings often run on silently after class.
    const quietMs = Date.now() - S.cuesChangedAt;
    const ready = info.complete ? quietMs > 1500 : quietMs > 15000;
    return { ready, reason: info.complete ? 'settling' : 'loading', count: S.cues.length };
  }

  // Transcript grouped into lines of ~`groupSec` seconds, each prefixed with its timestamp.
  function transcriptText(from = 0, to = S.cues.length, groupSec = 20) {
    const out = [];
    let cur = null;
    for (let i = from; i < to; i++) {
      const c = S.cues[i];
      if (!cur || c.start - cur.start >= groupSec) {
        if (cur) out.push(`[${fmt(cur.start)}] ${cur.text.join(' ')}`);
        cur = { start: c.start, text: [] };
      }
      cur.text.push(c.text);
    }
    if (cur) out.push(`[${fmt(cur.start)}] ${cur.text.join(' ')}`);
    return out.join('\n');
  }

  function lectureTitle() {
    const t = S.info && S.info.title;
    return t && !/^(LTI Launch|Media Gallery|Kaltura)$/i.test(t) ? t : '';
  }

  // ---------------------------------------------------------------- storage
  const store = {
    async get(key) { return (await chrome.storage.local.get(key))[key]; },
    async set(key, value) {
      await chrome.storage.local.set({ [key]: value });
      chrome.runtime.sendMessage({ type: 'ntusub-cache-touch', key }).catch(() => {});
    },
    remove: (key) => chrome.storage.local.remove(key)
  };
  const lectureKey = (prefix) => (S.info && S.info.trackId ? prefix + ':' + N.hash(S.info.trackId) : null);

  // ------------------------------------------------------------------- misc
  function download(filename, text, type) {
    const url = URL.createObjectURL(new Blob([text], { type: type + ';charset=utf-8' }));
    const a = Object.assign(document.createElement('a'), { href: url, download: filename });
    document.body.appendChild(a);
    a.click();
    a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
  }
  const safeName = (s) => String(s || 'lecture').replace(/[\\/:*?"<>|]+/g, '_').trim().slice(0, 80) || 'lecture';

  // Auto-scroll that backs off while the user scrolls by hand, with a "back to now" button.
  function follower(scroller, button, { align = 'center', pauseMs = 8000, topInset = () => 0 } = {}) {
    let pausedUntil = 0;
    let auto = false;
    let autoTimer = 0;
    let target = null;
    const userScrolled = () => {
      if (auto) return;
      pausedUntil = Date.now() + pauseMs;
      if (target) button.hidden = false;
    };
    ['wheel', 'touchmove', 'mousedown', 'keydown'].forEach((ev) => scroller.addEventListener(ev, userScrolled, { passive: true }));
    button.addEventListener('click', () => { pausedUntil = 0; button.hidden = true; go(target, true); });
    function go(el, force) {
      target = el;
      if (!el || !el.isConnected) return;
      if (!force && Date.now() < pausedUntil) { button.hidden = false; return; }
      button.hidden = true;
      const sr = scroller.getBoundingClientRect();
      const r = el.getBoundingClientRect();
      const offset = align === 'center' ? (sr.height - Math.min(r.height, sr.height)) / 2 : topInset() + 10;
      const top = scroller.scrollTop + (r.top - sr.top) - offset;
      if (Math.abs(top - scroller.scrollTop) < 4) return;
      auto = true;
      clearTimeout(autoTimer);
      scroller.scrollTo({ top, behavior: force || Math.abs(top - scroller.scrollTop) < sr.height * 2 ? 'smooth' : 'auto' });
      autoTimer = setTimeout(() => { auto = false; }, 900);
    }
    return { follow: (el) => go(el, false), jump: (el) => go(el, true), reset: () => { pausedUntil = 0; button.hidden = true; } };
  }

  return {
    S, on, emit, init, fmt, parseTime, esc, isAI, aiConfig, currentTime, cueIndexAt, seek, post,
    transcriptState, transcriptText, lectureTitle, store, lectureKey, download, safeName, follower
  };
})();
