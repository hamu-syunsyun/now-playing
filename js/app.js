import * as auth from './auth.js';
import { paletteFrom, DEFAULT } from './color.js';
import { createPanel } from './panel.js';
import * as lyricsDb from './lyrics.js';

const demo = new URLSearchParams(location.search).has('demo');
const source = await import(demo ? './demo.js' : './spotify.js');

const $ = (id) => document.getElementById(id);
const body = document.body;
body.dataset.view = 'starting'; // ここまで来たら「ファイルを直接開いています」の案内は出さない
const el = {
  art: $('art'), title: $('title'), artist: $('artist'),
  lyrics: $('lyrics'), inner: $('lyricsInner'), note: $('lyricsNote'),
  seek: $('seek'), seekFill: $('seekFill'), seekKnob: $('seekKnob'),
  fill: $('barFill'), now: $('timeNow'), all: $('timeAll'),
  like: $('like'), upNext: $('upNext'), toast: $('toast'),
  tune: $('tune'), tuneValue: $('tuneValue'),
};

const POLL_MS = 2000;
const LEAD_MS = 150;     // 歌い出しより少し早く行を切り替える。ぴったりだと遅れて見える
const TUNE_STEP_MS = 250;
const OFFSETS_KEY = 'lyric_offsets';
const SCALES = [0.85, 1, 1.2, 1.45]; // 歌詞の文字の大きさ（小・標準・大・特大）
const SCALE_KEY = 'lyric_scale';
const portrait = matchMedia('(max-aspect-ratio: 1/1)');
// いまの行を歌詞欄の上から何割の位置に置くか。縦長では上に寄せて、先の歌詞を多く見せる
const activeAt = () => (portrait.matches ? 0.3 : 0.42);

let track = null;
let isPlaying = false;
let anchor = { progress: 0, at: 0 }; // 最後に確認した再生位置と、その時刻
let epoch = 0;                       // 操作のたびに増やし、操作前に出した問い合わせの結果を捨てる
let synced = null;                   // [{ t, text }] 時刻つき歌詞
let lineEls = [];
let activeIndex = -2;
let marked = [];                     // 今の行の近くにあって、距離（--d）を書き込んである行
let browse = 0;                      // 歌詞を自分で送っているあいだのずれ（px）
let browseTimer = 0;
let pollTimer = 0;
let endKicked = false;
let dragRatio = null;                // シークバーをつまんでいるあいだの位置（0〜1）
let shuffle = false;
let repeat = 'off';
let device = null;
let liked = false;
let lyricOffset = 0;                 // この曲の歌詞を何ミリ秒早めるか（負なら遅らせる）。曲ごとに覚える
let showing = 0;                     // 曲の切り替えの通し番号。古い切り替えの結果を捨てるのに使う
let shown = false;                   // 再生画面に曲を出し終えたか

// 機能を足す前にログインしたままだと、お気に入りやプレイリストの許可がない
const fullAccess = () => demo || auth.hasAllScopes();

const position = () => {
  const p = anchor.progress + (isPlaying ? performance.now() - anchor.at : 0);
  return track ? Math.min(p, track.duration) : 0;
};

const fmt = (ms) => {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

let toastTimer = 0;
function toast(message) {
  el.toast.textContent = message;
  el.toast.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.toast.classList.remove('show'), 4000);
}

function setColors({ bg, fg, backdrop, tone }) {
  const root = document.documentElement;
  root.dataset.tone = tone;
  root.style.setProperty('--bg', bg);
  root.style.setProperty('--fg', fg);
  root.style.backgroundImage = backdrop ? `url("${backdrop}")` : 'none';
  document.querySelector('meta[name="theme-color"]').content = bg;
}

// ---------- 最初の設定画面 ----------

function showSetup(error) {
  clearTimeout(pollTimer);
  body.dataset.view = 'setup';
  setColors(DEFAULT);
  document.title = '再生中';
  $('redirectUri').textContent = auth.redirectUri;
  $('clientId').value = auth.getClientId();
  $('setupError').hidden = !error;
  if (error) $('setupError').textContent = error;
}

$('copyUri').addEventListener('click', async () => {
  await navigator.clipboard.writeText(auth.redirectUri);
  $('copyUri').textContent = 'コピーしました';
});

