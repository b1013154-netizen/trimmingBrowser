'use strict';
// ホーム画面: URL を開いて切り出す／開いている窓から切り出す／お気に入り／設定／ヘルプ
const $ = (sel, root = document) => root.querySelector(sel);
const esc = s => String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const S = window.TBShapes;

let st = null; // main から受け取る状態 { config, sessions, browserFound, hotkeyErrors, platform, version }
const form = { url: '', mode: null, shape: null, w: null, h: null };
const SIZE_PRESETS = [
  { id: 's', label: '小', w: 640, h: 400 },
  { id: 'm', label: '中', w: 960, h: 600 },
  { id: 'l', label: '大', w: 1280, h: 800 }
];
const MODE_LABEL = { chrome: 'いつものブラウザ', builtin: '内蔵ブラウザ', window: '開いている窓' };

function shapeSvg(id) {
  const c = id === 'polygon'
    ? { shape: 'polygon', points: [[3, 20], [10, 3], [22, 7], [31, 2], [28, 22], [14, 24]] }
    : { shape: id, x: 2, y: 2, w: 30, h: 22 };
  if (c.points) Object.assign(c, S.boundsOf(c.points));
  return `<svg viewBox="0 0 34 26"><path d="${S.svgPath(c)}"/></svg>`;
}

// ---------- 共通 ----------
let snackTimer;
function snack(message, kind) {
  const el = $('#snack');
  el.textContent = message;
  el.className = `snack on ${kind === 'error' ? 'err' : kind === 'ok' ? 'ok' : ''}`;
  clearTimeout(snackTimer);
  snackTimer = setTimeout(() => el.classList.remove('on'), kind === 'error' ? 6000 : 3500);
}

function flashSaved() {
  const el = $('#saved');
  el.textContent = '保存しました';
  el.classList.add('flash');
  setTimeout(() => { el.textContent = '変更は自動で保存されます'; el.classList.remove('flash'); }, 1200);
}

function confirmBox(title, text, okLabel = 'OK', danger = false) {
  return new Promise(resolve => {
    const m = $('#modal');
    m.innerHTML = `<div class="modal"><h3>${esc(title)}</h3><p>${esc(text)}</p>
      <div class="actions"><button class="btn" data-r="0">キャンセル</button><button class="btn ${danger ? 'danger' : 'primary'}" data-r="1">${esc(okLabel)}</button></div></div>`;
    m.classList.add('on');
    m.onclick = e => {
      const b = e.target.closest('[data-r]');
      if (!b && e.target !== m) return;
      m.classList.remove('on');
      resolve(b ? b.dataset.r === '1' : false);
    };
  });
}

function showTab(id) {
  document.querySelectorAll('.nav').forEach(n => n.classList.toggle('on', n.dataset.tab === id));
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('on', t.id === `tab-${id}`));
  if (id === 'windows') refreshWindows();
  if (id === 'help') renderHelp();
}

