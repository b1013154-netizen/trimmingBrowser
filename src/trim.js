'use strict';
// 切り出し中のウィンドウ（セッション）の管理
//
// 切り出すと、選んだ範囲と同じ大きさの「枠のない小窓」（host）を作り、その中に元のページを表示する。
//  - 内蔵ブラウザ: ページの表示部品（WebContentsView）を小窓に移し、範囲の部分だけが見えるように
//    位置をずらして拡大率を合わせる。小窓の大きさを変えると、中身も同じ比率で拡大・縮小する。
//  - いつものブラウザ／開いている窓: その窓を小窓の子ウィンドウとして入れ、範囲の部分だけが見えるように
//    位置をずらす。小窓の大きさを変えると、元の窓も同じ比率で大きさを変える。
// どちらも中身は本物のページなので、クリック・再生・スクロールなどがそのまま使える。
const path = require('path');
const { BaseWindow, BrowserWindow, screen } = require('electron');
const win32 = require('./win32');
const shapes = require('./shapes');

const RENDERER = name => path.join(__dirname, 'renderer', name);
const PRELOAD = path.join(__dirname, 'preload.js');
const ICON = path.join(__dirname, '..', 'build', 'icon.png');
const BAR_H = 40;
const BAR_W = { pending: 290, trimmed: 540 };
const HIDE_DELAY = 700;
const MIN_HOST = 80;

const sessions = new Map(); // id → session
let ctx = null;             // main.js から渡される { config(), toast(msg, kind), saveFavorite(fav), changed() }
let timer = null;
let seq = 0;

function init(c) {
  ctx = c;
}

const isWin = win32.isWin;
// TB_TRACE=1 のとき、処理の途中経過を標準出力に同期で書く（異常終了の調査用）
const trace = t => { if (process.env.TB_TRACE) require('fs').writeSync(1, `   [trace] ${t}\n`); };
const toDip = r => (isWin ? screen.screenToDipRect(null, r) : r);
const dipRect = r => {
  const d = toDip({ x: r.x, y: r.y, width: r.w, height: r.h });
  return { x: d.x, y: d.y, w: d.width, h: d.height };
};
const fromBounds = b => ({ x: b.x, y: b.y, w: b.width, h: b.height });
const inside = (p, r, m = 0) => p.x >= r.x - m && p.x <= r.x + r.w + m && p.y >= r.y - m && p.y <= r.y + r.h + m;
const alive = w => w && !w.isDestroyed();

// ---------- 元の窓（ソース）の位置と大きさ ----------
// 内蔵ブラウザ: ページ表示部分（DIP）。それ以外: 窓全体（物理ピクセル）
function sourceRect(s) {
  if (s.browse) return fromBounds(s.browse.getContentBounds());
  return win32.rectOf(s.hwnd);
}
// 範囲選択画面に渡すための DIP の位置
function sourceDip(s) {
  const r = sourceRect(s);
  return r && (s.browse ? r : dipRect(r));
}

// ---------- セッション ----------
// target: { kind: 'chrome' | 'builtin' | 'window', hwnd?, url?, browse?: BaseWindow, view?: WebContentsView }
function create(target, opts = {}) {
  const g = ctx.config().general;
  const s = {
    id: `s${++seq}`,
    kind: target.kind,
    hwnd: target.hwnd || 0,
    browse: target.browse || null,
    view: target.view || null,
    url: target.url || '',
    state: 'pending',
    crop: null,       // 範囲（ソースの座標）
    src: null,        // 切り出したときのソースの大きさ { w, h }
    shape: opts.shape || g.defaultShape,
    opacity: opts.opacity ?? g.opacity,
    topmost: opts.topmost ?? g.topmost,
    clickThrough: false,
    host: null,
    adopted: null,    // 子ウィンドウとして入れる前の情報（元に戻す用）
    bar: null,
    overlay: null,
    lastShown: 0,
    drag: null,
    closing: false
  };
  sessions.set(s.id, s);
  if (s.browse) s.browse.on('closed', () => end(s, true));
  createBar(s);
  ensureTimer();
  ctx.changed();
  return s;
}

function titleOf(s) {
  if (s.view && !s.view.webContents.isDestroyed()) return s.view.webContents.getTitle();
  return isWin && win32.exists(s.hwnd) ? win32.info(s.hwnd).title : '';
}

function currentUrl(s) {
  if (s.view && !s.view.webContents.isDestroyed()) return s.view.webContents.getURL();
  return s.url;
}

function sourceAlive(s) {
  if (s.browse) return !s.browse.isDestroyed();
  return !isWin || win32.exists(s.hwnd);
}