$('connect').addEventListener('click', () => {
  const id = $('clientId').value.trim();
  if (!/^[0-9a-f]{32}$/i.test(id)) {
    showSetup('Client ID は英数字32文字です。ダッシュボードのアプリ画面からコピーして貼り直してください。');
    return;
  }
  auth.setClientId(id);
  auth.login();
});

// ---------- 曲が変わったとき ----------

// 画面の中身を入れ替える。対応しているブラウザでは、前の画面から次の画面へ溶けるように切り替わる
function swap(change) {
  if (!document.startViewTransition || document.hidden) { change(); return; }
  const vt = document.startViewTransition(change);
  // 切り替えの途中で次の切り替えが来ると、前のものは打ち切られる。それは失敗ではない
  vt.ready.catch(() => {});
  vt.finished.catch(() => {});
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function preload(url) {
  const img = new Image();
  img.crossOrigin = 'anonymous';
  img.src = url;
  await img.decode().catch(() => {});
}

const LYRICS_WAIT_MS = 1200; // 歌詞がこれより遅ければ、先に曲だけ切り替えて歌詞はあとから出す

// 曲が変わったら、ジャケット・色・歌詞を裏でそろえてから一度に切り替える。
// ばらばらに届いた順に出すと、色、絵、歌詞が別々のタイミングで変わってガタつく。
async function showTrack(t) {
  track = t;
  synced = null; // 前の曲の歌詞を新しい曲の時間で光らせない
  lyricOffset = loadOffsets()[t.id] || 0;
  el.tune.hidden = true;
  const my = ++showing;
  document.title = t.artist ? `${t.title} – ${t.artist}` : t.title;

  const lyricsReady = source.getLyrics(t).catch(() => null);
  const LATE = {};
  const [palette, lyrics] = await Promise.all([
    t.art ? paletteFrom(t.art) : DEFAULT,
    Promise.race([lyricsReady, wait(LYRICS_WAIT_MS).then(() => LATE)]),
    t.art ? preload(t.art) : null,
  ]);
  if (my !== showing) return;

  swap(() => {
    body.dataset.view = 'player';
    shown = true;
    el.title.textContent = t.title;
    el.artist.textContent = t.artist;
    el.title.parentElement.classList.toggle('link', !!t.albumUri);
    el.all.textContent = fmt(t.duration);
    if (t.art) {
      el.art.src = t.art;
      el.art.alt = `${t.title} のジャケット`;
      el.art.classList.add('ready');
    } else {
      el.art.removeAttribute('src');
      el.art.classList.remove('ready');
    }
    setColors(palette);
    paintLike(false);
    el.like.hidden = !fullAccess() || !t.hasLyrics; // ポッドキャストの回はお気に入りの対象外
    if (lyrics === LATE) {
      fillLyrics(null); // 配置は前の曲のまま、歌詞だけ空にしておく
    } else {
      fillLyrics(lyrics);
      body.dataset.lyrics = kindOf(lyrics);
    }
  });

  if (lyrics === LATE) lyricsReady.then((l) => { if (my === showing) renderLyrics(l); });
  refreshUpNext(1500);
  if (fullAccess() && t.hasLyrics) source.isLiked(t).then((v) => { if (track === t) paintLike(v); }).catch(() => {});
}

function paintLike(v) {
  liked = v;
  el.like.setAttribute('aria-pressed', v);
  el.like.setAttribute('aria-label', v ? 'お気に入りから外す' : 'お気に入りに入れる');
}

// このあと流れる曲を1つだけ出す。Spotify 側の並びが落ち着くのを少し待ってから取りに行く
let upNextTimer = 0;
function refreshUpNext(delay) {
  clearTimeout(upNextTimer);
  el.upNext.replaceChildren();
  const t = track;
  upNextTimer = setTimeout(async () => {
    const [next] = await source.getQueue().catch(() => []);
    if (!next || track !== t) return;
    const label = document.createElement('span');
    label.textContent = 'つぎ';
    const name = document.createElement('b');
    name.textContent = next.artist ? `${next.title} – ${next.artist}` : next.title;
    el.upNext.replaceChildren(label, name);
  }, delay);
}

const GAP_MS = 5000; // 歌い出しまでこれ以上あくなら、前奏として点を出す

// 歌詞のあり・なしで配置が変わるときは、ジャケットが飛ばないように動かして切り替える
const kindOf = (l) => (l?.synced?.length ? 'synced' : l?.plain ? 'plain' : 'none');

function renderLyrics(l) {
  swap(() => { fillLyrics(l); body.dataset.lyrics = kindOf(l); });
}

function fillLyrics(l) {
  synced = l?.synced?.length ? l.synced : null;
  if (synced && synced[0].t > GAP_MS) synced = [{ t: 0, text: '' }, ...synced];
  lineEls = [];
  marked = [];
  browse = 0;
  el.lyrics.classList.remove('browsing');
  activeIndex = -2;
  el.inner.replaceChildren();
  el.inner.style.transform = '';
  el.lyrics.scrollTop = 0;
  el.note.textContent = l?.instrumental ? '歌のない曲です' : '';

  const lines = synced ? synced.map((s) => s.text) : l?.plain || [];
  for (const [i, text] of lines.entries()) {
    const p = document.createElement('p');
    p.className = 'line';
    if (synced && !text) {
      p.classList.add('gap'); // 間奏
      p.append(...[0, 1, 2].map(() => document.createElement('i')));
    } else {
      p.textContent = text;
    }
    if (synced) p.addEventListener('click', () => seekTo(Math.max(0, synced[i].t - lyricOffset)));
    el.inner.append(p);
    lineEls.push(p);
  }
}

// ---------- 毎フレームの更新 ----------

function currentLine(pos) {
  let lo = 0, hi = synced.length - 1, ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (synced[mid].t <= pos) { ans = mid; lo = mid + 1; } else hi = mid - 1;
  }
  return ans;
}