// ---------- 開いて切り出す ----------
function renderOpen() {
  const g = st.config.general;
  form.mode ??= g.defaultMode;
  form.shape ??= g.defaultShape;
  form.w ??= g.windowW;
  form.h ??= g.windowH;
  const preset = SIZE_PRESETS.find(p => p.w === form.w && p.h === form.h);
  const noBrowser = st.platform === 'win32' && !st.browserFound;
  $('#tab-open').innerHTML = `
    <h1>開いて切り出す</h1>
    <p class="lead">ページを枠なしの小窓で開き、見たい部分だけを好きな形で切り出します。</p>
    <div class="card">
      <h2>開くページ</h2>
      <p class="hint">YouTube に限らず、どのサイトでも使えます。</p>
      <div class="url-row">
        <input type="url" id="url" list="recent" placeholder="https://www.youtube.com/" value="${esc(form.url)}">
        <datalist id="recent">${st.config.recentUrls.map(u => `<option value="${esc(u)}">`).join('')}</datalist>
        <button class="btn primary" id="go">開く</button>
      </div>
      <label class="field-label">開き方</label>
      <div class="modes">
        <button class="mode ${form.mode === 'chrome' ? 'on' : ''}" data-mode="chrome"><span class="mi">🔐</span><span>
          <b>いつものブラウザ（ログインしたまま）</b>
          <small>${st.browserFound ? esc(st.browserFound) : 'Chrome / Edge'} を、タブとアドレスバーのない窓で開きます。ログイン状態・拡張機能・広告ブロックはそのまま使えます。</small>
          ${noBrowser ? '<small class="warn">Chrome / Edge が見つかりません。設定で場所を指定してください。</small>' : ''}
        </span></button>
        <button class="mode ${form.mode === 'builtin' ? 'on' : ''}" data-mode="builtin"><span class="mi">🧭</span><span>
          <b>内蔵ブラウザ（ログインなし）</b>
          <small>このアプリの中のブラウザで開きます。いつものブラウザとは履歴・ログインを共有しません。Google アカウントはログインできない場合があります。</small>
        </span></button>
      </div>
      <label class="field-label">切り出す図形（あとで変えられます）</label>
      <div class="shapes">${S.SHAPES.map(s => `<button class="shape ${form.shape === s.id ? 'on' : ''}" data-shape="${s.id}">${shapeSvg(s.id)}${esc(s.label)}</button>`).join('')}</div>
      <label class="field-label">開くウィンドウの大きさ（中身の大きさの目安）</label>
      <div class="sizes">
        <div class="seg">${SIZE_PRESETS.map(p => `<button data-size="${p.id}" class="${preset && preset.id === p.id ? 'on' : ''}">${p.label} ${p.w}×${p.h}</button>`).join('')}</div>
        <input type="number" id="w" min="200" max="7680" value="${form.w}"> × <input type="number" id="h" min="150" max="4320" value="${form.h}">
      </div>
    </div>
    <div class="card">
      <h2>使い方</h2>
      <div class="steps-mini">
        <div><b>1. 開く</b>URL を入れて「開く」。ページが小窓で開きます。</div>
        <div><b>2. 準備</b>動画の再生や全画面化など、見たい部分が映る状態にします。</div>
        <div><b>3. 切り出す</b>窓の上の「✂ 範囲を選ぶ」を押し、ドラッグで囲みます。</div>
      </div>
    </div>
    ${renderSessions()}`;
  const urlInput = $('#url');
  urlInput.oninput = () => { form.url = urlInput.value; };
  urlInput.onkeydown = e => { if (e.key === 'Enter') go(); };
  $('#go').onclick = go;
  document.querySelectorAll('[data-mode]').forEach(b => { b.onclick = () => { form.mode = b.dataset.mode; renderOpen(); }; });
  document.querySelectorAll('#tab-open [data-shape]').forEach(b => { b.onclick = () => { form.shape = b.dataset.shape; renderOpen(); }; });
  document.querySelectorAll('[data-size]').forEach(b => {
    b.onclick = () => { const p = SIZE_PRESETS.find(x => x.id === b.dataset.size); form.w = p.w; form.h = p.h; renderOpen(); };
  });
  $('#w').onchange = e => { form.w = Number(e.target.value); renderOpen(); };
  $('#h').onchange = e => { form.h = Number(e.target.value); renderOpen(); };
  bindSessions();
}

async function go() {
  const btn = $('#go');
  btn.disabled = true;
  btn.textContent = '開いています…';
  const r = await window.tb.invoke('home:open', { url: form.url, mode: form.mode, w: form.w, h: form.h, shape: form.shape });
  btn.disabled = false;
  btn.textContent = '開く';
  if (!r.ok) snack(r.message, 'error');
}

