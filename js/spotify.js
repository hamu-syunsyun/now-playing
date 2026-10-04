// Spotify Web API のうち、再生画面に必要なものだけ。
import { getToken } from './auth.js';

const BASE = 'https://api.spotify.com/v1';
const PAGE = 50;

async function api(method, path, body, retried = false) {
  const token = await getToken(retried);
  const res = await fetch(BASE + path, {
    method,
    headers: { Authorization: 'Bearer ' + token, ...(body && { 'Content-Type': 'application/json' }) },
    body: body && JSON.stringify(body),
  });
  if (res.status === 401 && !retried) return api(method, path, body, true);
  if (res.status === 204) return null;
  const text = await res.text();
  let json = null;
  try { json = text ? JSON.parse(text) : null; } catch { /* 操作系は本文が JSON でないことがある */ }
  if (!res.ok) {
    const err = new Error(json?.error?.message || res.statusText);
    err.status = res.status;
    err.reason = json?.error?.reason;
    err.retryAfter = Number(res.headers.get('Retry-After')) || 0;
    throw err;
  }
  return json;
}

const smallest = (images) => images?.[images.length - 1]?.url || '';

// album: アルバムの曲一覧のように、曲そのものにアルバム情報が付いてこないときに渡す
function toTrack(item, album) {
  if (!item) return null;
  const episode = item.type === 'episode';
  const al = episode ? null : item.album || album;
  const images = episode ? item.images : al?.images;
  return {
    id: item.id || item.uri || item.name,
    uri: item.uri,
    albumUri: al?.uri || '',
    title: item.name,
    artist: episode ? item.show?.name || '' : (item.artists || []).map((a) => a.name).join(', '),
    firstArtist: episode ? '' : item.artists?.[0]?.name || '',
    album: al?.name || '',
    art: images?.[0]?.url || '',
    thumb: smallest(images),
    duration: item.duration_ms,
    hasLyrics: !episode,
  };
}

// アルバム・プレイリスト・お気に入りを同じ形で扱う
const LIKED = { kind: 'liked', id: 'liked', uri: '', title: 'お気に入りの曲', sub: '', thumb: '', images: [] };

function toCollection(item, kind) {
  if (!item) return null;
  const count = (item.items || item.tracks)?.total ?? item.total_tracks;
  const who = kind === 'album' ? (item.artists || []).map((a) => a.name).join(', ') : item.owner?.display_name || '';
  return {
    kind,
    id: item.id,
    uri: item.uri,
    title: item.name,
    sub: [who, count != null ? `${count}曲` : ''].filter(Boolean).join('　'),
    thumb: smallest(item.images),
    images: item.images || [],
    name: item.name,
  };
}

// ---------- 再生の状態 ----------

const toDevice = (d) => d && {
  id: d.id,
  name: d.name,
  type: d.type,
  active: d.is_active,
  volume: d.volume_percent ?? 0,
  canVolume: d.supports_volume !== false,
};

// 何も再生していなければ null
export async function getPlayback() {
  const pb = await api('GET', '/me/player?additional_types=track,episode');
  const track = toTrack(pb?.item);
  if (!track) return null;
  return {
    track,
    isPlaying: pb.is_playing,
    progress: pb.progress_ms ?? 0,
    shuffle: !!pb.shuffle_state,
    repeat: pb.repeat_state || 'off',
    device: toDevice(pb.device),
  };
}

export const play = () => api('PUT', '/me/player/play');
export const pause = () => api('PUT', '/me/player/pause');
export const next = () => api('POST', '/me/player/next');
export const prev = () => api('POST', '/me/player/previous');
export const seek = (ms) => api('PUT', '/me/player/seek?position_ms=' + Math.max(0, Math.round(ms)));
export const setShuffle = (on) => api('PUT', '/me/player/shuffle?state=' + on);
export const setRepeat = (mode) => api('PUT', '/me/player/repeat?state=' + mode); // off | context | track
export const setVolume = (pct) => api('PUT', '/me/player/volume?volume_percent=' + Math.round(pct));

export async function getDevices() {
  const res = await api('GET', '/me/player/devices');
  return (res?.devices || []).map(toDevice);
}
export const transfer = (id) => api('PUT', '/me/player', { device_ids: [id], play: true });

export async function getQueue() {
  const res = await api('GET', '/me/player/queue');
  return (res?.queue || []).map((t) => toTrack(t)).filter(Boolean);
}
export const queueTrack = (t) => api('POST', '/me/player/queue?uri=' + encodeURIComponent(t.uri));

// 再生中の端末がないときは、Spotify を開いている端末を探してそこで鳴らす
async function start(body) {
  try {
    await api('PUT', '/me/player/play', body);
  } catch (e) {
    if (e.status !== 404) throw e;
    const devices = await getDevices();
    if (!devices.length) throw e;
    await api('PUT', '/me/player/play?device_id=' + encodeURIComponent(devices[0].id), body);
  }
}

// アルバムの中のその曲から再生する。終わったあと続きの曲に進めるようにするため。
export const playTrack = (t) =>
  start(t.albumUri ? { context_uri: t.albumUri, offset: { uri: t.uri } } : { uris: [t.uri] });

// col を再生する。track を渡すとその曲から。loaded は画面に読み込み済みの曲（お気に入り用）
export function playCollection(col, track, loaded = []) {
  if (col.uri) return start({ context_uri: col.uri, ...(track && { offset: { uri: track.uri } }) });
  const uris = loaded.map((t) => t.uri);
  return start({ uris, ...(track && { offset: { uri: track.uri } }) });
}

// ---------- 探す・ライブラリ ----------

export async function search(query) {
  // limit は 10 が上限
  const res = await api('GET', '/search?' + new URLSearchParams({ q: query, type: 'track,album,playlist', limit: 10 }));
  return {
    tracks: (res?.tracks?.items || []).map((t) => toTrack(t)).filter(Boolean),
    albums: (res?.albums?.items || []).map((a) => toCollection(a, 'album')).filter(Boolean),
    playlists: (res?.playlists?.items || []).map((p) => toCollection(p, 'playlist')).filter(Boolean),
  };
}

export async function getLibrary() {
  const res = await api('GET', `/me/playlists?limit=${PAGE}`);
  return [LIKED, ...(res?.items || []).map((p) => toCollection(p, 'playlist')).filter(Boolean)];
}

// 戻り値: { tracks, next }  next は続きがあるときの offset、なければ null
export async function getCollectionTracks(col, offset = 0) {
  const page = `limit=${PAGE}&offset=${offset}`;
  let res, tracks;
  if (col.kind === 'album') {
    res = await api('GET', `/albums/${col.id}/tracks?${page}`);
    tracks = res.items.map((t) => toTrack(t, col));
  } else if (col.kind === 'liked') {
    res = await api('GET', `/me/tracks?${page}`);
    tracks = res.items.map((i) => toTrack(i.track));
  } else {
    try {
      res = await api('GET', `/playlists/${col.id}/items?${page}`);
    } catch (e) {
      if (e.status !== 404) throw e;
      res = await api('GET', `/playlists/${col.id}/tracks?${page}`); // 旧い名前
    }
    tracks = res.items.map((i) => toTrack(i.item || i.track));
  }
  return { tracks: tracks.filter(Boolean), next: res.next ? offset + PAGE : null };
}

export async function isLiked(t) {
  const res = await api('GET', '/me/library/contains?uris=' + encodeURIComponent(t.uri));
  return !!res?.[0];
}
export const setLiked = (t, on) => api(on ? 'PUT' : 'DELETE', '/me/library?uris=' + encodeURIComponent(t.uri));

export { getLyrics } from './lyrics.js';