function placeLyrics() {
  if (!synced || !lineEls.length) return;
  const target = lineEls[Math.max(activeIndex, 0)];
  const center = target.offsetTop + target.offsetHeight / 2;
  const top = el.lyrics.clientHeight * activeAt();
  // 自分で送ったぶんは、歌詞の先頭と末尾を越えないように止める
  const y = Math.min(top, Math.max(top - el.inner.offsetHeight, top - center + browse));
  browse = y - (top - center);
  el.inner.style.transform = `translateY(${y}px)`;
}

// 今の行と、その前後の行に「何行離れているか」を書き込む。見た目（濃さ・ぼけ）は CSS が決める
function markLines(i) {
  for (const p of marked) { p.style.removeProperty('--d'); p.classList.remove('now'); }
  marked = [];
  for (let j = i - 6; j <= i + 6; j++) {
    const p = lineEls[j];
    if (!p) continue;
    p.style.setProperty('--d', Math.abs(j - i));
    marked.push(p);
  }
  lineEls[i]?.classList.add('now');
}

// 歌詞を自分で送る。手を止めて3秒たつと今の行に戻る
function browseBy(dy) {
  if (!synced) return;
  browse += dy;
  el.lyrics.classList.add('browsing');
  placeLyrics();
  clearTimeout(browseTimer);
  browseTimer = setTimeout(() => {
    browse = 0;
    el.lyrics.classList.remove('browsing');
    placeLyrics();
  }, 3000);
}

function frame() {
  if (track) {
    const pos = position();
    const ratio = dragRatio ?? (track.duration ? pos / track.duration : 0);
    el.seekFill.style.width = el.seekKnob.style.left = `${ratio * 100}%`;
    el.fill.style.transform = `scaleX(${ratio})`;
    el.now.textContent = fmt(dragRatio === null ? pos : dragRatio * track.duration);

    if (synced) {
      const i = currentLine(pos + LEAD_MS + lyricOffset);
      if (i !== activeIndex) {
        markLines(i);
        activeIndex = i;
        placeLyrics();
      }
    }

    // 曲の終わりに来たら、次の曲をすぐ取りに行く
    if (isPlaying && pos >= track.duration && !endKicked) {
      endKicked = true;
      kick(500);
    }
  }
  requestAnimationFrame(frame);
}

new ResizeObserver(placeLyrics).observe(el.lyrics);

el.lyrics.addEventListener('wheel', (e) => {
  if (!synced) return;
  e.preventDefault();
  browseBy(-e.deltaY);
}, { passive: false });

let touchY = null;
let dragging = false;
el.lyrics.addEventListener('touchstart', (e) => { touchY = e.touches[0].clientY; dragging = false; }, { passive: true });
el.lyrics.addEventListener('touchmove', (e) => {
  if (!synced || touchY === null) return;
  const y = e.touches[0].clientY;
  if (!dragging && Math.abs(y - touchY) < 8) return;
  dragging = true;
  browseBy(y - touchY);
  touchY = y;
}, { passive: true });
document.fonts?.ready.then(placeLyrics);