function renderSessions() {
  if (!st.sessions.length) return '';
  const stateLabel = { pending: '範囲を選ぶ前', selecting: '範囲を選択中', trimmed: '切り出し中' };
  return `<div class="card">
    <div class="row" style="margin:0 0 10px"><h2 style="margin:0">いま開いている切り出し</h2><span style="flex:1"></span><button class="btn small" id="restoreAll">すべて元に戻す</button></div>
    <div class="list">${st.sessions.map(s => `<div class="item"><div class="t"><b>${esc(s.title || s.url || '（無題）')}</b>
      <small><span class="badge ${s.kind}">${MODE_LABEL[s.kind]}</span>${esc(stateLabel[s.state] || '')}</small></div></div>`).join('')}</div></div>`;
}

function bindSessions() {
  const b = $('#restoreAll');
  if (b) b.onclick = () => window.tb.invoke('home:restoreAll');
}

// ---------- 開いている窓から ----------
async function refreshWindows() {
  const el = $('#tab-windows');
  const list = st.platform === 'win32' ? await window.tb.invoke('home:windows') : [];
  const key = st.config.general.hotkeyTrim;
  el.innerHTML = `
    <h1>開いている窓から切り出す</h1>
    <p class="lead">いま開いているウィンドウ（ブラウザ・動画プレーヤー・他のアプリ）をそのまま切り出します。</p>
    <div class="card">
      <div class="row" style="margin:0 0 10px"><h2 style="margin:0">ウィンドウの一覧</h2><span style="flex:1"></span><button class="btn small" id="reload">↻ 更新</button></div>
      <p class="hint">${key ? `切り出したいウィンドウを前面にして <span class="kbd">${esc(key)}</span> を押しても切り出せます。` : ''}</p>
      ${list.length ? `<div class="list">${list.map(w => `<div class="item"><div class="t"><b>${esc(w.title)}</b><small>${esc(w.cls)}</small></div>
        <button class="btn small primary" data-hwnd="${w.hwnd}">✂ 切り出す</button></div>`).join('')}</div>`
        : `<div class="empty"><div class="big">🪟</div>${st.platform === 'win32' ? '切り出せるウィンドウがありません。' : 'この機能は Windows でのみ使えます。'}</div>`}
    </div>`;
  $('#reload').onclick = refreshWindows;
  el.querySelectorAll('[data-hwnd]').forEach(b => {
    b.onclick = async () => {
      const r = await window.tb.invoke('home:trimWindow', Number(b.dataset.hwnd));
      if (!r.ok) snack(r.message, 'error');
    };
  });
}

// ---------- お気に入り ----------
let editing = null;
function renderFavorites() {
  const favs = st.config.favorites;
  $('#tab-favorites').innerHTML = `
    <h1>お気に入り</h1>
    <p class="lead">ページ・開き方・ウィンドウの大きさ・切り出した範囲と図形・画面上の位置をまとめて覚えておき、ワンクリックで同じ表示を再現します。</p>
    <div class="card">
      ${favs.length ? `<div class="list">${favs.map((f, i) => `<div class="item" data-id="${f.id}">
        <div class="ic">${shapeSvg(f.crop.shape)}</div>
        <div class="t">${editing === f.id ? `<input type="text" class="name-edit" value="${esc(f.name)}" maxlength="60">` : `<b>${esc(f.name)}</b>`}
          <small><span class="badge ${f.mode}">${MODE_LABEL[f.mode]}</span>${esc(f.url)}</small></div>
        <button class="btn small primary" data-act="open">開く</button>
        <button class="icon-btn" data-act="rename" title="名前を変える">✎</button>
        <button class="icon-btn" data-act="up" title="上へ" ${i === 0 ? 'disabled' : ''}>↑</button>
        <button class="icon-btn" data-act="down" title="下へ" ${i === favs.length - 1 ? 'disabled' : ''}>↓</button>
        <button class="icon-btn danger" data-act="delete" title="削除">🗑</button>
      </div>`).join('')}</div>`
        : `<div class="empty"><div class="big">★</div>まだありません。<br>切り出した窓にマウスを乗せると出る操作バーの「★」で追加できます。</div>`}
    </div>
    <p class="hint" style="color:var(--ink-3);font-size:12.5px">タスクトレイのアイコンを右クリック →「お気に入り」からも開けます。</p>`;
  document.querySelectorAll('#tab-favorites .item').forEach(row => {
    const id = row.dataset.id;
    const f = favs.find(x => x.id === id);
    const input = row.querySelector('.name-edit');
    if (input) {
      input.focus();
      input.select();
      const commit = async () => { editing = null; await window.tb.invoke('home:renameFavorite', id, input.value); flashSaved(); };
      input.onkeydown = e => { if (e.key === 'Enter') commit(); if (e.key === 'Escape') { editing = null; renderFavorites(); } };
      input.onblur = commit;
    }
    row.querySelectorAll('[data-act]').forEach(b => {
      b.onclick = async () => {
        const act = b.dataset.act;
        if (act === 'open') {
          const r = await window.tb.invoke('home:openFavorite', id);
          if (!r.ok) snack(r.message, 'error');
        } else if (act === 'rename') {
          editing = id;
          renderFavorites();
        } else if (act === 'up' || act === 'down') {
          await window.tb.invoke('home:moveFavorite', id, act === 'up' ? -1 : 1);
        } else if (act === 'delete') {
          if (await confirmBox('お気に入りを削除しますか？', `「${f.name}」を削除します。元に戻せません。`, '削除する', true)) {
            await window.tb.invoke('home:deleteFavorite', id);
            snack('削除しました');
          }
        }
      };
    });
  });
}

