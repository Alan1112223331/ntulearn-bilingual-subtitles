// Stand-in for the chrome.* extension APIs so the popup, options page and content
// scripts can be rendered outside the extension (README screenshots, local debugging).
(() => {
  if (window.chrome && window.chrome.runtime && window.chrome.runtime.id) return;
  const params = new URLSearchParams(location.search);
  const mem = {
    settings: {
      provider: 'openai',
      providers: {
        openai: { baseUrl: 'https://api.openai.com/v1', apiKey: 'sk-demo-0000000000000000', model: 'gpt-4o-mini' }
      },
      courseContext: 'EE6406 Analytic & Ensemble Machine Learning：集成学习、Bagging、随机森林、Boosting',
      glossary: 'bagging = 装袋法 (Bagging)\nrandom forest = 随机森林\nbootstrap sample = 自助采样样本\nvariance = 方差',
      display: { mode: params.get('mode') || 'bilingual', showStatus: false }
    },
    cacheIndex: {}
  };
  if (params.get('engine') === 'basic') mem.settings.provider = 'google';
  const changeL = [];
  const msgL = [];
  const clone = (x) => (x === undefined ? x : JSON.parse(JSON.stringify(x)));
  const dict = () => window.__DEMO_TR || {};

  window.chrome = {
    runtime: {
      id: 'demo',
      async sendMessage(msg) {
        if (msg.type === 'ntusub-translate') {
          const t = {};
          msg.lines.forEach((l) => { t[l.id] = dict()[l.text] || ('【译】' + l.text); });
          return { ok: true, translations: t };
        }
        if (msg.type === 'ntusub-cache-stats') return { ok: true, videos: 14, bytes: 3.6 * 1024 * 1024 };
        if (msg.type === 'ntusub-models') {
          await new Promise((r) => setTimeout(r, 300));
          return { ok: true, models: [
            'BAAI/bge-m3', 'BAAI/bge-reranker-v2-m3', 'ByteDance-Seed/Seed-OSS-36B-Instruct', 'FunAudioLLM/CosyVoice2-0.5B',
            'FunAudioLLM/SenseVoiceSmall', 'Qwen/Qwen3-32B', 'Qwen/Qwen3-8B', 'deepseek-ai/DeepSeek-V3.2',
            'claude-haiku-5-5', 'claude-sonnet-5-5', 'gemini-2.5-flash', 'gemini-claude-sonnet-4-6',
            'gpt-4o-mini', 'gpt-4.1-mini', 'text-embedding-3-small', 'tts-1', 'whisper-1'
          ].sort() };
        }
        return { ok: true };
      },
      onMessage: { addListener: (f) => msgL.push(f) },
      openOptionsPage() {}
    },
    storage: {
      local: {
        async get(k) {
          if (k == null) return clone(mem);
          const o = {};
          (Array.isArray(k) ? k : [k]).forEach((x) => { if (x in mem) o[x] = clone(mem[x]); });
          return o;
        },
        async set(o) {
          const ch = {};
          for (const k in o) { ch[k] = { oldValue: mem[k], newValue: clone(o[k]) }; mem[k] = clone(o[k]); }
          changeL.forEach((f) => f(ch, 'local'));
        },
        async remove(k) { (Array.isArray(k) ? k : [k]).forEach((x) => delete mem[x]); },
        async getBytesInUse() { return 0; }
      },
      onChanged: { addListener: (f) => changeL.push(f) }
    },
    tabs: {
      async query() { return [{ id: 1, title: 'EE6406 Week 9' }]; },
      async sendMessage(id, msg) {
        if (msg.type === 'ntusub-status') return { ok: true, source: 'network', total: 2148, done: 1396, running: 2, error: '' };
        return { ok: true };
      }
    },
    permissions: { async request() { return true; } }
  };
  window.__ntusubPopup = (msg) => new Promise((res) => { msgL.forEach((f) => f(msg, {}, res)); setTimeout(res, 50); });
})();