// ---------- 切り出した小窓（host） ----------
// crop を表示する小窓を作る。bounds（DIP）を省くと、範囲があった場所に同じ大きさで出す
function trim(s, bounds) {
  const c = s.crop;
  const ratio = c.w / c.h;
  let b = bounds;
  if (!b) {
    const src = sourceRect(s);
    const r = { x: src.x + c.x, y: src.y + c.y, w: c.w, h: c.h };
    b = s.browse ? r : dipRect(r);
  }
  const w = Math.max(MIN_HOST, Math.round(b.w));
  const host = new BaseWindow({
    x: Math.round(b.x), y: Math.round(b.y), width: w, height: Math.round(w / ratio),
    frame: false, resizable: true, maximizable: false, fullscreenable: false, minimizable: true,
    hasShadow: false, backgroundColor: '#000000', show: false,
    title: titleOf(s) || 'TrimmingBrowser', icon: ICON
  });
  host.setAspectRatio(ratio);
  host.setMinimumSize(MIN_HOST, Math.max(30, Math.round(MIN_HOST / ratio)));
  s.host = host;
  s.shapeKey = null;

  if (s.view) {
    host.contentView.addChildView(s.view);
    s.browse.hide();
    // 別のサイトへ移ると拡大率が 100% に戻るので、そのたびに合わせ直す
    if (!s.zoomHook) {
      s.zoomHook = () => layout(s);
      s.view.webContents.on('did-navigate', s.zoomHook);
    }
  } else if (isWin) {
    s.adopted = win32.adopt(s.hwnd, win32.hwndOf(host));
  }
  layout(s);
  host.on('resize', () => layout(s));
  host.on('close', e => {
    // ユーザーが小窓を閉じた（Alt+F4 など）ときは「閉じる」と同じ扱いにする。
    // そのまま閉じると中に入れた他のアプリの窓まで壊れるので、先に元へ戻してから閉じる
    e.preventDefault();
    closeSession(s);
  });
  host.showInactive();
  if (s.view) s.view.webContents.invalidate();
  applyLook(s);
  s.state = 'trimmed';
  updateBar(s, true);
  ctx.changed();
}

// 小窓の大きさに合わせて、中身の位置と拡大率を決める
function layout(s) {
  trace('layout');
  // 窓の領域を変えると Windows から大きさ変更の通知が来て、また layout が呼ばれるので、入れ子にしない
  if (!alive(s.host) || !s.crop || s.inLayout) return;
  s.inLayout = true;
  try {
    layoutNow(s);
  } finally {
    s.inLayout = false;
  }
}

function layoutNow(s) {
  const c = s.crop;
  const size = s.host.getContentSize(); // DIP
  if (s.view) {
    const z = size[0] / c.w;
    trace(`view.setBounds z=${z}`);
    s.view.setBounds({ x: Math.round(-c.x * z), y: Math.round(-c.y * z), width: Math.round(s.src.w * z), height: Math.round(s.src.h * z) });
    trace('setZoomFactor');
    s.view.webContents.setZoomFactor(Math.min(5, Math.max(0.25, z)));
  } else if (isWin) {
    const cs = win32.clientSize(win32.hwndOf(s.host));
    const z = cs.w / c.w;
    win32.placeChild(s.hwnd, Math.round(-c.x * z), Math.round(-c.y * z), Math.round(s.src.w * z), Math.round(s.src.h * z));
  }
  trace('applyShape');
  applyShape(s);
  trace('layout done');
}

// 図形の形に小窓を切り抜く（四角形はそのまま）
function applyShape(s) {
  if (!alive(s.host)) return;
  if (!isWin) return; // Windows 以外（画面確認用）は四角形のまま
  const hwnd = win32.hwndOf(s.host);
  const cs = win32.clientSize(hwnd);
  // 図形と大きさが変わっていなければ設定し直さない
  const key = `${s.shape}:${cs.w}x${cs.h}:${JSON.stringify(s.crop)}`;
  if (key === s.shapeKey) return;
  s.shapeKey = key;
  if (s.shape === 'rect') return win32.clearRegion(hwnd);
  const k = cs.w / s.crop.w;
  const c = s.crop;
  const scaled = { shape: c.shape, x: 0, y: 0, w: cs.w, h: cs.h };
  if (c.points) scaled.points = c.points.map(p => [(p[0] - c.x) * k, (p[1] - c.y) * k]);
  win32.applyRegion(hwnd, scaled, shapes.polygonPoints, shapes.roundRadius);
}

