'use strict';
// 切り出し中のウィンドウ（セッション）の管理
//  - 範囲選択画面を出して、選んだ図形でウィンドウそのものを切り抜く（中身はそのまま操作できる）
//  - 切り抜いたウィンドウの上に、マウスを乗せたときだけ操作バーを出す
//  - 最前面・不透明度・クリック透過・移動・選び直し・お気に入り保存・元に戻す
const path = require('path');
const { BrowserWindow, screen } = require('electron');
const win32 = require('./win32');
const shapes = require('./shapes');

const RENDERER = name => path.join(__dirname, 'renderer', name);
const PRELOAD = path.join(__dirname, 'preload.js');
const BAR_H = 40;
const BAR_W = { pending: 250, trimmed: 438 };
const HIDE_DELAY = 700;

const sessions = new Map(); // id → session
let ctx = null;             // main.js から渡される { config(), ownPid, toast(msg, kind), saveFavorite(fav), changed() }
let timer = null;
let tick = 0;
let seq = 0;

function init(c) {
  ctx = c;
}

// ---------- 座標 ----------
const isWin = win32.isWin;
const toDip = r => (isWin ? screen.screenToDipRect(null, r) : r);
const toScreen = r => (isWin ? screen.dipToScreenRect(null, r) : r);

function windowRect(s) {
  if (s.builtin && !isWin) {
    const b = s.builtin.getBounds();
    return { x: b.x, y: b.y, w: b.width, h: b.height };
  }
  return win32.rectOf(s.hwnd);
}

// 切り抜いた部分の画面上の位置（物理ピクセル）
function cropScreenRect(s) {
  const wr = windowRect(s);
  if (!wr || !s.crop) return wr;
  return { x: wr.x + s.crop.x, y: wr.y + s.crop.y, w: s.crop.w, h: s.crop.h };
}

const dipRect = r => {
  const d = toDip({ x: r.x, y: r.y, width: r.w, height: r.h });
  return { x: d.x, y: d.y, w: d.width, h: d.height };
};
const inside = (p, r, m = 0) => p.x >= r.x - m && p.x <= r.x + r.w + m && p.y >= r.y - m && p.y <= r.y + r.h + m;

// ---------- セッション ----------
// target: { hwnd, kind: 'chrome' | 'builtin' | 'window', url?, builtin?: BrowserWindow }
function create(target, opts = {}) {
  const g = ctx.config().general;
  const s = {
    id: `s${++seq}`,
    hwnd: target.hwnd,
    kind: target.kind,
    url: target.url || '',
    builtin: target.builtin || null,
    state: 'pending',
    crop: null,
    shape: opts.shape || g.defaultShape,
    opacity: opts.opacity ?? g.opacity,
    topmost: opts.topmost ?? g.topmost,
    clickThrough: false,
    origEx: win32.getExStyle(target.hwnd),
    origTopmost: win32.isTopmost(target.hwnd),
    bar: null,
    overlay: null,
    lastShown: 0,
    drag: null,
    lastRect: null
  };
  sessions.set(s.id, s);
  if (s.builtin) s.builtin.on('closed', () => end(s, true));
  createBar(s);
  ensureTimer();
  ctx.changed();
  return s;
}

function titleOf(s) {
  if (s.builtin && !s.builtin.isDestroyed()) return s.builtin.webContents.getTitle();
  return isWin && win32.exists(s.hwnd) ? win32.info(s.hwnd).title : '';
}

function currentUrl(s) {
  if (s.builtin && !s.builtin.isDestroyed()) return s.builtin.webContents.getURL();
  return s.url;
}

// ---------- 切り抜き ----------
function applyCrop(s) {
  if (!s.crop) return;
  win32.applyRegion(s.hwnd, s.crop, shapes.polygonPoints, shapes.roundRadius);
  win32.setTopmost(s.hwnd, s.topmost);
  win32.setLook(s.hwnd, s.origEx, s.opacity, s.clickThrough);
  if (s.builtin && !isWin) s.builtin.setAlwaysOnTop(s.topmost);
}

// 切り抜きを外して元のウィンドウに戻す（ウィンドウは閉じない）
function uncrop(s) {
  if (!win32.exists(s.hwnd) && isWin) return;
  win32.clearRegion(s.hwnd);
  win32.restoreLook(s.hwnd, s.origEx);
  win32.setTopmost(s.hwnd, s.origTopmost);
}

