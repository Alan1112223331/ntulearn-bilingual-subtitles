// Minimal, safe Markdown → HTML for model output (chat answers, note bullets).
// Everything is HTML-escaped before formatting is applied; only http(s) links are kept.
// Timestamps such as [12:34] or [1:02:03–1:05:00] become seek buttons.
globalThis.MD = (() => {
  const ESC = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
  const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ESC[c]);
  const TIME = '\\d{1,2}:\\d{2}(?::\\d{2})?';
  const TS = new RegExp(`[\\[［【](${TIME})(?:\\s*[-–~至]\\s*(${TIME}))?[\\]］】]`, 'g');

  const secs = (s) => s.split(':').map(Number).reduce((a, b) => a * 60 + b, 0);

  function inline(text) {
    const codes = [];
    let s = String(text).replace(/`([^`\n]+)`/g, (_, c) => { codes.push(c); return `\u0000${codes.length - 1}\u0000`; });
    s = esc(s)
      .replace(/\*\*([^*\n]+)\*\*/g, '<strong>$1</strong>')
      .replace(/(^|[^*\w])\*([^*\n]+)\*(?![*\w])/g, '$1<em>$2</em>')
      .replace(/\[([^\]\n]+)\]\((https?:\/\/[^)\s]+)\)/g, (m, label, url) =>
        (/&(quot|#39|lt|gt);/.test(url) ? m : `<a href="${url}" target="_blank" rel="noopener noreferrer">${label}</a>`))
      .replace(TS, (m, a, b) => `<button type="button" class="ts" data-t="${secs(a)}">${a}${b ? '–' + b : ''}</button>`);
    return s.replace(/\u0000(\d+)\u0000/g, (_, i) => `<code>${esc(codes[+i])}</code>`);
  }

  const LIST = /^(\s*)([-*+•]|\d+[.)、])\s+(.*)$/;
  const FENCE = /^\s*```/;
  const TABLE_SEP = /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/;

  function render(src) {
    const lines = String(src || '').replace(/\r\n?/g, '\n').split('\n');
    const out = [];
    const lists = []; // open lists: { type, indent }
    let para = [];
    let i = 0;

    const flushPara = () => {
      if (para.length) out.push('<p>' + para.map(inline).join('<br>') + '</p>');
      para = [];
    };
    const closeLists = (toIndent = -1) => {
      while (lists.length && lists[lists.length - 1].indent > toIndent) out.push(`</li></${lists.pop().type}>`);
    };
    const nextNonBlank = (j) => { while (j < lines.length && !lines[j].trim()) j++; return lines[j]; };
    const cells = (l) => l.trim().replace(/^\||\|$/g, '').split('|').map((c) => c.trim());

    while (i < lines.length) {
      const line = lines[i];

      if (FENCE.test(line)) {
        flushPara(); closeLists();
        const buf = [];
        i++;
        while (i < lines.length && !FENCE.test(lines[i])) buf.push(lines[i++]);
        i++;
        out.push(`<pre><code>${esc(buf.join('\n'))}</code></pre>`);
        continue;
      }

      if (!line.trim()) {
        flushPara();
        const next = nextNonBlank(i + 1);
        if (!next || !(LIST.test(next) || (lists.length && /^\s{2,}\S/.test(next)))) closeLists();
        i++;
        continue;
      }

      let m = line.match(/^(#{1,6})\s+(.*)$/);
      if (m) {
        flushPara(); closeLists();
        const level = Math.min(6, m[1].length + 2); // keep headings small in the narrow panel
        out.push(`<h${level}>${inline(m[2])}</h${level}>`);
        i++;
        continue;
      }

      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(line)) {
        flushPara(); closeLists();
        out.push('<hr>');
        i++;
        continue;
      }

      if (/^\s*>/.test(line)) {
        flushPara(); closeLists();
        const buf = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) buf.push(lines[i++].replace(/^\s*>\s?/, ''));
        out.push(`<blockquote>${buf.map(inline).join('<br>')}</blockquote>`);
        continue;
      }

      if (line.includes('|') && i + 1 < lines.length && TABLE_SEP.test(lines[i + 1])) {
        flushPara(); closeLists();
        const head = cells(line);
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes('|') && lines[i].trim()) rows.push(cells(lines[i++]));
        out.push('<div class="tbl"><table><thead><tr>' + head.map((h) => `<th>${inline(h)}</th>`).join('') +
          '</tr></thead><tbody>' + rows.map((r) => '<tr>' + r.map((c) => `<td>${inline(c)}</td>`).join('') + '</tr>').join('') +
          '</tbody></table></div>');
        continue;
      }

      m = line.match(LIST);
      if (m) {
        flushPara();
        const indent = m[1].replace(/\t/g, '  ').length;
        const type = /\d/.test(m[2]) ? 'ol' : 'ul';
        closeLists(indent);
        const top = lists[lists.length - 1];
        if (top && top.indent === indent && top.type === type) {
          out.push('</li><li>');
        } else {
          if (top && top.indent === indent) out.push(`</li></${lists.pop().type}>`);
          out.push(`<${type}><li>`);
          lists.push({ type, indent });
        }
        out.push(inline(m[3]));
        i++;
        continue;
      }

      if (lists.length && /^\s+\S/.test(line)) {
        out.push('<br>' + inline(line.trim())); // continuation of a list item
        i++;
        continue;
      }

      closeLists();
      para.push(line.trim());
      i++;
    }
    flushPara();
    closeLists();
    return out.join('');
  }

  return { render, inline, esc, secs };
})();
