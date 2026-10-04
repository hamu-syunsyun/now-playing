import * as auth from './auth.js';
import { paletteFrom, DEFAULT } from './color.js';
import { createPanel } from './panel.js';

const demo = new URLSearchParams(location.search).has('demo');
const source = await import(demo ? './demo.js' : './spotify.js');

const $ = (id) => document.getElementById(id);
const body = document.body;
const el = {
  art: $('art'), title: $('title'), artist: $('artist'), backdrop: $('backdrop'),
  lyrics: $('lyrics'), inner: $('lyricsInner'), note: $('lyricsNote'),
  seek: $('seek'), seekFill: $('seekFill'), seekKnob: $('seekKnob'),
  fill: $('barFill'), now: $('timeNow'), all: $('timeAll'),
  like: $('like'), toast: $('toast'),
};

const POLL_MS = 2000;
const ACTIVE_AT = 0.42; // いまの行を歌詞欄の上から何割の位置に置くか

let track = null;
let isPlaying = false;
let anchor = { progress: 0, at: 0 }; // 最後に確認した再生位置と、その時刻
let epoch = 0;                       // 操作のたびに増やし、操作前に出した問い合わせの結果を捨てる
let synced = null;                   // [{ t, text }] 時刻つき歌詞
let lineEls = [];
let activeIndex = -2;
let pollTimer = 0;
let endKicked = false;
let dragRatio = null;                // シークバーをつまんでいるあいだの位置（0〜1）
let shuffle = false;
let repeat = 'off';
let device = null;
let liked = false;

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

function setColors({ bg, fg, tone }) {
  body.style.setProperty('--bg', bg);
  body.style.setProperty('--fg', fg);
  body.dataset.tone = tone;
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

function showTrack(t) {
  track = t;
  document.title = t.artist ? `${t.title} – ${t.artist}` : t.title;
  el.title.textContent = t.title;
  el.artist.textContent = t.artist;
  el.all.textContent = fmt(t.duration);

  el.art.classList.remove('ready');
  if (t.art) {
    el.art.onload = () => {
      el.art.classList.add('ready');
      if (track === t) el.backdrop.style.backgroundImage = `url("${t.art}")`;
    };
    el.art.src = t.art;
    el.art.alt = `${t.title} のジャケット`;
    paletteFrom(t.art).then((p) => { if (track === t) setColors(p); });
  } else {
    el.art.removeAttribute('src');
    el.backdrop.style.backgroundImage = '';
    setColors(DEFAULT);
  }

  renderLyrics(null);
  source.getLyrics(t).then((l) => { if (track === t) renderLyrics(l); });

  paintLike(false);
  el.like.hidden = !fullAccess() || !t.hasLyrics; // ポッドキャストの回はお気に入りの対象外
  if (!el.like.hidden) source.isLiked(t).then((v) => { if (track === t) paintLike(v); }).catch(() => {});
}

function paintLike(v) {
  liked = v;
  el.like.setAttribute('aria-pressed', v);
  el.like.setAttribute('aria-label', v ? 'お気に入りから外す' : 'お気に入りに入れる');
}

function renderLyrics(l) {
  synced = l?.synced || null;
  lineEls = [];
  activeIndex = -2;
  el.inner.replaceChildren();
  el.inner.style.transform = '';
  el.lyrics.scrollTop = 0;
  el.note.textContent = l?.instrumental ? '歌のない曲です' : '';
  body.dataset.lyrics = synced ? 'synced' : l?.plain ? 'plain' : 'none';

  const lines = synced ? synced.map((s) => s.text || '♪') : l?.plain || [];
  for (const [i, text] of lines.entries()) {
    const p = document.createElement('p');
    p.className = 'line';
    p.textContent = text;
    if (synced) p.addEventListener('click', () => seekTo(synced[i].t));
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
  el.inner.style.transform = `translateY(${el.lyrics.clientHeight * ACTIVE_AT - center}px)`;
}

function frame() {
  if (track) {
    const pos = position();
    const ratio = dragRatio ?? (track.duration ? pos / track.duration : 0);
    el.seekFill.style.width = el.seekKnob.style.left = `${ratio * 100}%`;
    el.fill.style.transform = `scaleX(${ratio})`;
    el.now.textContent = fmt(dragRatio === null ? pos : dragRatio * track.duration);

    if (synced) {
      const i = currentLine(pos);
      if (i !== activeIndex) {
        lineEls[activeIndex]?.classList.remove('now');
        lineEls[i]?.classList.add('now');
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
    body.dataset.view = 'empty';
    body.classList.remove('playing');
    setColors(DEFAULT);
    document.title = '再生中';
    return;
  }
  body.dataset.view = 'player';
  if (pb.track.id !== track?.id) showTrack(pb.track);
  isPlaying = pb.isPlaying;
  anchor = { progress: pb.progress, at };
  shuffle = pb.shuffle;
  repeat = pb.repeat;
  device = pb.device;
  endKicked = false;
  body.classList.toggle('playing', isPlaying);
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

function toggleFullscreen() {
  if (document.fullscreenElement) document.exitFullscreen();
  else document.documentElement.requestFullscreen().catch(() => {});
}

const panel = createPanel({
  source,
  toast,
  messageFor,
  state: () => ({ shuffle, repeat, device }),
  changed: () => { epoch++; kick(500); },
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
