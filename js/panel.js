// メニュー（探す / ライブラリ / 次に再生 / 端末と音量）。再生画面の上に重ねて出す。

const TYPES = { Computer: 'パソコン', Smartphone: 'スマホ', Speaker: 'スピーカー', TV: 'テレビ', Tablet: 'タブレット' };
const REPEAT = { off: 'オフ', context: '全体', track: '1曲' };
const REPEAT_NEXT = { off: 'context', context: 'track', track: 'off' };

function h(tag, props = {}, ...children) {
  const node = Object.assign(document.createElement(tag), props);
  node.append(...children.filter((c) => c != null));
  return node;
}

// deps: { source, toast, state(), changed(), relogin(), messageFor(e) }
export function createPanel(deps) {
  const { source, toast } = deps;
  const sheet = document.getElementById('sheet');
  const body = document.getElementById('sheetBody');
  const tabs = [...document.querySelectorAll('#tabs [data-tab]')];
  let tab = 'search';
  let seq = 0; // 表示を切り替えたら、前の読み込み結果は捨てる

  const isOpen = () => !sheet.hidden;

  function open(name = tab) {
    sheet.hidden = false;
    show(name);
  }

  function close() {
    sheet.hidden = true;
    seq++;
    document.activeElement?.blur();
  }

  function show(name) {
    tab = name;
    seq++;
    for (const b of tabs) b.setAttribute('aria-selected', b.dataset.tab === name);
    body.replaceChildren();
    VIEWS[name]();
  }

  const note = (text) => h('p', { className: 'sheet-note', textContent: text });

  // 読み込み中の表示と、失敗したときの案内をまとめて面倒みる
  async function load(target, job) {
    const my = seq;
    target.replaceChildren(note('読み込み中…'));
    try {
      const nodes = await job();
      if (my === seq) target.replaceChildren(...nodes);
    } catch (e) {
      if (my !== seq) return;
      if (e.status === 401 || (e.status === 403 && /scope/i.test(e.message))) {
        target.replaceChildren(
          note('この機能はあとから足したので、Spotifyへの許可を取り直す必要があります。'),
          h('button', { className: 'chip solid', textContent: 'ログインし直す', onclick: deps.relogin }),
        );
      } else {
        target.replaceChildren(note(e.status === 403 || e.status === 404
          ? 'Spotify側の制限で、ここの中身は取り出せませんでした。'
          : '読み込めませんでした。通信状態を確認してください。'));
      }
    }
  }

  // 操作してから画面を閉じる、の共通部分
  async function run(job, done) {
    try {
      await job();
      if (done) toast(done);
    } catch (e) {
      toast(deps.messageFor(e));
    }
    deps.changed();
  }

  function row({ thumb, title, sub, onClick, action }) {
    const li = h('li', { className: 'row' },
      thumb ? h('img', { src: thumb, alt: '', loading: 'lazy' }) : thumb === '' ? h('span', { className: 'noimg' }) : null,
      h('div', { className: 'names' }, h('b', { textContent: title }), sub ? h('span', { textContent: sub }) : null),
    );
    if (action) {
      li.append(h('button', {
        className: 'chip', type: 'button', textContent: action.label,
        onclick: (e) => { e.stopPropagation(); action.onClick(); },
      }));
    }
    if (onClick) {
      li.tabIndex = 0;
      li.onclick = onClick;
      li.onkeydown = (e) => {
        if (e.key === 'Enter') onClick();
        else if (e.key === 'ArrowDown') { e.preventDefault(); li.nextElementSibling?.focus(); }
        else if (e.key === 'ArrowUp') { e.preventDefault(); li.previousElementSibling?.focus(); }
      };
    } else {
      li.classList.add('static');
    }
    return li;
  }

  const trackRow = (t, onClick) => row({
    thumb: t.thumb || t.art,
    title: t.title,
    sub: t.artist,
    onClick,
    action: { label: '次に再生', onClick: () => run(() => source.queueTrack(t), `「${t.title}」を次に再生します。`) },
  });

  const collectionRow = (c, back) => row({ thumb: c.thumb, title: c.title, sub: c.sub, onClick: () => showCollection(c, back) });

  const heading = (text) => h('h2', { className: 'sheet-heading', textContent: text });

  // ---------- アルバム・プレイリストの中身 ----------

  function showCollection(col, back) {
    seq++;
    const list = h('ul', { className: 'rows' });
    const more = h('div');
    const loaded = [];

    const playFrom = (t) => { close(); run(() => source.playCollection(col, t, loaded)); };

    async function page(offset) {
      const { tracks, next } = await source.getCollectionTracks(col, offset);
      loaded.push(...tracks);
      const rows = tracks.map((t) => trackRow(t, () => playFrom(t)));
      more.replaceChildren(next == null ? '' : h('button', {
        className: 'chip', textContent: '続きを読み込む',
        onclick: async () => {
          const my = seq;
          more.replaceChildren(note('読み込み中…'));
          try {
            const add = await page(next);
            if (my === seq) list.append(...add);
          } catch {
            if (my === seq) more.replaceChildren(note('続きを読み込めませんでした。'));
          }
        },
      }));
      return rows;
    }

    body.replaceChildren(
      h('div', { className: 'sheet-top' },
        h('button', { className: 'chip', textContent: '戻る', onclick: back }),
        h('b', { textContent: col.title }),
        h('button', { className: 'chip solid', textContent: '最初から再生', onclick: () => playFrom(null) }),
      ),
      list,
      more,
    );
    load(list, async () => {
      const rows = await page(0);
      return rows.length ? rows : [note('曲がありません。')];
    });
  }

  // ---------- 各タブ ----------

  const VIEWS = {
    search() {
      const input = h('input', {
        type: 'search', autocomplete: 'off', spellcheck: false, placeholder: '曲名、アーティスト名、アルバム名',
      });
      const out = h('div');
      let timer = 0;
      let last = '';

      const render = () => {
        clearTimeout(timer);
        const query = input.value.trim();
        if (query === last) return;
        last = query;
        seq++;
        if (!query) { out.replaceChildren(note('言葉を入れると候補が出ます。')); return; }
        timer = setTimeout(() => load(out, async () => {
          const r = await source.search(query);
          const back = () => { show('search'); const i = body.querySelector('input'); i.value = query; i.dispatchEvent(new Event('input')); };
          const nodes = [];
          if (r.tracks.length) {
            nodes.push(heading('曲'), h('ul', { className: 'rows' },
              ...r.tracks.map((t) => trackRow(t, () => { close(); run(() => source.playTrack(t)); }))));
          }
          if (r.albums.length) nodes.push(heading('アルバム'), h('ul', { className: 'rows' }, ...r.albums.map((c) => collectionRow(c, back))));
          if (r.playlists.length) nodes.push(heading('プレイリスト'), h('ul', { className: 'rows' }, ...r.playlists.map((c) => collectionRow(c, back))));
          return nodes.length ? nodes : [note('見つかりませんでした。言葉を変えて試してください。')];
        }), 300);
      };

      input.addEventListener('input', render);
      input.addEventListener('keydown', (e) => {
        if (e.isComposing) return; // 日本語変換を確定する Enter では動かさない
        if (e.key === 'Enter' || e.key === 'ArrowDown') { e.preventDefault(); out.querySelector('.row')?.focus(); }
      });
      body.append(h('div', { className: 'sheet-top' }, input), out);
      out.append(note('言葉を入れると候補が出ます。'));
      input.focus();
    },

    library() {
      const list = h('ul', { className: 'rows' });
      body.append(list);
      load(list, async () => (await source.getLibrary()).map((c) => collectionRow(c, () => show('library'))));
    },

    queue() {
      const s = deps.state();
      const shuffle = h('button', { className: 'chip', type: 'button' });
      const repeat = h('button', { className: 'chip', type: 'button' });
      let on = s.shuffle;
      let mode = s.repeat;
      const paint = () => {
        shuffle.textContent = `シャッフル：${on ? 'オン' : 'オフ'}`;
        shuffle.classList.toggle('solid', on);
        repeat.textContent = `リピート：${REPEAT[mode]}`;
        repeat.classList.toggle('solid', mode !== 'off');
      };
      shuffle.onclick = () => { on = !on; paint(); run(() => source.setShuffle(on)); };
      repeat.onclick = () => { mode = REPEAT_NEXT[mode]; paint(); run(() => source.setRepeat(mode)); };
      paint();

      const list = h('ul', { className: 'rows' });
      body.append(h('div', { className: 'sheet-top' }, shuffle, repeat), heading('このあと流れる曲'), list);
      load(list, async () => {
        const tracks = await source.getQueue();
        return tracks.length
          ? tracks.map((t) => row({ thumb: t.thumb || t.art, title: t.title, sub: t.artist }))
          : [note('このあとの曲はありません。')];
      });
    },

    device() {
      const box = h('div');
      body.append(box);
      load(box, async () => {
        const devices = await source.getDevices();
        if (!devices.length) return [note('Spotifyを開いている端末が見つかりません。スマホかPCでSpotifyアプリを開いてください。')];
        const active = devices.find((d) => d.active);
        const nodes = [];
        if (active?.canVolume) {
          const range = h('input', { type: 'range', min: 0, max: 100, value: active.volume, ariaLabel: '音量' });
          const label = h('span', { textContent: `${active.volume}` });
          range.oninput = () => { label.textContent = range.value; };
          range.onchange = () => run(() => source.setVolume(Number(range.value)));
          nodes.push(heading('音量'), h('div', { className: 'volume' }, range, label));
        } else if (active) {
          nodes.push(note('いまの端末は、ここから音量を変えられません（iPhoneなど）。本体のボタンで調整してください。'));
        }
        nodes.push(heading('鳴らす端末'), h('ul', { className: 'rows' }, ...devices.map((d) => row({
          title: d.name,
          sub: [TYPES[d.type] || d.type, d.active ? 'いま鳴っている端末' : ''].filter(Boolean).join('　'),
          onClick: d.active ? null : () => { close(); run(() => source.transfer(d.id), `${d.name} に切り替えました。`); },
        }))));
        return nodes;
      });
    },
  };

  VIEWS.lyrics = () => {
    if (!deps.state().hasSynced) {
      body.append(note('この曲には、歌に合わせて進む歌詞がありません。合わせられるのは、行ごとに時刻がついた歌詞だけです。'));
      return;
    }
    body.append(
      note('歌詞は LRCLIB という有志のデータベースのもので、Spotify の音源と数百ミリ秒〜数秒ずれていることがあります。ずれている曲は、歌詞を早めるか遅らせて合わせられます。合わせた値は曲ごとに覚えます。'),
      h('button', { className: 'chip solid', textContent: 'タイミングを合わせる', onclick: () => { close(); deps.tune(); } }),
      note('パソコンでは [ で遅らせ、] で早められます。'),
    );
  };

  for (const b of tabs) b.addEventListener('click', () => show(b.dataset.tab));
  document.getElementById('closeSheet').addEventListener('click', close);
  sheet.addEventListener('click', (e) => { if (e.target === sheet) close(); });

  return { open, close, isOpen };
}
