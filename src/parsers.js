// Caption parsers: SRT, WebVTT, TTML/DFXP, native TextTrack cues.
// Output cue shape: { start, end, text, key }
globalThis.NTUSUB_PARSERS = (() => {
  const ENT = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

  function decodeEntities(s) {
    return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
      if (e[0] === '#') {
        const n = e[1].toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
        return Number.isFinite(n) ? String.fromCodePoint(n) : m;
      }
      const k = e.toLowerCase();
      return k in ENT ? ENT[k] : m;
    });
  }

  function clean(s) {
    return decodeEntities(String(s || '')
      .replace(/<br\s*\/?>/gi, ' ')
      .replace(/<[^>]*>/g, '')
      .replace(/\{\\[^}]*\}/g, ''))
      .replace(/[ \t ]+/g, ' ')
      .replace(/\s*\n\s*/g, ' ')
      .trim();
  }

  function parseClock(s) {
    const parts = s.trim().replace(',', '.').split(':');
    let sec = 0;
    for (const p of parts) sec = sec * 60 + parseFloat(p);
    return sec;
  }

  const TIME = /((?:\d+:)?\d{1,2}:\d{1,2}[.,]\d{1,3})\s*-->\s*((?:\d+:)?\d{1,2}:\d{1,2}[.,]\d{1,3})/;

  function parseSrtVtt(text) {
    const lines = text.replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    for (let i = 0; i < lines.length; i++) {
      const m = TIME.exec(lines[i]);
      if (!m) continue;
      const start = parseClock(m[1]);
      const end = parseClock(m[2]);
      const buf = [];
      let j = i + 1;
      for (; j < lines.length; j++) {
        const L = lines[j];
        if (!L.trim()) break;
        if (TIME.test(L)) { j--; break; }
        if (/^\d+$/.test(L.trim()) && j + 1 < lines.length && TIME.test(lines[j + 1])) break;
        buf.push(L);
      }
      i = j;
      const t = clean(buf.join('\n'));
      if (t) out.push({ start, end, text: t });
    }
    return out;
  }

  function parseTtmlTime(v, fps, tickRate) {
    if (!v) return NaN;
    v = v.trim();
    let m = /^(\d+):(\d{2}):(\d{2}(?:\.\d+)?)$/.exec(v);
    if (m) return +m[1] * 3600 + +m[2] * 60 + parseFloat(m[3]);
    m = /^(\d+):(\d{2}):(\d{2}):(\d+(?:\.\d+)?)$/.exec(v);
    if (m) return +m[1] * 3600 + +m[2] * 60 + +m[3] + parseFloat(m[4]) / fps;
    m = /^(\d+(?:\.\d+)?)(h|m|s|ms|f|t)$/.exec(v);
    if (m) {
      const n = parseFloat(m[1]);
      switch (m[2]) {
        case 'h': return n * 3600;
        case 'm': return n * 60;
        case 's': return n;
        case 'ms': return n / 1000;
        case 'f': return n / fps;
        case 't': return n / tickRate;
      }
    }
    if (/^\d+(?:\.\d+)?$/.test(v)) return parseFloat(v);
    return NaN;
  }

  function nodeText(node) {
    let s = '';
    for (const c of node.childNodes) {
      if (c.nodeType === 3) s += c.nodeValue;
      else if (c.nodeType === 1) s += c.localName === 'br' ? ' ' : nodeText(c);
    }
    return s;
  }

  function parseTtml(text) {
    const doc = new DOMParser().parseFromString(text, 'application/xml');
    if (doc.getElementsByTagName('parsererror').length) return [];
    const root = doc.documentElement;
    const fps = parseFloat(root.getAttribute('ttp:frameRate')) || 30;
    const tickRate = parseFloat(root.getAttribute('ttp:tickRate')) || 10000000;
    let ps = doc.getElementsByTagNameNS('*', 'p');
    if (!ps.length) ps = doc.getElementsByTagName('p');
    const out = [];
    for (const p of ps) {
      const start = parseTtmlTime(p.getAttribute('begin'), fps, tickRate);
      let end = parseTtmlTime(p.getAttribute('end'), fps, tickRate);
      if (!Number.isFinite(end)) {
        const dur = parseTtmlTime(p.getAttribute('dur'), fps, tickRate);
        if (Number.isFinite(dur)) end = start + dur;
      }
      const t = clean(nodeText(p));
      if (Number.isFinite(start) && t) out.push({ start, end, text: t });
    }
    return out;
  }

  function cueKey(c) {
    return globalThis.NTUSUB.hash(Math.round(c.start * 10) + '|' + c.text);
  }

  function normalize(cues) {
    const list = cues
      .filter((c) => c && c.text && Number.isFinite(c.start))
      .sort((a, b) => a.start - b.start || a.end - b.end);
    const out = [];
    for (let i = 0; i < list.length; i++) {
      const c = { start: list[i].start, end: list[i].end, text: list[i].text };
      if (!Number.isFinite(c.end) || c.end <= c.start) {
        const next = list[i + 1];
        c.end = next && next.start > c.start ? next.start : c.start + 3;
      }
      const prev = out[out.length - 1];
      if (prev && prev.text === c.text && c.start <= prev.end + 0.05) {
        prev.end = Math.max(prev.end, c.end); // merge duplicated / rolling cues
        continue;
      }
      out.push(c);
    }
    for (const c of out) c.key = cueKey(c);
    return out;
  }

  function parseCaptions(text) {
    text = String(text || '').replace(/^﻿/, '');
    if (/^\s*</.test(text) && /<tt[\s>]/i.test(text.slice(0, 4000))) return normalize(parseTtml(text));
    return normalize(parseSrtVtt(text));
  }

  function fromTextTrackCues(cueList) {
    const arr = [];
    for (let i = 0; i < cueList.length; i++) {
      const c = cueList[i];
      arr.push({ start: c.startTime, end: c.endTime, text: clean(c.text || '') });
    }
    return normalize(arr);
  }

  function mergeCues(a, b) {
    const map = new Map();
    for (const c of a) map.set(c.key, c);
    for (const c of b) if (!map.has(c.key)) map.set(c.key, c);
    return Array.from(map.values()).sort((x, y) => x.start - y.start);
  }

  // True when the track is not mostly CJK text (i.e. a source track worth translating).
  function isSourceLike(cues) {
    let latin = 0, cjk = 0;
    const step = Math.max(1, Math.floor(cues.length / 60));
    for (let i = 0; i < cues.length; i += step) {
      const t = cues[i].text;
      latin += (t.match(/[A-Za-z]/g) || []).length;
      cjk += (t.match(/[぀-ヿ㐀-鿿가-힯]/g) || []).length;
    }
    return latin > 0 && latin >= cjk * 2;
  }

  return { parseCaptions, fromTextTrackCues, mergeCues, isSourceLike, clean, cueKey };
})();