function applyLook(s) {
  if (!alive(s.host)) return;
  s.host.setAlwaysOnTop(s.topmost, 'floating');
  s.host.setOpacity(s.opacity / 100);
  s.host.setIgnoreMouseEvents(s.clickThrough);
}

// 小窓をやめて、元の窓に戻す（窓は閉じない）
function untrim(s) {
  if (!s.host) return;
  const host = s.host;
  s.host = null;
  if (s.view && alive(s.browse)) {
    s.view.webContents.setZoomFactor(1);
    s.browse.contentView.addChildView(s.view);
    const [w, h] = s.browse.getContentSize();
    s.view.setBounds({ x: 0, y: 0, width: w, height: h });
    s.browse.show();
  } else if (s.adopted) {
    win32.release(s.hwnd, s.adopted);
    s.adopted = null;
  }
  if (alive(host)) host.destroy();
  s.state = 'pending';
}

// 保存してあった範囲・小窓の位置と大きさで切り出す（お気に入りを開いたとき）
function trimWith(s, crop, bounds) {
  const src = sourceRect(s);
  const c = src && shapes.normalizeCrop(crop, src.w, src.h);
  if (!c) {
    ctx.toast('保存した範囲がページからはみ出しています。範囲を選び直してください。', 'error');
    return select(s);
  }
  s.crop = c;
  s.shape = c.shape;
  s.src = { w: src.w, h: src.h };
  trim(s, bounds && onSomeScreen(bounds) ? { x: bounds.x, y: bounds.y, w: bounds.w || c.w } : null);
}

function onSomeScreen(r) {
  return screen.getAllDisplays().some(disp => {
    const a = disp.workArea;
    return r.x + 60 > a.x && r.x < a.x + a.width - 60 && r.y + 30 > a.y && r.y < a.y + a.height - 30;
  });
}

// ---------- 範囲選択 ----------
function select(s) {
  if (s.overlay) return;
  if (!sourceAlive(s)) return end(s, true);
  const prev = s.host ? fromBounds(s.host.getBounds()) : null;
  untrim(s);
  s.state = 'selecting';
  if (s.browse) s.browse.show();
  else win32.prepare(s.hwnd);
  if (alive(s.bar)) s.bar.hide();
  const src = sourceRect(s);
  const wd = sourceDip(s);
  const display = screen.getDisplayMatching({ x: wd.x, y: wd.y, width: wd.w, height: wd.h });
  const b = display.bounds;
  const overlay = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height,
    frame: false, transparent: true, resizable: false, movable: false, minimizable: false, maximizable: false,
    fullscreenable: false, skipTaskbar: true, hasShadow: false, alwaysOnTop: true, show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true }
  });
  overlay.setAlwaysOnTop(true, 'screen-saver');
  s.overlay = overlay;
  const ratio = src.w / wd.w; // DIP → ソースの座標
  overlay.tbInit = {
    sessionId: s.id,
    win: { x: wd.x - b.x, y: wd.y - b.y, w: wd.w, h: wd.h },
    shape: s.shape,
    shapes: shapes.SHAPES,
    crop: s.crop ? shapes.scaleCrop(s.crop, 1 / ratio) : null,
    title: titleOf(s)
  };
  overlay.tbFinish = result => {
    s.overlay = null;
    if (alive(overlay)) overlay.destroy();
    if (!sourceAlive(s)) return end(s, true);
    const now = sourceRect(s);
    let ok = false;
    if (result) {
      const crop = shapes.normalizeCrop(shapes.scaleCrop(result, ratio), now.w, now.h);
      if (crop) {
        s.crop = crop;
        s.shape = crop.shape;
        s.src = { w: now.w, h: now.h };
        ok = true;
      } else ctx.toast('範囲が小さすぎます。もう少し大きく囲んでください。', 'error');
    }
    // キャンセルしたときは、前に切り出していた状態に戻す
    if (ok) trim(s, prev ? { x: prev.x, y: prev.y, w: prev.w } : null);
    else if (prev && s.crop) trim(s, { x: prev.x, y: prev.y, w: prev.w });
    else {
      s.state = 'pending';
      updateBar(s, true);
      ctx.changed();
    }
  };
  overlay.on('closed', () => {
    if (s.overlay === overlay) overlay.tbFinish(null);
  });
  overlay.loadFile(RENDERER('select.html'));
  overlay.once('ready-to-show', () => {
    overlay.show();
    overlay.focus();
  });
}