// ---------- 設定 ----------
function renderSettings() {
  const g = st.config.general;
  const sw = (key, label) => `<label class="switch"><input type="checkbox" data-key="${key}" ${g[key] ? 'checked' : ''}><span class="track"></span>${esc(label)}</label>`;
  $('#tab-settings').innerHTML = `
    <h1>設定</h1>
    <p class="lead">変更はすぐに保存され、次に開く窓から反映されます。</p>
    ${st.hotkeyErrors.length ? `<div class="note err" style="margin-bottom:14px">${st.hotkeyErrors.map(esc).join('<br>')}</div>` : ''}
    <div class="card">
      <h2>ブラウザ</h2>
      <p class="hint">「いつものブラウザ」で開くときに使うブラウザです。</p>
      <div class="row"><label class="k">使うブラウザ</label>
        <div class="seg" data-seg="browser">
          ${[['auto', '自動（Chrome → Edge）'], ['chrome', 'Chrome'], ['edge', 'Edge'], ['custom', '場所を指定']].map(([v, l]) => `<button data-v="${v}" class="${g.browser === v ? 'on' : ''}">${l}</button>`).join('')}
        </div></div>
      ${g.browser === 'custom' ? `<div class="row"><label class="k">exe の場所</label><input type="text" class="grow" data-key="browserPath" value="${esc(g.browserPath)}" placeholder="C:\\Program Files\\...\\chrome.exe"><button class="btn small" id="pick">参照…</button></div>` : ''}
      <div class="row"><label class="k">見つかったブラウザ</label><span>${st.browserFound ? esc(st.browserFound) : '<span style="color:var(--danger)">見つかりません</span>'}</span></div>
      <div class="row"><label class="k">最初に選ぶ開き方</label>
        <div class="seg" data-seg="defaultMode">
          <button data-v="chrome" class="${g.defaultMode === 'chrome' ? 'on' : ''}">いつものブラウザ</button>
          <button data-v="builtin" class="${g.defaultMode === 'builtin' ? 'on' : ''}">内蔵ブラウザ</button>
        </div></div>
    </div>
    <div class="card">
      <h2>切り出した窓</h2>
      <div class="row"><label class="k">最初に選ぶ図形</label>
        <select data-key="defaultShape" style="width:200px">${S.SHAPES.map(s => `<option value="${s.id}" ${g.defaultShape === s.id ? 'selected' : ''}>${esc(s.label)}</option>`).join('')}</select></div>
      <div class="row"><label class="k">不透明度</label><input type="range" min="20" max="100" step="5" data-key="opacity" value="${g.opacity}"><span class="val" id="opv">${g.opacity}%</span></div>
      <div class="row"><label class="k">表示</label>${sw('topmost', '常に最前面にする')}</div>
      <div class="row"><label class="k">操作バー</label>${sw('barAutoHide', 'マウスを乗せたときだけ表示する')}</div>
      <div class="row"><label class="k">お気に入りの待ち時間</label><input type="number" min="0" max="30000" step="500" data-key="loadWaitMs" value="${g.loadWaitMs}"> ミリ秒
        <span class="hint" style="margin:0">いつものブラウザで開いたあと、ページの表示を待ってから切り出します。</span></div>
    </div>
    <div class="card">
      <h2>ショートカットキー</h2>
      <p class="hint">例: Ctrl+Alt+X。空にすると使いません。</p>
      <div class="row"><label class="k">前面の窓を切り出す</label><input type="text" data-key="hotkeyTrim" value="${esc(g.hotkeyTrim)}" style="width:200px"></div>
      <div class="row"><label class="k">クリック透過の切り替え</label><input type="text" data-key="hotkeyClick" value="${esc(g.hotkeyClick)}" style="width:200px"></div>
    </div>`;
  const set = async patch => {
    st = await window.tb.invoke('home:setGeneral', patch);
    flashSaved();
    renderAll();
  };
  document.querySelectorAll('#tab-settings [data-seg]').forEach(seg => {
    seg.querySelectorAll('button').forEach(b => { b.onclick = () => set({ [seg.dataset.seg]: b.dataset.v }); });
  });
  document.querySelectorAll('#tab-settings [data-key]').forEach(el => {
    const key = el.dataset.key;
    if (el.type === 'range') el.oninput = () => { $('#opv').textContent = `${el.value}%`; };
    el.onchange = () => set({ [key]: el.type === 'checkbox' ? el.checked : (el.type === 'number' || el.type === 'range') ? Number(el.value) : el.value });
  });
  const pick = $('#pick');
  if (pick) pick.onclick = async () => { const p = await window.tb.invoke('home:pickBrowser'); if (p) set({ browserPath: p }); };
}

