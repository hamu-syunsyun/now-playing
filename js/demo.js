// ?demo で開いたときの見本。Spotify にはつながず、架空の曲で画面の動きだけ確かめる。

function jacket(hue) {
  const c = document.createElement('canvas');
  c.width = c.height = 640;
  const x = c.getContext('2d');
  x.fillStyle = `hsl(${hue} 55% 30%)`;
  x.fillRect(0, 0, 640, 640);
  x.fillStyle = `hsl(${(hue + 40) % 360} 80% 62%)`;
  x.beginPath(); x.arc(400, 260, 190, 0, Math.PI * 2); x.fill();
  x.fillStyle = `hsl(${(hue + 200) % 360} 30% 12%)`;
  x.fillRect(0, 470, 640, 170);
  return c.toDataURL('image/png');
}

const TRACKS = [
  { id: 'demo1', title: '見本の曲 その1', artist: '見本のアーティスト', duration: 96_000, hue: 205, kind: 'synced' },
  { id: 'demo2', title: '見本の曲 その2（時刻のない歌詞）', artist: '見本のアーティスト', duration: 80_000, hue: 20, kind: 'plain' },
  { id: 'demo3', title: '見本の曲 その3（歌詞なし）', artist: '見本のアーティスト', duration: 60_000, hue: 130, kind: 'none' },
].map((t) => {
  const art = jacket(t.hue);
  return { ...t, uri: t.id, firstArtist: t.artist, album: '', art, thumb: art, hasLyrics: true };
});

const ALBUM = { kind: 'album', id: 'a', uri: 'a', title: '見本のアルバム', sub: '見本のアーティスト　3曲', thumb: TRACKS[0].art };
const LIST = { kind: 'playlist', id: 'p', uri: 'p', title: '見本のプレイリスト', sub: '3曲', thumb: TRACKS[1].art };
const LIKED = { kind: 'liked', id: 'liked', uri: '', title: 'お気に入りの曲', sub: '', thumb: '' };

const SAMPLE = [
  'ここに歌詞が一行ずつ出ます',
  'いま歌っている行だけが濃くなります',
  '行を押すとその位置まで飛びます',
  '',
  '長い行は折り返して、このように二行以上にまたがって表示されます',
  '英語の行 A line in English looks like this',
  '短い行',
  'ウィンドウを細くすると縦並びに変わります',
  '横に細長くすると今の行だけになります',
  '最後の行です',
];

let index = 0;
let isPlaying = true;
let base = 0;
let at = performance.now();
let shuffle = false;
let repeat = 'off';
const liked = new Set();
const devices = [
  { id: 'd1', name: '見本のパソコン', type: 'Computer', active: true, volume: 60, canVolume: true },
  { id: 'd2', name: '見本のスマホ', type: 'Smartphone', active: false, volume: 100, canVolume: false },
];

const pos = () => base + (isPlaying ? performance.now() - at : 0);
const set = (ms) => { base = ms; at = performance.now(); };
const go = (d) => { index = (index + d + TRACKS.length) % TRACKS.length; set(0); };

export async function getPlayback() {
  if (pos() >= TRACKS[index].duration) go(1);
  return { track: TRACKS[index], isPlaying, progress: pos(), shuffle, repeat, device: devices.find((d) => d.active) };
}
export async function play() { set(pos()); isPlaying = true; }
export async function pause() { set(pos()); isPlaying = false; }
export async function next() { go(1); }
export async function prev() { go(-1); }
export async function seek(ms) { set(ms); }
export async function setShuffle(on) { shuffle = on; }
export async function setRepeat(mode) { repeat = mode; }
export async function setVolume(pct) { devices.find((d) => d.active).volume = pct; }
export async function getDevices() { return devices; }
export async function transfer(id) { for (const d of devices) d.active = d.id === id; }
export async function getQueue() { return [1, 2].map((d) => TRACKS[(index + d) % TRACKS.length]); }
export async function queueTrack() {}

export async function playTrack(t) { index = TRACKS.indexOf(t); set(0); isPlaying = true; }
export async function playCollection(col, track) { return playTrack(track || TRACKS[0]); }

export async function search() { return { tracks: TRACKS, albums: [ALBUM], playlists: [LIST] }; }
export async function getLibrary() { return [LIKED, LIST]; }
export async function getCollectionTracks() { return { tracks: TRACKS, next: null }; }
export async function isLiked(t) { return liked.has(t.id); }
export async function setLiked(t, on) { on ? liked.add(t.id) : liked.delete(t.id); }

export async function getLyrics(track) {
  if (track.kind === 'none') return null;
  if (track.kind === 'plain') return { plain: [...SAMPLE, '', ...SAMPLE] };
  const synced = [];
  for (let i = 0; i < 24; i++) synced.push({ t: 3000 + i * 3600, text: SAMPLE[i % SAMPLE.length] });
  return { synced };
}