// ---------- Spotify への問い合わせ ----------

function kick(delay) {
  clearTimeout(pollTimer);
  pollTimer = setTimeout(poll, delay);
}

async function poll() {
  const myEpoch = epoch;
  const t0 = performance.now();
  let delay = document.hidden ? POLL_MS * 2.5 : POLL_MS;
  try {
    const pb = await source.getPlayback();
    if (myEpoch === epoch) apply(pb, (t0 + performance.now()) / 2);
  } catch (e) {
    if (e.status === 401) {
      auth.logout();
      showSetup('ログインの期限が切れました。もう一度ログインしてください。');
      return;
    }
    delay = Math.max(5000, (e.retryAfter || 0) * 1000);
  }
  kick(delay);
}

function apply(pb, at) {
  if (!pb) {
    track = null;
    shown = false;
    showing++;
    body.dataset.view = 'empty';
    body.classList.remove('playing');
    setColors(DEFAULT);
    document.title = '再生中';
    return;
  }
  if (shown) body.dataset.view = 'player'; // 最初の1曲は、絵と色がそろってから showTrack が出す
  const changed = pb.track.id !== track?.id;
  if (changed) showTrack(pb.track);
  // Spotify が返す再生位置は毎回数百ミリ秒ぶれる。そのまま採用すると歌詞が前後に揺れるので、
  // 同じ曲を再生し続けているあいだは、手元の時計で進めた位置に少しずつ寄せる。大きく違えばシークとみなす
  const expected = anchor.progress + (at - anchor.at);
  const drift = pb.progress - expected;
  const steady = !changed && isPlaying && pb.isPlaying && Math.abs(drift) < 1500;
  isPlaying = pb.isPlaying;
  anchor = { progress: steady ? expected + drift * 0.3 : pb.progress, at };
  shuffle = pb.shuffle;
  repeat = pb.repeat;
  device = pb.device;
  endKicked = false;
  body.classList.toggle('playing', isPlaying);
  syncWakeLock();
}

// ---------- 操作 ----------

const MESSAGES = {
  403: 'Spotify側でこの操作が断られました。',
  404: 'Spotifyを開いている端末が見つかりません。スマホかPCでSpotifyアプリを開いてから、もう一度どうぞ。',
  429: '操作が続きすぎました。少し待ってからもう一度どうぞ。',
};
const messageFor = (e) => MESSAGES[e.status] || '操作できませんでした。通信状態を確認してください。';

async function act(fn, optimistic) {
  if (!track) return;
  epoch++;
  optimistic?.();
  try {
    await fn();
  } catch (e) {
    toast(messageFor(e));
  }
  kick(400);
}

function toggle() {
  const wasPlaying = isPlaying;
  act(wasPlaying ? source.pause : source.play, () => {
    anchor = { progress: position(), at: performance.now() };
    isPlaying = !wasPlaying;
    body.classList.toggle('playing', isPlaying);
  });
}

function seekTo(ms) {
  act(() => source.seek(ms), () => { anchor = { progress: ms, at: performance.now() }; });
}

function nudgeVolume(step) {
  if (!device?.canVolume) { toast('いまの端末は、ここから音量を変えられません。'); return; }
  const v = Math.min(100, Math.max(0, device.volume + step));
  device = { ...device, volume: v };
  toast(`音量 ${v}`);
  act(() => source.setVolume(v));
}

async function toggleLike() {
  if (!track || el.like.hidden) return;
  const t = track;
  const v = !liked;
  paintLike(v);
  try {
    await source.setLiked(t, v);
    toast(v ? 'お気に入りに入れました。' : 'お気に入りから外しました。');
  } catch (e) {
    if (track === t) paintLike(!v);
    toast(messageFor(e));
  }
}

// ---------- 歌詞のタイミング合わせ ----------

function loadOffsets() {
  try { return JSON.parse(localStorage.getItem(OFFSETS_KEY)) || {}; } catch { return {}; }
}

