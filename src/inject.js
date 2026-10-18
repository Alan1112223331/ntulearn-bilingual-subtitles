// Runs in the page's MAIN world at document_start.
// Observes network traffic of the Kaltura player to capture full caption files
// (SRT / WebVTT / DFXP) and caption-asset lists, and forwards them to content.js.
(() => {
  if (window.__ntusubInject) return;
  window.__ntusubInject = true;

  const TAG = '__ntusub';
  const CAP_URL = /caption|subtitle|\.vtt(?:[?#]|$)|\.srt(?:[?#]|$)|\.dfxp|\.ttml/i;
  const API_URL = /\/api_v3\//i;
  const CAP_CT = /vtt|subrip|ttml|dfxp/i;
  const MAX_LEN = 8 * 1024 * 1024;

  const buffer = [];
  const seen = new Set();

  function post(type, data) {
    const msg = Object.assign({ [TAG]: 'inject', type }, data);
    if (type === 'captions' || type === 'captionList') {
      buffer.push(msg);
      if (buffer.length > 30) buffer.shift();
    }
    try { window.postMessage(msg, '*'); } catch (e) { /* ignore */ }
  }

  function abs(url) {
    try { return new URL(url, location.href).href; } catch (e) { return String(url || ''); }
  }

  // Kaltura serves captions as HLS-style WebVTT segments (…/segmentDuration/300/…/segmentIndex/N.vtt)
  // and the player only loads the ones near the playhead. Fetch every segment up front so the
  // whole lecture can be translated ahead of time.
  const prefetchedTracks = new Set();
  const prefetching = new Set();
  const MAX_SEGMENTS = 96;

  function videoDuration() {
    let best = null, area = 0;
    for (const v of document.getElementsByTagName('video')) {
      const a = v.clientWidth * v.clientHeight;
      if (a >= area) { area = a; best = v; }
    }
    return best && Number.isFinite(best.duration) ? best.duration : 0;
  }

  async function prefetchSegments(url) {
    const m = /^(.*\/segmentIndex\/)(\d+)(\.vtt)?([?#].*)?$/i.exec(url);
    if (!m) return;
    const trackKey = m[1];
    if (prefetchedTracks.has(trackKey)) return;
    prefetchedTracks.add(trackKey);
    const segDur = +((/segmentDuration\/(\d+)/i.exec(url) || [])[1] || 0);
    const make = (i) => m[1] + i + (m[3] || '') + (m[4] || '');

    let dur = videoDuration();
    for (let i = 0; i < 20 && !dur; i++) {
      await new Promise((r) => setTimeout(r, 500));
      dur = videoDuration();
    }
    const total = segDur && dur ? Math.min(MAX_SEGMENTS, Math.ceil(dur / segDur)) : MAX_SEGMENTS;
    const queue = [];
    for (let i = 1; i <= total; i++) if (!seen.has(make(i))) queue.push(make(i));
    console.info(`[NTU双语字幕] 预取全部字幕分段：共 ${total} 段，待取 ${queue.length} 段`);

    let stop = false;
    const worker = async () => {
      while (queue.length && !stop) {
        const u = queue.shift();
        prefetching.add(u);
        try {
          const res = await window.fetch(u); // captured by the fetch hook above
          if (!res.ok && !dur) stop = true; // probing without a known duration: stop at the end
        } catch (e) {
          if (!dur) stop = true;
        }
      }
    };
    await Promise.all([worker(), worker(), worker()]);
  }

  function redact(url) {
    return String(url).replace(/(ks[\/=])[^\/&?#]+/gi, '$1…').slice(0, 200);
  }

  function interesting(url, ct) {
    return CAP_URL.test(url) || API_URL.test(url) || CAP_CT.test(ct || '');
  }

  function looksLikeCaption(text) {
    const head = text.slice(0, 4000);
    if (/^﻿?\s*WEBVTT/.test(head)) return true;
    if (/<tt[\s>]/i.test(head)) return true;
    return /-->/.test(head) && /\d{1,2}:\d{2}[.,]\d{1,3}/.test(head);
  }

  function handle(url, text, body, ct) {
    try {
      if (!text || typeof text !== 'string' || text.length > MAX_LEN) return;
      if ((CAP_URL.test(url) || CAP_CT.test(ct || '')) && looksLikeCaption(text)) {
        seen.add(url);
        if (!prefetching.has(url)) console.info('[NTU双语字幕] 截获字幕文件', redact(url), text.length + ' 字符');
        post('captions', { url, text });
        prefetchSegments(url);
      } else if (API_URL.test(url) && text.indexOf('KalturaCaptionAsset') !== -1) {
        console.info('[NTU双语字幕] 截获字幕列表', redact(url));
        post('captionList', { url, text, body: typeof body === 'string' ? body.slice(0, 200000) : '' });
      }
    } catch (e) { /* ignore */ }
  }

  // ---- fetch ----
  const origFetch = window.fetch;
  if (typeof origFetch === 'function') {
    window.fetch = function (input, init) {
      const p = origFetch.apply(this, arguments);
      try {
        const url = abs(typeof input === 'string' ? input : (input && input.url) || String(input));
        const body = init && typeof init.body === 'string' ? init.body : '';
        p.then((res) => {
          try {
            const ct = (res.headers && res.headers.get('content-type')) || '';
            if (!interesting(url, ct)) return;
            res.clone().text().then((t) => handle(url, t, body, ct), () => {});
          } catch (e) { /* ignore */ }
        }, () => {});
      } catch (e) { /* ignore */ }
      return p;
    };
  }

  // ---- XMLHttpRequest ----
  const XHR = window.XMLHttpRequest && window.XMLHttpRequest.prototype;
  if (XHR) {
    const origOpen = XHR.open;
    const origSend = XHR.send;
    XHR.open = function (method, url) {
      try { this.__ntusubUrl = abs(url); } catch (e) { /* ignore */ }
      return origOpen.apply(this, arguments);
    };
    XHR.send = function (body) {
      try {
        const xhr = this;
        const b = typeof body === 'string' ? body : '';
        xhr.addEventListener('load', () => {
          try {
            const url = xhr.__ntusubUrl || xhr.responseURL || '';
            const ct = xhr.getResponseHeader('content-type') || '';
            if (!interesting(url, ct)) return;
            const rt = xhr.responseType;
            let t = '';
            if (!rt || rt === 'text') t = xhr.responseText;
            else if (rt === 'json') t = JSON.stringify(xhr.response);
            else if (rt === 'arraybuffer' && xhr.response) t = new TextDecoder().decode(xhr.response);
            else if (rt === 'blob' && xhr.response) {
              xhr.response.text().then((bt) => handle(url, bt, b, ct), () => {});
              return;
            }
            handle(url, t, b, ct);
          } catch (e) { /* ignore */ }
        });
      } catch (e) { /* ignore */ }
      return origSend.apply(this, arguments);
    };
  }

  // ---- requests from content.js ----
  window.addEventListener('message', (e) => {
    if (e.source !== window || !e.data || e.data[TAG] !== 'content') return;
    const d = e.data;
    if (d.type === 'hello') {
      for (const m of buffer) {
        try { window.postMessage(m, '*'); } catch (err) { /* ignore */ }
      }
    } else if (d.type === 'fetch' && typeof d.url === 'string') {
      // Goes through the hooked fetch, so the result is captured above.
      window.fetch(d.url).catch(() => {});
    } else if (d.type === 'scan') {
      try {
        const entries = performance.getEntriesByType('resource') || [];
        for (const en of entries) {
          const u = en.name;
          if (CAP_URL.test(u) && !seen.has(u) && !/\.m3u8/i.test(u)) {
            seen.add(u);
            window.fetch(u).catch(() => {});
          }
        }
      } catch (err) { /* ignore */ }
    }
  });
})();