// ---------- 操作バー ----------
function createBar(s) {
  const bar = new BrowserWindow({
    width: BAR_W.pending, height: BAR_H,
    frame: false, transparent: true, resizable: false, minimizable: false, maximizable: false, fullscreenable: false,
    skipTaskbar: true, hasShadow: false, alwaysOnTop: true, focusable: false, show: false,
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true }
  });
  bar.setAlwaysOnTop(true, 'screen-saver');
  bar.tbSessionId = s.id;
  bar.loadFile(RENDERER('bar.html'));
  bar.once('ready-to-show', () => updateBar(s, true));
  s.bar = bar;
}

function barState(s) {
  return {
    state: s.state,
    kind: s.kind,
    shape: s.shape,
    opacity: s.opacity,
    topmost: s.topmost,
    clickThrough: s.clickThrough,
    canFavorite: s.kind !== 'window' && !!currentUrl(s)
  };
}

// 操作の対象（切り出し中は小窓、切り出す前は元の窓）の位置（DIP）
function targetDip(s) {
  if (s.state === 'trimmed' && alive(s.host)) return fromBounds(s.host.getBounds());
  if (s.browse && alive(s.browse)) return fromBounds(s.browse.getBounds());
  const r = win32.rectOf(s.hwnd);
  return r && dipRect(r);
}

// バーの位置: 窓の真上（画面の上端に近ければ内側の上端）
function placeBar(s) {
  const d = targetDip(s);
  if (!d || !alive(s.bar)) return;
  const w = BAR_W[s.state === 'trimmed' ? 'trimmed' : 'pending'];
  const area = screen.getDisplayMatching({ x: d.x, y: d.y, width: d.w, height: d.h }).workArea;
  let x = Math.round(d.x + d.w / 2 - w / 2);
  x = Math.max(area.x, Math.min(area.x + area.width - w, x));
  let y = Math.round(d.y - BAR_H - 2);
  if (y < area.y) y = Math.round(d.y + 4);
  s.bar.setBounds({ x, y, width: w, height: BAR_H });
}

function updateBar(s, show) {
  if (!alive(s.bar)) return;
  s.bar.webContents.send('bar:state', barState(s));
  placeBar(s);
  if (show && s.state !== 'selecting') {
    s.bar.showInactive();
    s.lastShown = Date.now();
  }
}

// ---------- 監視（バーの表示・位置合わせ・窓が閉じられたか） ----------
function ensureTimer() {
  if (!timer) timer = setInterval(loop, 100);
}

function loop() {
  if (!sessions.size) {
    clearInterval(timer);
    timer = null;
    return;
  }
  const cursor = screen.getCursorScreenPoint();
  const autoHide = ctx.config().general.barAutoHide;
  for (const s of sessions.values()) {
    if (!sourceAlive(s)) {
      end(s, true);
      continue;
    }
    if (s.state === 'selecting' || !alive(s.bar)) continue;
    const d = targetDip(s);
    if (!d) continue;
    const key = `${d.x},${d.y},${d.w},${d.h}`;
    if (key !== s.lastRect) {
      s.lastRect = key;
      placeBar(s);
    }
    const minimized = s.state === 'trimmed' ? s.host.isMinimized() : false;
    const hover = !minimized && (inside(cursor, d) || inside(cursor, fromBounds(s.bar.getBounds()), 4));
    if (!minimized && (s.state === 'pending' || !autoHide || hover || s.drag)) {
      if (!s.bar.isVisible()) s.bar.showInactive();
      s.lastShown = Date.now();
    } else if (s.bar.isVisible() && (minimized || Date.now() - s.lastShown > HIDE_DELAY)) {
      s.bar.hide();
    }
  }
}

// ---------- バーの操作 ----------
function bySender(sender) {
  const w = BrowserWindow.fromWebContents(sender);
  return w && sessions.get(w.tbSessionId);
}

function action(s, name, value) {
  switch (name) {
    case 'select':
      return select(s);
    case 'topmost':
      s.topmost = !s.topmost;
      break;
    case 'opacity':
      s.opacity = Math.max(20, Math.min(100, Math.round(Number(value) || 100)));
      break;
    case 'clickThrough':
      return setClickThrough(s, !s.clickThrough);
    case 'size':
      return resizeBy(s, Number(value) || 1);
    case 'favorite':
      return saveFavorite(s);
    case 'restore':
      untrim(s);
      updateBar(s, true);
      ctx.changed();
      return;
    case 'close':
      return closeSession(s);
    default:
      return;
  }
  applyLook(s);
  updateBar(s, false);
  ctx.changed();
}