// 保存してあった範囲・位置で切り抜く（お気に入りを開いたとき）
function trimWith(s, crop, pos) {
  const wr = windowRect(s);
  const c = wr && shapes.normalizeCrop(crop, wr.w, wr.h);
  if (!c) {
    ctx.toast('保存した範囲がウィンドウからはみ出しています。範囲を選び直してください。', 'error');
    return select(s);
  }
  s.crop = c;
  s.shape = c.shape;
  s.state = 'trimmed';
  if (pos && onSomeScreen({ x: pos.x, y: pos.y, w: c.w, h: c.h })) win32.setBounds(s.hwnd, pos.x - c.x, pos.y - c.y);
  applyCrop(s);
  updateBar(s, true);
  ctx.changed();
}

function onSomeScreen(r) {
  const d = dipRect(r);
  return screen.getAllDisplays().some(disp => {
    const a = disp.workArea;
    return d.x + 60 > a.x && d.x < a.x + a.width - 60 && d.y + 30 > a.y && d.y < a.y + a.height - 30;
  });
}

// ---------- 範囲選択 ----------
function select(s) {
  if (s.overlay) return;
  if (!win32.exists(s.hwnd) && isWin) return end(s, true);
  s.state = 'selecting';
  uncrop(s);
  win32.prepare(s.hwnd);
  if (s.bar) s.bar.hide();
  const wr = windowRect(s);
  const wd = dipRect(wr);
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
  const ratio = wr.w / wd.w;
  const toWin = { x: wd.x - b.x, y: wd.y - b.y, w: wd.w, h: wd.h }; // 選択画面の中でのウィンドウの位置（DIP）
  overlay.tbInit = {
    sessionId: s.id,
    win: toWin,
    shape: s.shape,
    shapes: shapes.SHAPES,
    // 選び直しのときは今の範囲を表示しておく
    crop: s.crop ? shapes.scaleCrop(s.crop, 1 / ratio) : null,
    title: titleOf(s)
  };
  overlay.tbFinish = result => {
    s.overlay = null;
    if (!overlay.isDestroyed()) overlay.destroy();
    if (result) {
      const crop = shapes.normalizeCrop(shapes.scaleCrop(result, ratio), wr.w, wr.h);
      if (crop) {
        s.crop = crop;
        s.shape = crop.shape;
      } else ctx.toast('範囲が小さすぎます。もう少し大きく囲んでください。', 'error');
    }
    s.state = s.crop ? 'trimmed' : 'pending';
    if (s.state === 'trimmed') applyCrop(s);
    updateBar(s, true);
    ctx.changed();
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

// バーの位置: 切り抜いた部分の真上（画面の上端に近ければ内側の上端）
function placeBar(s) {
  const r = s.state === 'trimmed' ? cropScreenRect(s) : windowRect(s);
  if (!r || !s.bar || s.bar.isDestroyed()) return;
  const d = dipRect(r);
  const w = BAR_W[s.state === 'trimmed' ? 'trimmed' : 'pending'];
  const area = screen.getDisplayMatching({ x: d.x, y: d.y, width: d.w, height: d.h }).workArea;
  let x = Math.round(d.x + d.w / 2 - w / 2);
  x = Math.max(area.x, Math.min(area.x + area.width - w, x));
  let y = Math.round(d.y - BAR_H - 2);
  if (y < area.y) y = Math.round(d.y + 4);
  s.bar.setBounds({ x, y, width: w, height: BAR_H });
}

function updateBar(s, show) {
  if (!s.bar || s.bar.isDestroyed()) return;
  s.bar.webContents.send('bar:state', barState(s));
  placeBar(s);
  if (show && s.state !== 'selecting') {
    s.bar.showInactive();
    s.lastShown = Date.now();
  }
}

// ---------- 監視（バーの表示・位置合わせ・切り抜きの維持・ウィンドウが閉じられたか） ----------
function ensureTimer() {
  if (!timer) timer = setInterval(loop, 100);
}

function loop() {
  tick++;
  if (!sessions.size) {
    clearInterval(timer);
    timer = null;
    return;
  }
  const cursor = screen.getCursorScreenPoint();
  const autoHide = ctx.config().general.barAutoHide;
  for (const s of sessions.values()) {
    if (isWin && !win32.exists(s.hwnd)) {
      end(s, true);
      continue;
    }
    if (s.state === 'selecting' || !s.bar || s.bar.isDestroyed()) continue;
    // ブラウザが自分で切り抜きを外すことがあるので、外れていたら付け直す
    if (s.state === 'trimmed' && tick % 5 === 0 && !win32.hasRegion(s.hwnd)) applyCrop(s);
    const r = s.state === 'trimmed' ? cropScreenRect(s) : windowRect(s);
    if (!r) continue;
    const key = `${r.x},${r.y},${r.w},${r.h}`;
    if (key !== s.lastRect) {
      s.lastRect = key;
      placeBar(s);
    }
    const hover = inside(cursor, dipRect(r)) || inside(cursor, rectOfBar(s), 4);
    if (s.state === 'pending' || !autoHide || hover || s.drag) {
      if (!s.bar.isVisible()) s.bar.showInactive();
      s.lastShown = Date.now();
    } else if (s.bar.isVisible() && Date.now() - s.lastShown > HIDE_DELAY) {
      s.bar.hide();
    }
  }
}

function rectOfBar(s) {
  const b = s.bar.getBounds();
  return { x: b.x, y: b.y, w: b.width, h: b.height };
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
      win32.setTopmost(s.hwnd, s.topmost);
      if (s.builtin && !isWin) s.builtin.setAlwaysOnTop(s.topmost);
      break;
    case 'opacity':
      s.opacity = Math.max(20, Math.min(100, Math.round(Number(value) || 100)));
      win32.setLook(s.hwnd, s.origEx, s.opacity, s.clickThrough);
      break;
    case 'clickThrough':
      setClickThrough(s, !s.clickThrough);
      break;
    case 'favorite':
      return saveFavorite(s);
    case 'restore':
      uncrop(s);
      s.crop = null;
      s.state = 'pending';
      break;
    case 'close':
      return closeSession(s);
    default:
      return;
  }
  updateBar(s, false);
  ctx.changed();
}

function setClickThrough(s, on) {
  s.clickThrough = on;
  win32.setLook(s.hwnd, s.origEx, s.opacity, s.clickThrough);
  updateBar(s, false);
  const key = ctx.config().general.hotkeyClick;
  ctx.toast(on ? `クリック透過をオンにしました。戻すときは操作バーのボタンか ${key} を押してください。` : 'クリック透過をオフにしました。', 'info');
}

// ホットキー: 切り抜き中のウィンドウすべてのクリック透過を切り替える
function toggleClickThroughAll() {
  const list = [...sessions.values()].filter(s => s.state === 'trimmed');
  if (!list.length) return;
  const on = !list.some(s => s.clickThrough);
  for (const s of list) setClickThrough(s, on);
}

function saveFavorite(s) {
  const url = currentUrl(s);
  const wr = windowRect(s);
  if (!url || !wr || !s.crop) return;
  const pos = cropScreenRect(s);
  let host = '';
  try { host = new URL(url).hostname; } catch { /* URL が不正なら名前はタイトルだけにする */ }
  ctx.saveFavorite({
    name: (titleOf(s) || host).slice(0, 60),
    url,
    mode: s.kind,
    winW: wr.w,
    winH: wr.h,
    crop: s.crop,
    x: pos.x,
    y: pos.y,
    opacity: s.opacity,
    topmost: s.topmost
  });
}

function closeSession(s) {
  uncrop(s);
  if (s.builtin && !s.builtin.isDestroyed()) s.builtin.close();
  else if (s.kind === 'chrome') win32.close(s.hwnd);
  end(s, false);
}

// セッションを終える（closed=true: ウィンドウはもうない）
function end(s, closed) {
  if (!sessions.has(s.id)) return;
  sessions.delete(s.id);
  if (!closed) uncrop(s);
  if (s.overlay && !s.overlay.isDestroyed()) s.overlay.destroy();
  if (s.bar && !s.bar.isDestroyed()) s.bar.destroy();
  ctx.changed();
}

// アプリ終了時: 切り抜いたウィンドウをすべて元に戻す（ブラウザが切り抜かれたまま残らないように）
function restoreAll() {
  for (const s of [...sessions.values()]) end(s, false);
}

// ドラッグで移動（操作バーのつまみ）
function dragStart(s, p) {
  const wr = windowRect(s);
  if (!wr) return;
  s.drag = { cx: p.x, cy: p.y, wx: wr.x, wy: wr.y, scale: wr.w / dipRect(wr).w };
}

function dragMove(s, p) {
  if (!s.drag) return;
  const d = s.drag;
  const x = Math.round(d.wx + (p.x - d.cx) * d.scale);
  const y = Math.round(d.wy + (p.y - d.cy) * d.scale);
  if (s.builtin && !isWin) s.builtin.setPosition(x, y);
  else win32.setBounds(s.hwnd, x, y);
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
  toggleClickThroughAll, list, findByHwnd, sessions, toScreen
};