function showTune() {
  if (!track || !synced) { toast('この曲には、歌に合わせて進む歌詞がありません。'); return; }
  const sec = (Math.abs(lyricOffset) / 1000).toFixed(2);
  el.tuneValue.textContent = lyricOffset > 0 ? `${sec}秒 早めています` : lyricOffset < 0 ? `${sec}秒 遅らせています` : 'ずれの調整なし';
  el.tune.hidden = false;
}

function tuneBy(step) {
  if (!track || !synced) { showTune(); return; }
  lyricOffset = step === 0 ? 0 : Math.min(15000, Math.max(-15000, lyricOffset + step));
  const all = loadOffsets();
  if (lyricOffset) all[track.id] = lyricOffset; else delete all[track.id];
  try { localStorage.setItem(OFFSETS_KEY, JSON.stringify(all)); } catch { /* 保存できなくても今の曲では効く */ }
  showTune();
}

$('tuneEarly').addEventListener('click', () => tuneBy(TUNE_STEP_MS));
$('tuneLate').addEventListener('click', () => tuneBy(-TUNE_STEP_MS));
$('tuneReset').addEventListener('click', () => tuneBy(0));
$('tuneDone').addEventListener('click', () => { el.tune.hidden = true; });

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}

// ---------- 文字の大きさ ----------

let scaleIndex = Number(localStorage.getItem(SCALE_KEY) ?? 1);
if (!SCALES[scaleIndex]) scaleIndex = 1;
function setScale(i) {
  scaleIndex = i;
  document.documentElement.style.setProperty('--lyric-scale', SCALES[i]);
  try { localStorage.setItem(SCALE_KEY, i); } catch { /* 保存できなくても今回は効く */ }
  requestAnimationFrame(placeLyrics);
}
setScale(scaleIndex);

// ---------- 再生中は画面を消さない ----------

let wakeLock = null;
let wakeBusy = false;
async function syncWakeLock() {
  if (!navigator.wakeLock || wakeBusy) return;
  const want = isPlaying && !document.hidden && body.dataset.view === 'player';
  if (want === !!wakeLock) return;
  wakeBusy = true;
  try {
    if (want) {
      wakeLock = await navigator.wakeLock.request('screen');
      wakeLock.addEventListener('release', () => { wakeLock = null; });
    } else {
      await wakeLock.release();
      wakeLock = null;
    }
  } catch { /* 省電力モードなどで断られることがある。そのときは何もしない */ }
  wakeBusy = false;
}

// ---------- スリープタイマー ----------

let sleepAt = 0;
let sleepTimer = 0;
function setSleep(minutes) {
  clearTimeout(sleepTimer);
  sleepAt = minutes ? Date.now() + minutes * 60_000 : 0;
  if (!minutes) return;
  sleepTimer = setTimeout(() => {
    sleepAt = 0;
    epoch++;
    source.pause().then(() => toast('スリープタイマーで再生を止めました。'), () => {});
    kick(500);
  }, minutes * 60_000);
}

function reloadLyrics() {
  const t = track;
  if (t) source.getLyrics(t).then((l) => { if (track === t) renderLyrics(l); });
}

const panel = createPanel({
  source,
  toast,
  messageFor,
  state: () => ({ shuffle, repeat, device, hasSynced: !!synced, hasTrack: !!track?.hasLyrics }),
  sleep: { set: setSleep, minutesLeft: () => (sleepAt ? Math.max(1, Math.round((sleepAt - Date.now()) / 60_000)) : 0) },
  lyrics: {
    scale: () => scaleIndex,
    setScale,
    candidates: () => lyricsDb.getCandidates(track),
    chosen: () => lyricsDb.chosenId(track),
    choose: (id) => { lyricsDb.choose(track, id); lyricOffset = 0; reloadLyrics(); },
  },
  tune: showTune,
  changed: () => { epoch++; kick(500); refreshUpNext(1500); },
  relogin: () => auth.login(),
});

$('toggle').addEventListener('click', toggle);
$('next').addEventListener('click', () => act(source.next));
$('prev').addEventListener('click', () => act(source.prev));
$('full').addEventListener('click', toggleFullscreen);
$('like').addEventListener('click', toggleLike);
$('openSearch').addEventListener('click', () => panel.open('search'));
$('openMenu').addEventListener('click', () => panel.open('library'));
el.art.addEventListener('dblclick', toggleFullscreen);
$('emptySearch').addEventListener('click', () => panel.open('search'));
$('emptyLibrary').addEventListener('click', () => panel.open('library'));