// 小窓を中心を保ったまま拡大・縮小する（バーの − / ＋）
function resizeBy(s, k) {
  trace('resizeBy');
  if (!alive(s.host)) return;
  const b = s.host.getBounds();
  const w = Math.max(MIN_HOST, Math.round(b.width * k));
  const h = Math.round(w * b.height / b.width);
  s.host.setBounds({ x: Math.round(b.x + (b.width - w) / 2), y: Math.round(b.y + (b.height - h) / 2), width: w, height: h });
  layout(s);
  placeBar(s);
}

function setClickThrough(s, on) {
  if (s.state !== 'trimmed') return;
  s.clickThrough = on;
  applyLook(s);
  updateBar(s, false);
  const key = ctx.config().general.hotkeyClick;
  ctx.toast(on ? `クリック透過をオンにしました。戻すときは操作バーのボタンか ${key} を押してください。` : 'クリック透過をオフにしました。', 'info');
}

// ホットキー: 切り出し中の小窓すべてのクリック透過を切り替える
function toggleClickThroughAll() {
  const list = [...sessions.values()].filter(s => s.state === 'trimmed');
  if (!list.length) return;
  const on = !list.some(s => s.clickThrough);
  for (const s of list) setClickThrough(s, on);
}

function saveFavorite(s) {
  const url = currentUrl(s);
  if (!url || !s.crop || !alive(s.host)) return;
  const b = s.host.getBounds();
  let host = '';
  try { host = new URL(url).hostname; } catch { /* URL が不正なら名前はタイトルだけにする */ }
  ctx.saveFavorite({
    name: (titleOf(s) || host).slice(0, 60),
    url,
    mode: s.kind,
    winW: s.src.w,
    winH: s.src.h,
    crop: s.crop,
    x: b.x,
    y: b.y,
    w: b.width,
    opacity: s.opacity,
    topmost: s.topmost
  });
}

function closeSession(s) {
  if (s.closing) return;
  s.closing = true;
  untrim(s);
  if (s.browse && alive(s.browse)) s.browse.destroy();
  else if (s.kind === 'chrome') win32.close(s.hwnd);
  end(s, false);
}

// セッションを終える（closed=true: 元の窓はもうない）
function end(s, closed) {
  if (!sessions.has(s.id)) return;
  sessions.delete(s.id);
  s.closing = true;
  if (closed) {
    if (alive(s.host)) s.host.destroy();
    s.host = null;
  } else untrim(s);
  if (alive(s.overlay)) s.overlay.destroy();
  if (alive(s.bar)) s.bar.destroy();
  ctx.changed();
}

// アプリ終了時: 切り出していた窓をすべて元に戻す（他のアプリの窓が小窓の中に残らないように）
function restoreAll() {
  for (const s of [...sessions.values()]) end(s, false);
}

// ---------- ドラッグ（バーのつまみで移動・右端のつまみで大きさ変更） ----------
function dragStart(s, p) {
  const d = targetDip(s);
  if (!d) return;
  s.drag = { mode: p.mode === 'resize' ? 'resize' : 'move', cx: p.x, cy: p.y, ...d };
}

function dragMove(s, p) {
  const d = s.drag;
  if (!d) return;
  const dx = p.x - d.cx;
  const dy = p.y - d.cy;
  if (s.state === 'trimmed' && alive(s.host)) {
    if (d.mode === 'resize') {
      const w = Math.max(MIN_HOST, Math.round(d.w + dx));
      s.host.setBounds({ x: d.x, y: d.y, width: w, height: Math.round(w * d.h / d.w) });
      layout(s);
    } else s.host.setPosition(Math.round(d.x + dx), Math.round(d.y + dy));
  } else if (s.browse) {
    s.browse.setPosition(Math.round(d.x + dx), Math.round(d.y + dy));
  } else if (d.mode === 'move') {
    const r = win32.rectOf(s.hwnd);
    const k = r.w / d.w;
    const start = s.drag.start || (s.drag.start = { x: r.x, y: r.y });
    win32.setBounds(s.hwnd, Math.round(start.x + dx * k), Math.round(start.y + dy * k));
  }
  placeBar(s);
}

function dragEnd(s) {
  s.drag = null;
}

function list() {
  return [...sessions.values()].map(s => ({ id: s.id, kind: s.kind, state: s.state, title: titleOf(s), url: currentUrl(s) }));
}

function findByHwnd(hwnd) {
  return [...sessions.values()].find(s => s.hwnd === hwnd);
}

module.exports = {
  init, create, select, trimWith, action, bySender, dragStart, dragMove, dragEnd, restoreAll,
  toggleClickThroughAll, list, findByHwnd, sessions
};