// ---------- ヘルプ ----------
let helpLoaded = false;
async function renderHelp() {
  if (helpLoaded) return;
  const r = await window.tb.invoke('docs:read', 'manual');
  const el = $('#tab-help');
  if (!r.ok) { el.innerHTML = `<div class="note err">${esc(r.message)}</div>`; return; }
  const { html, headings } = window.TBMarkdown.render(r.text);
  el.innerHTML = `<div class="doc-layout">
    <div class="card doc-card"><div class="doc">${html}</div></div>
    <nav class="doc-toc"><div class="doc-toc-title">目次</div>${headings.map(h => `<a data-to="${h.id}">${esc(h.text)}</a>`).join('')}
      <button class="btn small" id="extDoc" style="margin:12px 10px 0">メモ帳などで開く</button></nav></div>`;
  el.querySelectorAll('[data-to]').forEach(a => { a.onclick = () => document.getElementById(a.dataset.to).scrollIntoView({ behavior: 'smooth' }); });
  $('#extDoc').onclick = () => window.tb.invoke('docs:openExternal', 'manual');
  helpLoaded = true;
}

// ---------- 全体 ----------
function renderAll() {
  // URL を入力中は入力欄を作り直さない（文字が消えないように）
  if (document.activeElement?.id !== 'url') renderOpen();
  if (!document.querySelector('#tab-favorites .name-edit')) renderFavorites();
  if (!document.querySelector('#tab-settings :focus')) renderSettings();
  $('#version').textContent = `バージョン ${st.version}`;
}

document.querySelectorAll('.nav').forEach(n => { n.onclick = () => showTab(n.dataset.tab); });
window.tb.on('state', s => { st = s; renderAll(); });
window.tb.on('toast', t => snack(t.message, t.kind));
window.tb.on('show-tab', showTab);

(async () => {
  st = await window.tb.invoke('home:state');
  renderAll();
  const tab = new URLSearchParams(location.search).get('tab');
  if (tab) showTab(tab);
})();