// 曲名を押すと、その曲のアルバムを開く
el.title.parentElement.addEventListener('click', () => {
  if (!track?.albumUri) return;
  panel.openCollection({ kind: 'album', id: track.albumUri.split(':').pop(), uri: track.albumUri, title: track.album, sub: '', thumb: track.thumb, images: [{ url: track.art }] });
});

// ジャケットを横に払うと曲送り（左へ払うと次、右へ払うと前）
let swipeX = null;
el.art.addEventListener('touchstart', (e) => { swipeX = e.touches[0].clientX; }, { passive: true });
el.art.addEventListener('touchend', (e) => {
  if (swipeX === null) return;
  const dx = e.changedTouches[0].clientX - swipeX;
  swipeX = null;
  if (Math.abs(dx) > 50) act(dx < 0 ? source.next : source.prev);
}, { passive: true });
portrait.addEventListener('change', placeLyrics);

if (!document.fullscreenEnabled) $('full').hidden = true; // iPhone は全画面にできない

// シークバー：押した位置へ飛ぶ。つまんで動かしているあいだは離すまで送らない
const ratioAt = (e) => {
  const r = el.seek.getBoundingClientRect();
  return Math.min(1, Math.max(0, (e.clientX - r.left) / r.width));
};
el.seek.addEventListener('pointerdown', (e) => {
  if (!track) return;
  el.seek.setPointerCapture(e.pointerId);
  el.seek.classList.add('dragging');
  dragRatio = ratioAt(e);
});
el.seek.addEventListener('pointermove', (e) => {
  if (dragRatio !== null) dragRatio = ratioAt(e);
});
el.seek.addEventListener('pointerup', (e) => {
  if (dragRatio === null) return;
  const ms = ratioAt(e) * track.duration;
  dragRatio = null;
  el.seek.classList.remove('dragging');
  seekTo(ms);
});
el.seek.addEventListener('pointercancel', () => {
  dragRatio = null;
  el.seek.classList.remove('dragging');
});

addEventListener('keydown', (e) => {
  if (panel.isOpen()) {
    if (e.key === 'Escape') panel.close();
    return;
  }
  if (body.dataset.view !== 'player') return;
  if (e.key === '/' || ((e.ctrlKey || e.metaKey) && e.code === 'KeyK')) { e.preventDefault(); panel.open('search'); return; }
  if (e.ctrlKey || e.metaKey || e.altKey) return;
  // [ と ] は日本語キーボードと英語キーボードで位置（code）が違うので、文字で見る
  if (e.key === ']') { tuneBy(TUNE_STEP_MS); return; }
  if (e.key === '[') { tuneBy(-TUNE_STEP_MS); return; }
  switch (e.code) {
    case 'Space': e.preventDefault(); toggle(); break;
    case 'ArrowRight': act(source.next); break;
    case 'ArrowLeft': act(source.prev); break;
    case 'ArrowUp': e.preventDefault(); nudgeVolume(5); break;
    case 'ArrowDown': e.preventDefault(); nudgeVolume(-5); break;
    case 'KeyF': toggleFullscreen(); break;
    case 'KeyL': toggleLike(); break;
    case 'KeyP': panel.open('library'); break;
    case 'KeyQ': panel.open('queue'); break;
  }
});

// 3秒触らなければ操作ボタンとカーソルを消す
let idleTimer = 0;
function wake() {
  body.classList.remove('idle');
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => body.classList.add('idle'), 3000);
}
for (const type of ['pointermove', 'pointerdown', 'keydown']) addEventListener(type, wake);
wake();

document.addEventListener('visibilitychange', () => {
  syncWakeLock();
  if (!document.hidden && body.dataset.view !== 'setup') kick(0);
});

// ---------- 起動 ----------

requestAnimationFrame(frame);

if (demo) {
  poll();
} else {
  const error = await auth.handleRedirect();
  if (error) {
    showSetup(error === 'access_denied'
      ? 'Spotifyの確認画面で許可されませんでした。もう一度ログインしてください。'
      : `ログインできませんでした（${error}）。Client ID と Redirect URI を確認してください。`);
  } else if (auth.isLoggedIn()) {
    poll();
    if (!auth.hasAllScopes()) toast('プレイリストやお気に入りを使うには、メニューを開いて「ログインし直す」を押してください。');
  } else {
    showSetup();
  }
}
