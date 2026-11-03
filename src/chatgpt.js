// "Sign in with ChatGPT" (ChatGPT plan usage for open-source apps): lets AI requests use the
// user's ChatGPT subscription instead of an API key.
// https://developers.openai.com/siwc/token-sharing-open-source
//
// Runs in the background service worker, which is the only place that refreshes tokens (refresh
// tokens rotate, so two refreshers would race). One sign-in serves every model setting that
// picks the "chatgpt" format; the side panel asks the worker for an access token.
//
// The documented redirect is an HTTP loopback callback on 127.0.0.1. An extension cannot listen
// on a port, so the sign-in tab is watched and the callback URL is read when the tab reaches it.
globalThis.NTUSUB_CGPT = (() => {
  const ISSUER = 'https://auth.openai.com';
  const AUTHORIZE = ISSUER + '/api/accounts/authorize';
  const TOKEN = ISSUER + '/api/accounts/oauth/token';
  const REVOKE = ISSUER + '/api/accounts/oauth/revoke';
  const JWKS = ISSUER + '/.well-known/jwks.json';
  const RESOURCE = 'https://api.openai.com/v1';
  const SCOPE = 'openid profile email offline_access resource.invoke chatgpt.tokens.use.direct';
  const PLAN_SCOPE = 'chatgpt.tokens.use.direct';
  const APP_NAME = 'NTULearn Bilingual Subtitles';
  const CALLBACK_PATH = '/auth/callback';
  const AUTH_KEY = 'chatgptAuth'; // chrome.storage.local: host id, registrations and the active token set
  const LOGIN_KEY = 'chatgptLogin'; // chrome.storage.session: the pending attempt and its outcome
  const LOGIN_TIMEOUT_MS = 15 * 60 * 1000;
  // Refresh errors that mean the token set is unusable and the user must sign in again.
  const TERMINAL = /invalid_grant|invalid_refresh_token|token_expired|refresh_token_expired|refresh_token_invalidated|refresh_token_reused/;

  class AuthError extends Error {
    constructor(message, fatal = true) { super(message); this.fatal = fatal; }
  }

  // ------------------------------------------------------------------ helpers
  const b64url = (bytes) => btoa(String.fromCharCode(...new Uint8Array(bytes))).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
  const random = (n = 32) => b64url(crypto.getRandomValues(new Uint8Array(n)));
  const fromB64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice((s.length + 3) % 4)), (c) => c.charCodeAt(0));
  const sha256 = async (s) => b64url(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(s)));

  async function loadAuth() {
    const a = (await chrome.storage.local.get(AUTH_KEY))[AUTH_KEY] || {};
    if (!a.hostId) a.hostId = 'urn:uuid:' + crypto.randomUUID();
    if (!a.clients) a.clients = {}; // sub -> { clientId, email, idToken }
    return a;
  }
  const saveAuth = (a) => chrome.storage.local.set({ [AUTH_KEY]: a });
  const setLogin = (v) => chrome.storage.session.set({ [LOGIN_KEY]: v });
  const getLogin = async () => (await chrome.storage.session.get(LOGIN_KEY))[LOGIN_KEY] || null;

  async function postForm(url, params) {
    let res;
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams(params).toString()
      });
    } catch (e) {
      throw new AuthError('无法连接 auth.openai.com：' + e.message, false);
    }
    const text = await res.text();
    let j = {};
    try { j = text ? JSON.parse(text) : {}; } catch (e) { /* not JSON */ }
    if (!res.ok) {
      const code = j.error && typeof j.error === 'object' ? j.error.code : j.error;
      const err = new AuthError(`HTTP ${res.status}: ${j.error_description || (j.error && j.error.message) || code || text.slice(0, 200)}`, res.status < 500);
      err.code = String(code || '');
      err.status = res.status;
      throw err;
    }
    return j;
  }

  // ID token: RS256 signature against OpenAI's JWKS, then issuer, audience, expiry and nonce.
  let jwksCache = null;
  async function verifyIdToken(idToken, clientId, nonce) {
    const parts = String(idToken || '').split('.');
    if (parts.length !== 3) throw new AuthError('登录返回的 ID token 格式不正确');
    const header = JSON.parse(new TextDecoder().decode(fromB64url(parts[0])));
    const claims = JSON.parse(new TextDecoder().decode(fromB64url(parts[1])));
    if (header.alg !== 'RS256') throw new AuthError('ID token 签名算法不受支持');
    const findKey = (keys) => keys.find((k) => k.kid === header.kid);
    let jwk = jwksCache && findKey(jwksCache);
    if (!jwk) {
      const res = await fetch(JWKS);
      if (!res.ok) throw new AuthError('无法获取 OpenAI 公钥', false);
      jwksCache = (await res.json()).keys || [];
      jwk = findKey(jwksCache);
    }
    if (!jwk) throw new AuthError('ID token 的签名公钥不存在');
    const key = await crypto.subtle.importKey('jwk', { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    const ok = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key, fromB64url(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
    if (!ok) throw new AuthError('ID token 签名无效');
    const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
    if (claims.iss !== ISSUER) throw new AuthError('ID token 签发方不正确');
    if (!aud.includes(clientId)) throw new AuthError('ID token 的 audience 不匹配');
    if (!(claims.exp * 1000 > Date.now() - 60000)) throw new AuthError('ID token 已过期');
    if (claims.nonce !== nonce) throw new AuthError('ID token 的 nonce 不匹配');
    if (!claims.sub) throw new AuthError('ID token 缺少账号标识');
    return claims;
  }

  // ------------------------------------------------------------------ sign-in
  // Starts a sign-in in a new tab and returns at once; the outcome is written to
  // chrome.storage.session[LOGIN_KEY] (the worker may be restarted while the user signs in).
  async function startLogin({ newAccount = false } = {}) {
    const auth = await loadAuth();
    await saveAuth(auth); // persist the host id before the first sign-in
    const last = !newAccount && auth.lastSub && auth.clients[auth.lastSub];
    const port = 20000 + Math.floor(Math.random() * 40000);
    const redirectUri = `http://127.0.0.1:${port}${CALLBACK_PATH}`;
    const verifier = random(48);
    const pending = {
      status: 'pending', state: random(), nonce: random(), verifier, redirectUri,
      clientId: last ? last.clientId : 'dynamic_agent_client', sub: last ? last.sub : '',
      startedAt: Date.now(), tabId: null
    };
    const q = new URLSearchParams({
      client_id: pending.clientId,
      ext_agent_host_id: auth.hostId,
      response_type: 'code',
      redirect_uri: redirectUri,
      scope: SCOPE,
      resource: RESOURCE,
      state: pending.state,
      nonce: pending.nonce,
      code_challenge_method: 'S256',
      code_challenge: await sha256(verifier)
    });
    if (last) {
      if (last.idToken) q.set('id_token_hint', last.idToken);
      if (last.email) q.set('login_hint', last.email);
    } else {
      q.set('agent_name_hint', APP_NAME);
    }
    await setLogin(pending);
    const tab = await chrome.tabs.create({ url: AUTHORIZE + '?' + q.toString() });
    pending.tabId = tab.id;
    await setLogin(pending);
  }

  async function cancelLogin() {
    const p = await getLogin();
    if (p && p.status === 'pending') {
      await setLogin({ status: 'cancelled' });
      if (p.tabId != null) chrome.tabs.remove(p.tabId).catch(() => {});
    }
  }

  async function finishLogin(p, url) {
    const cb = new URL(url).searchParams;
    if (cb.get('state') !== p.state) throw new AuthError('登录回调的 state 不匹配，已忽略');
    if (cb.get('error')) {
      throw new AuthError(cb.get('error') === 'access_denied'
        ? '已取消授权，或该账号未开启"在第三方应用中使用 ChatGPT 套餐"'
        : '登录失败：' + (cb.get('error_description') || cb.get('error')));
    }
    const code = cb.get('code');
    let clientId = p.clientId;
    if (clientId === 'dynamic_agent_client') {
      clientId = cb.get('client_id');
      if (!clientId) throw new AuthError('注册未完成（回调中没有 client_id），请重新登录');
    } else if (cb.get('client_id') && cb.get('client_id') !== clientId) {
      throw new AuthError('登录回调的 client_id 与当前账号不一致，已忽略');
    }
    const tok = await postForm(TOKEN, {
      grant_type: 'authorization_code', client_id: clientId, code, code_verifier: p.verifier,
      redirect_uri: p.redirectUri, resource: RESOURCE
    });
    const claims = await verifyIdToken(tok.id_token, clientId, p.nonce);
    if (p.sub && claims.sub !== p.sub) throw new AuthError('登录的不是之前的 ChatGPT 账号；如需换号请点「换一个账号」');
    const scopes = String(tok.scope || '').split(/\s+/).filter(Boolean);
    if (!scopes.includes(PLAN_SCOPE)) throw new AuthError('该账号没有授予"使用 ChatGPT 套餐"的权限（可能套餐不支持或在授权页未开启）');
    if (!tok.refresh_token) throw new AuthError('登录没有返回 refresh token，请重试');

    const auth = await loadAuth();
    const plan = (claims['https://api.openai.com/auth'] || {}).chatgpt_plan_type || '';
    auth.clients[claims.sub] = { clientId, sub: claims.sub, email: claims.email || '', idToken: tok.id_token };
    auth.lastSub = claims.sub;
    auth.session = {
      sub: claims.sub, clientId, email: claims.email || '', name: claims.name || '', plan,
      accessToken: tok.access_token, refreshToken: tok.refresh_token, idToken: tok.id_token,
      expiresAt: Date.now() + (tok.expires_in || 3600) * 1000, scopes
    };
    const firstTime = !auth.welcomed;
    auth.welcomed = true;
    await saveAuth(auth);
    return { firstTime };
  }

  // The sign-in tab reaching the loopback callback carries the result in its URL.
  chrome.tabs.onUpdated.addListener(async (tabId, info) => {
    if (!info.url || !info.url.startsWith('http://127.0.0.1:') || !info.url.includes(CALLBACK_PATH + '?')) return;
    const p = await getLogin();
    if (!p || p.status !== 'pending' || p.tabId !== tabId || !info.url.startsWith(p.redirectUri)) return;
    await setLogin({ ...p, status: 'exchanging' });
    chrome.tabs.remove(tabId).catch(() => {});
    try {
      const r = await finishLogin(p, info.url);
      await setLogin({ status: 'ok', firstTime: r.firstTime, at: Date.now() });
    } catch (e) {
      await setLogin({ status: 'error', error: e.message, at: Date.now() });
    }
  });
  chrome.tabs.onRemoved.addListener(async (tabId) => {
    const p = await getLogin();
    if (p && p.status === 'pending' && p.tabId === tabId) await setLogin({ status: 'cancelled' });
  });

  // ------------------------------------------------------------------ tokens
  let refreshing = null;

  async function refresh(auth) {
    const s = auth.session;
    try {
      const tok = await postForm(TOKEN, { grant_type: 'refresh_token', client_id: s.clientId, refresh_token: s.refreshToken, resource: RESOURCE });
      // Rotating refresh token: replace everything together.
      s.accessToken = tok.access_token;
      s.refreshToken = tok.refresh_token || s.refreshToken;
      s.expiresAt = Date.now() + (tok.expires_in || 3600) * 1000;
      if (tok.scope) s.scopes = String(tok.scope).split(/\s+/).filter(Boolean);
      if (tok.id_token) { s.idToken = tok.id_token; if (auth.clients[s.sub]) auth.clients[s.sub].idToken = tok.id_token; }
      await saveAuth(auth);
      return s.accessToken;
    } catch (e) {
      if (TERMINAL.test(e.code || e.message)) {
        delete auth.session;
        await saveAuth(auth);
        throw new AuthError('ChatGPT 登录已失效，请在设置里重新点「Continue with ChatGPT」登录');
      }
      throw new AuthError('刷新 ChatGPT 登录失败：' + e.message, false);
    }
  }

  // A valid access token, refreshed (one refresh at a time) when it is about to expire.
  async function getToken() {
    const auth = await loadAuth();
    const s = auth.session;
    if (!s) throw new AuthError('尚未登录 ChatGPT，请在设置里点「Continue with ChatGPT」登录');
    if (!s.scopes || !s.scopes.includes(PLAN_SCOPE)) throw new AuthError('该 ChatGPT 账号没有授予使用套餐的权限，请重新登录');
    if (s.expiresAt - Date.now() > 120000) return s.accessToken;
    if (!refreshing) refreshing = refresh(auth).finally(() => { refreshing = null; });
    return refreshing;
  }

  async function logout() {
    const auth = await loadAuth();
    const s = auth.session;
    let revoked = true;
    if (s && s.refreshToken) {
      revoked = false;
      for (let i = 0; i < 3 && !revoked; i++) {
        try {
          await postForm(REVOKE, { token: s.refreshToken, token_type_hint: 'refresh_token', client_id: s.clientId });
          revoked = true;
        } catch (e) {
          if (e.status && e.status < 500) break;
          await new Promise((r) => setTimeout(r, 800 * 2 ** i));
        }
      }
    }
    // Keep the host id and the account -> client mapping for a later sign-in.
    delete auth.session;
    await saveAuth(auth);
    return { revoked };
  }

  // Display info only, never tokens.
  async function status() {
    const auth = await loadAuth();
    const s = auth.session;
    const login = await getLogin();
    return {
      signedIn: !!s,
      email: s ? s.email : '',
      name: s ? s.name : '',
      plan: s ? s.plan : '',
      planScope: !!(s && s.scopes && s.scopes.includes(PLAN_SCOPE)),
      hasPrevious: !!(auth.lastSub && auth.clients[auth.lastSub]),
      previousEmail: auth.lastSub && auth.clients[auth.lastSub] ? auth.clients[auth.lastSub].email : '',
      login: login && { status: login.status, error: login.error || '', firstTime: !!login.firstTime,
        expired: login.status === 'pending' && Date.now() - login.startedAt > LOGIN_TIMEOUT_MS }
    };
  }

  return { startLogin, cancelLogin, getToken, logout, status, AUTH_KEY, LOGIN_KEY, AuthError };
})();
