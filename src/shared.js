// Shared by background, content scripts, popup and options page.
globalThis.NTUSUB = (() => {
  const PROMPT_VERSION = 1;

  // 'google' = basic mode (free Google Translate, no configuration);
  // 'openai' | 'anthropic' | 'gemini' = AI mode with a user-configured model.
  const BASIC_PROVIDER = 'google';
  const AI_PROVIDERS = ['openai', 'anthropic', 'gemini'];

  const DEFAULTS = {
    enabled: true,
    provider: BASIC_PROVIDER,
    aiProvider: 'openai', // last AI format the user picked, restored when switching back to AI mode
    providers: {
      openai: {
        baseUrl: 'https://api.openai.com/v1',
        apiKey: '',
        model: '',
        temperature: '',
        extraHeaders: '',
        extraBody: ''
      },
      anthropic: {
        baseUrl: 'https://api.anthropic.com',
        apiKey: '',
        model: '',
        temperature: '',
        extraHeaders: '',
        extraBody: ''
      },
      gemini: {
        baseUrl: 'https://generativelanguage.googleapis.com/v1beta',
        apiKey: '',
        model: '',
        temperature: '',
        extraHeaders: '',
        extraBody: ''
      }
    },
    targetLang: '简体中文',
    courseContext: '',
    glossary: '',
    keepTerms: false,
    batchSize: 30,
    concurrency: 3,
    contextLines: 4,
    display: {
      mode: 'bilingual', // bilingual | translation | original
      order: 'trans-top', // trans-top | orig-top
      fontScale: 1,
      origScale: 0.78,
      fontWeight: 600,
      transColor: '#ffffff',
      origColor: '#d6dde6',
      bgOpacity: 0.72,
      bottom: 9, // % of video height
      hideNative: true,
      showStatus: true,
      offsetMs: 0
    }
  };

  const PROVIDER_LABELS = {
    google: '基础模式 · Google 翻译',
    openai: 'OpenAI 格式',
    anthropic: 'Anthropic 格式',
    gemini: 'Gemini 格式'
  };

  const isObj = (v) => v && typeof v === 'object' && !Array.isArray(v);

  function merge(base, over) {
    if (!isObj(base)) return over === undefined ? base : over;
    const out = { ...base };
    if (!isObj(over)) return out;
    for (const k of Object.keys(over)) {
      if (over[k] === undefined) continue;
      out[k] = isObj(base[k]) && isObj(over[k]) ? merge(base[k], over[k]) : over[k];
    }
    return out;
  }

  // cyrb53 – fast, well distributed 53-bit string hash.
  function hash(str) {
    let h1 = 0xdeadbeef, h2 = 0x41c6ce57;
    for (let i = 0; i < str.length; i++) {
      const ch = str.charCodeAt(i);
      h1 = Math.imul(h1 ^ ch, 2654435761);
      h2 = Math.imul(h2 ^ ch, 1597334677);
    }
    h1 = Math.imul(h1 ^ (h1 >>> 16), 2246822507) ^ Math.imul(h2 ^ (h2 >>> 13), 3266489909);
    h2 = Math.imul(h2 ^ (h2 >>> 16), 2246822507) ^ Math.imul(h1 ^ (h1 >>> 13), 3266489909);
    return (4294967296 * (2097151 & h2) + (h1 >>> 0)).toString(36);
  }

  async function getSettings() {
    const { settings } = await chrome.storage.local.get('settings');
    return merge(DEFAULTS, settings || {});
  }

  async function saveSettings(patch) {
    const { settings } = await chrome.storage.local.get('settings');
    const next = merge(settings || {}, patch);
    await chrome.storage.local.set({ settings: next });
    return merge(DEFAULTS, next);
  }

  const isBasic = (s) => s.provider === BASIC_PROVIDER;

  // Target-language names offered in the options page → Google Translate codes.
  const GOOGLE_LANGS = {
    '简体中文': 'zh-CN', '繁體中文': 'zh-TW', '日本語': 'ja', '한국어': 'ko',
    'Bahasa Melayu': 'ms', 'Bahasa Indonesia': 'id', 'Tiếng Việt': 'vi', 'ภาษาไทย': 'th',
    'हिन्दी': 'hi', 'Español': 'es', 'Français': 'fr', 'Deutsch': 'de', 'Русский': 'ru'
  };

  // Returns a Google language code, or '' when basic mode cannot handle the target.
  function googleLang(target) {
    const t = String(target || '').trim();
    if (GOOGLE_LANGS[t]) return GOOGLE_LANGS[t];
    return /^[a-z]{2,3}(-[A-Za-z]{2,4})?$/.test(t) ? t : '';
  }

  // Anything that changes translation output must be part of the cache signature.
  function sigOf(s) {
    if (isBasic(s)) return hash([PROMPT_VERSION, s.provider, s.targetLang].join('\u0001'));
    const cfg = s.providers[s.provider] || {};
    return hash([
      PROMPT_VERSION, s.provider, cfg.model, s.targetLang,
      s.courseContext, s.glossary, s.keepTerms ? 1 : 0
    ].join('\u0001'));
  }

  return {
    PROMPT_VERSION, BASIC_PROVIDER, AI_PROVIDERS, DEFAULTS, PROVIDER_LABELS,
    merge, hash, getSettings, saveSettings, sigOf, isBasic, googleLang
  };
})();
