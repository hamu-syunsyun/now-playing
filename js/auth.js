// Spotify ログイン（Authorization Code + PKCE）。秘密鍵を使わないのでブラウザだけで完結する。

const SCOPES = [
  'user-read-playback-state', 'user-modify-playback-state', 'user-read-currently-playing',
  'playlist-read-private', 'playlist-read-collaborative', 'user-library-read', 'user-library-modify',
].join(' ');
const K_CLIENT = 'sp_client_id';
const K_TOKENS = 'sp_tokens';
const K_VERIFIER = 'sp_verifier';

// 置き場所がサブフォルダでも動くよう、いま開いているページ自身を戻り先にする
export const redirectUri = location.origin + location.pathname.replace(/index\.html$/, '');

export const getClientId = () => localStorage.getItem(K_CLIENT) || '';
export const setClientId = (id) => localStorage.setItem(K_CLIENT, id.trim());

const loadTokens = () => JSON.parse(localStorage.getItem(K_TOKENS) || 'null');
const saveTokens = (t) => localStorage.setItem(K_TOKENS, JSON.stringify(t));

export const isLoggedIn = () => !!loadTokens();

// 機能を足す前にログインした人は、新しい機能ぶんの許可を持っていない
export function hasAllScopes() {
  const granted = (loadTokens()?.scope || '').split(' ');
  return SCOPES.split(' ').every((s) => granted.includes(s));
}
export const logout = () => localStorage.removeItem(K_TOKENS);

function base64url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export async function login() {
  const verifier = base64url(crypto.getRandomValues(new Uint8Array(48)));
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(verifier));
  localStorage.setItem(K_VERIFIER, verifier);
  const params = new URLSearchParams({
    client_id: getClientId(),
    response_type: 'code',
    redirect_uri: redirectUri,
    scope: SCOPES,
    code_challenge_method: 'S256',
    code_challenge: base64url(new Uint8Array(digest)),
  });
  location.href = 'https://accounts.spotify.com/authorize?' + params;
}

async function tokenRequest(body) {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({ client_id: getClientId(), ...body }),
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) {
    const err = new Error(json.error_description || json.error || 'token request failed');
    err.status = 401;
    throw err;
  }
  const prev = loadTokens();
  saveTokens({
    access: json.access_token,
    refresh: json.refresh_token || prev?.refresh,
    scope: json.scope || prev?.scope || '',
    expiresAt: Date.now() + json.expires_in * 1000,
  });
}

// Spotify から戻ってきた直後の URL (?code=... / ?error=...) を処理する。
// 戻り値: エラーがあればその文字列、なければ null。
export async function handleRedirect() {
  const q = new URLSearchParams(location.search);
  const code = q.get('code');
  const error = q.get('error');
  if (!code && !error) return null;
  history.replaceState(null, '', location.pathname);
  if (error) return error;
  try {
    await tokenRequest({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      code_verifier: localStorage.getItem(K_VERIFIER) || '',
    });
    return null;
  } catch (e) {
    return e.message;
  } finally {
    localStorage.removeItem(K_VERIFIER);
  }
}

let refreshing = null;

export async function getToken(force = false) {
  const t = loadTokens();
  if (!t) {
    const err = new Error('not logged in');
    err.status = 401;
    throw err;
  }
  if (!force && Date.now() < t.expiresAt - 60_000) return t.access;
  refreshing ??= tokenRequest({ grant_type: 'refresh_token', refresh_token: t.refresh })
    .finally(() => { refreshing = null; });
  await refreshing;
  return loadTokens().access;
}
