// Test double for the chrome.* APIs used by the content scripts and the side panel.
// test/panel-harness.html hosts a shared "bus" in the top window; the player frame and the
// side-panel frame each load this file and talk to each other through it (ports, tab
// messages, storage), much like the real extension does.
(() => {
  const top = window.top;
  if (!top.__ntusubBus) {
    const mem = {};
    const bus = top.__ntusubBus = {
      mem,
      changeL: [],
      tabMsgL: [], // content-script onMessage listeners
      connectL: [], // extension-page onConnect listeners
      log: [],
      translateDelay: 150,
      fakeTranslate: (t) => '【译】' + t
    };
    bus.clone = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
  }
  const bus = top.__ntusubBus;
  const clone = bus.clone;
  const role = document.documentElement.dataset.role || 'page';

  function makePortPair(name, sender) {
    const a = { name, sender, _l: [], _d: [], _peer: null, _open: true };
    const b = { name, sender, _l: [], _d: [], _peer: null, _open: true };
    a._peer = b; b._peer = a;
    for (const p of [a, b]) {
      p.onMessage = { addListener: (f) => p._l.push(f) };
      p.onDisconnect = { addListener: (f) => p._d.push(f) };
      p.postMessage = (m) => {
        if (!p._open) throw new Error('Attempting to use a disconnected port object');
        const data = clone(m);
        setTimeout(() => p._peer._open && p._peer._l.forEach((f) => f(data, p._peer)), 0);
      };
      p.disconnect = () => {
        if (!p._open) return;
        p._open = false; p._peer._open = false;
        setTimeout(() => p._peer._d.forEach((f) => f(p._peer)), 0);
      };
    }
    return [a, b];
  }

  window.chrome = {
    runtime: {
      id: 'harness',
      lastError: undefined,
      async sendMessage(msg) {
        if (msg.type === 'ntusub-translate') {
          await new Promise((r) => setTimeout(r, bus.translateDelay));
          const t = {};
          msg.lines.forEach((l) => { t[l.id] = bus.fakeTranslate(l.text); });
          return { ok: true, translations: t };
        }
        return { ok: true };
      },
      onMessage: { addListener: (f) => { if (role === 'content') bus.tabMsgL.push(f); } },
      onConnect: { addListener: (f) => bus.connectL.push(f) },
      connect({ name }) {
        const [mine, theirs] = makePortPair(name, { tab: { id: 1, title: 'LTI Launch' }, frameId: 7 });
        bus.log.push('connect:' + name);
        if (!bus.connectL.length) setTimeout(() => mine.disconnect(), 0);
        setTimeout(() => bus.connectL.forEach((f) => f(theirs)), 0);
        return mine;
      },
      openOptionsPage() {}
    },
    tabs: {
      async query() { return [{ id: 1, title: 'LTI Launch' }]; },
      async sendMessage(tabId, msg) {
        if (!bus.tabMsgL.length) throw new Error('Could not establish connection. Receiving end does not exist.');
        bus.tabMsgL.forEach((f) => f(clone(msg), { id: 'panel' }, () => {}));
      },
      onActivated: { addListener() {} },
      onRemoved: { addListener() {} }
    },
    windows: { async getCurrent() { return { id: 1 }; } },
    storage: {
      local: {
        async get(k) {
          if (k == null) return clone(bus.mem);
          const o = {};
          (Array.isArray(k) ? k : [k]).forEach((x) => { if (x in bus.mem) o[x] = clone(bus.mem[x]); });
          return o;
        },
        async set(o) {
          const ch = {};
          for (const k in o) { ch[k] = { oldValue: bus.mem[k], newValue: clone(o[k]) }; bus.mem[k] = clone(o[k]); }
          bus.changeL.forEach((f) => { try { f(clone(ch), 'local'); } catch (e) { /* frame gone */ } });
        },
        async remove(k) { (Array.isArray(k) ? k : [k]).forEach((x) => delete bus.mem[x]); },
        async getBytesInUse() { return JSON.stringify(bus.mem).length; }
      },
      onChanged: { addListener: (f) => bus.changeL.push(f) }
    },
    permissions: { async request() { return true; } }
  };

  // ------------------------------------------------------------ fake LLM
  // Requests to https://fake-llm.test are answered locally: chat streams an SSE reply,
  // note requests get sections built from the transcript lines in the prompt.
  const realFetch = window.fetch.bind(window);
  window.fetch = async (url, init) => {
    if (!String(url).startsWith('https://fake-llm.test')) return realFetch(url, init);
    const body = JSON.parse(init.body);
    const prompt = body.messages.map((m) => m.content).join('\n');
    bus.log.push('llm:' + (body.stream ? 'stream' : 'call'));
    bus.lastLlmBody = body;
    const isNotes = /Split this part into|lecture overview/.test(prompt);
    if (body.stream && !isNotes) {
      const q = body.messages[body.messages.length - 1].content;
      const pos = (q.match(/【我正在看的位置：\[([^\]]+)\]/) || [])[1] || '?';
      const reply = `你现在看到 [${pos}] 附近，老师在讲 **Bagging**：\n\n- 对训练数据做 *bootstrap* 重采样\n- 训练多棵树后取平均，降低方差\n\n可以回看 [0:08] 的例子。\n\n| 方法 | 作用 |\n|---|---|\n| Bagging | 降方差 |\n\n\`\`\`python\nRandomForestClassifier(n_estimators=100)\n\`\`\``;
      const enc = new TextEncoder();
      const parts = reply.match(/[\s\S]{1,12}/g);
      const stream = new ReadableStream({
        async start(ctrl) {
          for (const p of parts) {
            await new Promise((r) => setTimeout(r, 25));
            ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`));
          }
          ctrl.enqueue(enc.encode('data: [DONE]\n\n'));
          ctrl.close();
        }
      });
      return new Response(stream, { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    await new Promise((r) => setTimeout(r, 300));
    let content;
    if (/Split this part into/.test(prompt)) {
      const lines = [...prompt.matchAll(/^\[(\d+:\d{2}(?::\d{2})?)\] (.*)$/gm)];
      const mid = lines[Math.floor(lines.length / 2)] || lines[0];
      const sec = (l, n) => ({
        start: l[1], end: '', title: `知识点 ${n}（${l[1]} 起）`,
        points: [`**要点**：${l[2].slice(0, 60)}`, '第二条解释，包含 `code` 与数字 0.632。'],
        terms: [{ en: 'bootstrap sample', tr: '自助采样样本', note: '有放回抽样得到的数据集' }],
        emphasis: [{ time: l[1], quote: 'This will be in the quiz.', note: '考试重点' }],
        examples: ['例：抽样 100 次约有 63.2% 的样本被选中'], aside: n === 1 ? '补充：随机森林在 Bagging 基础上再随机选特征。' : ''
      });
      content = JSON.stringify({ sections: [sec(lines[0], 1), sec(mid, 2)] });
    } else if (/lecture overview/.test(prompt)) {
      content = JSON.stringify({ title: 'Ensemble Learning: Bagging', summary: '本节介绍 Bagging 与随机森林。', takeaways: ['Bagging 降低方差'], self_check: [{ q: '为什么 Bagging 能降方差？', a: '平均多个**弱相关**模型。' }] });
    } else {
      content = '{}';
    }
    if (body.stream) {
      const enc = new TextEncoder();
      const parts = content.match(/[\s\S]{1,40}/g);
      return new Response(new ReadableStream({
        start(ctrl) {
          parts.forEach((p) => ctrl.enqueue(enc.encode(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`)));
          ctrl.enqueue(enc.encode('data: [DONE]\n\n'));
          ctrl.close();
        }
      }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }
    return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200, headers: { 'content-type': 'application/json' } });
  };
})();
