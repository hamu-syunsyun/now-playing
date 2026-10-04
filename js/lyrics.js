// 歌詞は LRCLIB (https://lrclib.net) から取る。Spotify の公式 API には歌詞がない。

const API = 'https://lrclib.net/api';
const cache = new Map();

// "[01:23.45] 歌詞" の並びを [{ t: ミリ秒, text }] にする
export function parseLRC(lrc) {
  const lines = [];
  for (const raw of lrc.split(/\r?\n/)) {
    const stamps = [...raw.matchAll(/\[(\d+):(\d+(?:\.\d+)?)\]/g)];
    if (!stamps.length) continue;
    const text = raw.replace(/\[[^\]]*\]/g, '').trim();
    for (const m of stamps) lines.push({ t: (Number(m[1]) * 60 + Number(m[2])) * 1000, text });
  }
  return lines.sort((a, b) => a.t - b.t);
}

function shape(rec) {
  if (!rec) return null;
  if (rec.syncedLyrics) {
    const synced = parseLRC(rec.syncedLyrics);
    if (synced.length) return { synced };
  }
  if (rec.plainLyrics) return { plain: rec.plainLyrics.split(/\r?\n/) };
  if (rec.instrumental) return { instrumental: true };
  return null;
}

async function getJSON(url) {
  const res = await fetch(url);
  return res.ok ? res.json() : null;
}

// "曲名 - Remastered 2011" や "曲名 (feat. X)" の付け足しを落とす
const cleanTitle = (s) => s.replace(/\s+-\s+.*$/, '').replace(/\s*[(（\[].*?[)）\]]\s*/g, ' ').trim();

async function lookup(track) {
  const sec = Math.round(track.duration / 1000);
  const exact = await getJSON(`${API}/get?` + new URLSearchParams({
    track_name: track.title,
    artist_name: track.firstArtist,
    album_name: track.album,
    duration: sec,
  }));
  const hit = shape(exact);
  if (hit?.synced) return hit;

  // 完全一致がない、または時刻なししか無いときは検索して、長さが近いものを選ぶ
  const titles = [...new Set([track.title, cleanTitle(track.title)])].filter(Boolean);
  for (const title of titles) {
    const list = await getJSON(`${API}/search?` + new URLSearchParams({
      track_name: title,
      artist_name: track.firstArtist,
    }));
    const near = (list || [])
      .filter((r) => Math.abs(r.duration - sec) <= 4)
      .sort((a, b) => !!b.syncedLyrics - !!a.syncedLyrics || Math.abs(a.duration - sec) - Math.abs(b.duration - sec));
    const found = shape(near[0]);
    if (found?.synced) return found;
    if (found && !hit) return found;
  }
  return hit;
}

// 戻り値: { synced } | { plain } | { instrumental } | null
export async function getLyrics(track) {
  if (!track.hasLyrics) return null;
  if (cache.has(track.id)) return cache.get(track.id);
  let result = null;
  try {
    result = await lookup(track);
  } catch {
    return null; // 通信失敗は覚えない。次に同じ曲が来たらもう一度試す
  }
  cache.set(track.id, result);
  return result;
}
