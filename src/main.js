'use strict';
const { app, BrowserWindow, ipcMain, globalShortcut, Tray, Menu, dialog, nativeImage, shell, screen } = require('electron');
const path = require('path');
const fs = require('fs');
const store = require('./config');
const win32 = require('./win32');
const browser = require('./browser');
const trim = require('./trim');

if (process.env.TB_USERDATA) app.setPath('userData', process.env.TB_USERDATA);
if (!app.requestSingleInstanceLock()) app.quit();

const CONFIG_FILE = () => path.join(app.getPath('userData'), 'config.json');
const ASSET = name => path.join(__dirname, '..', 'build', name);
const PRELOAD = path.join(__dirname, 'preload.js');

let config;
let home = null;
let tray = null;
let hotkeyErrors = [];

// ---------- 設定 ----------
function persist() {
  try { store.save(CONFIG_FILE(), config); } catch (e) { console.error('save failed', e); }
}

function setConfig(next) {
  config = store.normalize(next);
  persist();
  registerHotkeys();
  pushState();
}

function state() {
  const b = win32.isWin ? browser.findBrowser(config.general) : null;
  return {
    config,
    sessions: trim.list(),
    browserFound: b ? b.name : null,
    hotkeyErrors,
    platform: process.platform,
    version: app.getVersion()
  };
}

function pushState() {
  if (home && !home.isDestroyed()) home.webContents.send('state', state());
  updateTrayMenu();
}

function toast(message, kind = 'info') {
  if (home && !home.isDestroyed() && home.isVisible()) home.webContents.send('toast', { message, kind });
  else if (tray && process.platform === 'win32') tray.displayBalloon({ title: 'TrimmingBrowser', content: message, iconType: kind === 'error' ? 'error' : 'info' });
  else console.log(`[${kind}] ${message}`);
}

trim.init({
  config: () => config,
  toast,
  changed: pushState,
  saveFavorite(f) {
    const fav = store.normalizeFavorite({ ...f, id: store.newId() }, config.general);
    if (!fav) return toast('お気に入りに保存できませんでした。', 'error');
    config.favorites.unshift(fav);
    persist();
    pushState();
    toast(`「${fav.name}」をお気に入りに保存しました。名前はホーム画面の「お気に入り」で変えられます。`, 'ok');
  }
});

// ---------- ホーム画面 ----------
function openHome(tab) {
  if (home && !home.isDestroyed()) {
    if (home.isMinimized()) home.restore();
    home.show();
    home.focus();
    if (tab) home.webContents.send('show-tab', tab);
    return;
  }
  const isWin = process.platform === 'win32';
  home = new BrowserWindow({
    width: 980,
    height: 700,
    minWidth: 760,
    minHeight: 540,
    show: false,
    title: 'TrimmingBrowser',
    backgroundColor: '#f5f5f9',
    icon: ASSET('icon.png'),
    titleBarStyle: isWin ? 'hidden' : 'default',
    titleBarOverlay: isWin ? { color: '#fcfcfd', symbolColor: '#55566a', height: 44 } : false,
    autoHideMenuBar: true,
    webPreferences: { preload: PRELOAD, contextIsolation: true, sandbox: true }
  });
  home.loadFile(path.join(__dirname, 'renderer', 'home.html'), { query: tab ? { tab } : {} });
  home.once('ready-to-show', () => home.show());
  home.on('closed', () => { home = null; });
}

// ---------- 開く ----------
// mode: 'chrome'（いつものブラウザ・ログイン状態のまま） / 'builtin'（内蔵ブラウザ・ログインなし）
// w, h は画面の表示倍率を掛ける前の大きさ（physical = true のときは物理ピクセル。お気に入り用）
async function openUrl({ url, mode, w, h, shape, physical }) {
  const u = store.normalizeUrl(url);
  if (!u) throw new Error('URL を確認してください（例: https://www.youtube.com/）');
  store.addRecent(config, u);
  persist();
  const scale = physical ? 1 : screen.getPrimaryDisplay().scaleFactor;
  const size = { w: Math.round((w || config.general.windowW) * scale), h: Math.round((h || config.general.windowH) * scale) };
  let target;
  if (mode === 'builtin') {
    target = await openBuiltin(u, size);
  } else {
    const b = browser.findBrowser(config.general);
    if (!b) throw new Error('Chrome または Edge が見つかりません。設定の「ブラウザ」で場所を指定するか、内蔵ブラウザで開いてください。');
    const hwnd = await browser.openAppWindow(b.path, u, size, process.pid);
    target = { hwnd, kind: 'chrome', url: u };
  }
  // 物理ピクセルで大きさを合わせる（お気に入りの範囲がずれないように）
  const r = win32.rectOf(target.hwnd);
  if (r) win32.setBounds(target.hwnd, r.x, r.y, size.w, size.h);
  return trim.create(target, { shape });
}

// 内蔵ブラウザ: 普段のブラウザとは別の保存領域（ログインや履歴は共有しない）
function openBuiltin(url, size) {
  return new Promise((resolve, reject) => {
    const scale = screen.getPrimaryDisplay().scaleFactor;
    const w = new BrowserWindow({
      width: Math.round(size.w / scale),
      height: Math.round(size.h / scale),
      title: '内蔵ブラウザ - TrimmingBrowser',
      icon: ASSET('icon.png'),
      autoHideMenuBar: true,
      show: false,
      backgroundColor: '#000000',
      webPreferences: { partition: 'persist:builtin', contextIsolation: true, sandbox: true }
    });
    // Electron の名前を外して、一般的な Chrome と同じ User-Agent にする（サイトの表示崩れを避ける）
    w.webContents.setUserAgent(w.webContents.getUserAgent().replace(/\s(Electron|TrimmingBrowser|trimming-browser)\/\S+/g, ''));
    // 新しいウィンドウで開くリンクは同じウィンドウで開く
    w.webContents.setWindowOpenHandler(({ url: next }) => {
      if (/^https?:/i.test(next)) w.loadURL(next);
      return { action: 'deny' };
    });
    w.webContents.on('before-input-event', (e, input) => {
      if (input.type !== 'keyDown') return;
      const wc = w.webContents;
      if (input.alt && input.key === 'ArrowLeft' && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
      else if (input.alt && input.key === 'ArrowRight' && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
      else if (input.key === 'F5') wc.reload();
      else return;
      e.preventDefault();
    });
    w.webContents.on('page-title-updated', () => pushState());
    let done = false;
    const ready = () => {
      if (done || w.isDestroyed()) return;
      done = true;
      w.show();
      resolve({ hwnd: win32.hwndOf(w), kind: 'builtin', url, builtin: w });
    };
    w.once('ready-to-show', ready);
    // 表示に時間がかかるページでも、窓は出しておく（読み込みは続く）
    setTimeout(ready, 8000);
    w.loadURL(url).catch(err => {
      // リダイレクトなどで最初の読み込みが中断されただけなら続ける
      if (done || err.code === 'ERR_ABORTED') return;
      done = true;
      w.destroy();
      reject(new Error(`ページを開けませんでした: ${err.message}`));
    });
  });
}

async function openFavorite(id) {
  const f = config.favorites.find(x => x.id === id);
  if (!f) throw new Error('お気に入りが見つかりません');
  const s = await openUrl({ url: f.url, mode: f.mode, w: f.winW, h: f.winH, shape: f.crop.shape, physical: true });
  s.opacity = f.opacity;
  s.topmost = f.topmost;
  // ページの表示を待ってから切り抜く（内蔵ブラウザは読み込み完了を待つ）
  if (s.builtin) await waitLoad(s.builtin);
  await new Promise(r => setTimeout(r, s.builtin ? 300 : config.general.loadWaitMs));
  trim.trimWith(s, f.crop, f.x == null ? null : { x: f.x, y: f.y });
}

function waitLoad(w) {
  return new Promise(resolve => {
    if (!w.webContents.isLoading()) return resolve();
    w.webContents.once('did-stop-loading', resolve);
    setTimeout(resolve, 15000);
  });
}

// いま開いているウィンドウを切り出す
function trimWindow(hwnd) {
  if (!win32.exists(hwnd)) throw new Error('ウィンドウが見つかりません。一覧を更新してください。');
  const s = trim.findByHwnd(hwnd) || trim.create({ hwnd, kind: 'window' });
  if (home && !home.isDestroyed()) home.minimize();
  setTimeout(() => trim.select(s), 250);
}

// ---------- ホットキー ----------
function registerHotkeys() {
  globalShortcut.unregisterAll();
  hotkeyErrors = [];
  const g = config.general;
  const reg = (key, label, fn) => {
    if (!key) return;
    try {
      if (!globalShortcut.register(key, fn)) hotkeyErrors.push(`${label}（${key}）は他のアプリが使用中のため登録できませんでした。`);
    } catch (e) {
      hotkeyErrors.push(`${label}（${key}）のキーの組み合わせが正しくありません。`);
    }
  };
  reg(g.hotkeyTrim, '前面のウィンドウを切り出す', () => {
    const hwnd = win32.foreground();
    const own = hwnd && win32.isWin && win32.info(hwnd).pid === process.pid;
    if (!hwnd || own) return openHome('open');
    try { trimWindow(hwnd); } catch (e) { toast(e.message, 'error'); }
  });
  reg(g.hotkeyClick, 'クリック透過の切り替え', () => trim.toggleClickThroughAll());
}

// ---------- タスクトレイ ----------
function createTray() {
  const img = nativeImage.createFromPath(ASSET('tray.png'));
  tray = new Tray(img.isEmpty() ? nativeImage.createEmpty() : img.resize({ width: 16, height: 16 }));
  tray.setToolTip('TrimmingBrowser');
  tray.on('click', () => openHome());
  updateTrayMenu();
}

function updateTrayMenu() {
  if (!tray) return;
  const favs = config.favorites.slice(0, 10).map(f => ({
    label: f.name.replace(/&/g, '&&'),
    click: () => openFavorite(f.id).catch(e => toast(e.message, 'error'))
  }));
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'ホームを開く', click: () => openHome() },
    { label: 'お気に入り', submenu: favs.length ? favs : [{ label: '（まだありません）', enabled: false }] },
    { type: 'separator' },
    { label: '切り出しをすべて元に戻す', enabled: trim.sessions.size > 0, click: () => trim.restoreAll() },
    { label: '使い方（説明書）…', click: () => openHome('help') },
    { type: 'separator' },
    { label: '終了', click: () => app.quit() }
  ]));
}

// ---------- IPC: ホーム画面 ----------
const wrap = fn => async (...args) => {
  try {
    const r = await fn(...args);
    return { ok: true, ...(r && typeof r === 'object' && !Array.isArray(r) ? r : { data: r }) };
  } catch (e) {
    return { ok: false, message: e.message };
  }
};

ipcMain.handle('home:state', () => state());
ipcMain.handle('home:open', wrap(async (_e, req) => {
  await openUrl(req);
  if (home && !home.isDestroyed()) home.minimize();
}));
ipcMain.handle('home:windows', () => win32.listWindows(process.pid).map(w => ({ hwnd: w.hwnd, title: w.title, cls: w.cls })));
ipcMain.handle('home:trimWindow', wrap((_e, hwnd) => trimWindow(hwnd)));
ipcMain.handle('home:openFavorite', wrap(async (_e, id) => {
  if (home && !home.isDestroyed()) home.minimize();
  await openFavorite(id);
}));
ipcMain.handle('home:renameFavorite', (_e, id, name) => {
  const f = config.favorites.find(x => x.id === id);
  if (f && String(name).trim()) f.name = String(name).trim().slice(0, 60);
  setConfig(config);
});
ipcMain.handle('home:deleteFavorite', (_e, id) => {
  config.favorites = config.favorites.filter(x => x.id !== id);
  setConfig(config);
});
ipcMain.handle('home:moveFavorite', (_e, id, dir) => {
  const i = config.favorites.findIndex(x => x.id === id);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= config.favorites.length) return;
  [config.favorites[i], config.favorites[j]] = [config.favorites[j], config.favorites[i]];
  setConfig(config);
});
ipcMain.handle('home:setGeneral', (_e, general) => {
  config.general = { ...config.general, ...general };
  setConfig(config);
  return state();
});
ipcMain.handle('home:pickBrowser', async e => {
  const r = await dialog.showOpenDialog(BrowserWindow.fromWebContents(e.sender), {
    title: 'ブラウザの exe を選ぶ',
    properties: ['openFile'],
    filters: [{ name: 'アプリ', extensions: ['exe'] }]
  });
  return r.canceled ? null : r.filePaths[0];
});
ipcMain.handle('home:restoreAll', () => trim.restoreAll());

// ---------- IPC: 範囲選択画面 ----------
ipcMain.handle('select:init', e => BrowserWindow.fromWebContents(e.sender)?.tbInit);
ipcMain.handle('select:done', (e, crop) => BrowserWindow.fromWebContents(e.sender)?.tbFinish(crop));
ipcMain.handle('select:cancel', e => BrowserWindow.fromWebContents(e.sender)?.tbFinish(null));

// ---------- IPC: 操作バー ----------
ipcMain.handle('bar:action', (e, name, value) => {
  const s = trim.bySender(e.sender);
  if (s) trim.action(s, name, value);
});
ipcMain.handle('bar:menu', e => {
  const s = trim.bySender(e.sender);
  if (!s) return;
  Menu.buildFromTemplate([
    { label: 'ホームを開く', click: () => openHome() },
    { label: '使い方（説明書）…', click: () => openHome('help') }
  ]).popup({ window: s.bar });
});
ipcMain.on('bar:dragStart', (e, p) => { const s = trim.bySender(e.sender); if (s) trim.dragStart(s, p); });
ipcMain.on('bar:dragMove', (e, p) => { const s = trim.bySender(e.sender); if (s) trim.dragMove(s, p); });
ipcMain.on('bar:dragEnd', e => { const s = trim.bySender(e.sender); if (s) trim.dragEnd(s); });

// ---------- 説明書 ----------
// インストール版では resources/docs、開発時はリポジトリ直下の docs に置かれる
const DOCS = { manual: '使い方説明書.md' };
const docPath = id => DOCS[id] && path.join(app.isPackaged ? path.join(process.resourcesPath, 'docs') : path.join(__dirname, '..', 'docs'), DOCS[id]);
ipcMain.handle('docs:read', (_e, id) => {
  try {
    return { ok: true, text: fs.readFileSync(docPath(id), 'utf8') };
  } catch {
    return { ok: false, message: '説明書を読み込めませんでした。' };
  }
});
ipcMain.handle('docs:openExternal', async (_e, id) => {
  const err = await shell.openPath(docPath(id));
  return { ok: !err, message: err };
});

// ---------- 起動・終了 ----------
app.on('second-instance', () => openHome());
app.on('window-all-closed', () => { /* タスクトレイに常駐し続ける */ });
app.on('before-quit', () => trim.restoreAll());
app.on('will-quit', () => globalShortcut.unregisterAll());

app.whenReady().then(() => {
  config = store.load(CONFIG_FILE());
  persist();
  createTray();
  registerHotkeys();
  if (process.argv.includes('--smoke')) return require('../scripts/smoke')({ app, openUrl, trim, win32 });
  if (process.env.TB_SHOTS) return require('../scripts/shots')({ app, openHome, getHome: () => home, trim, openUrl });
  openHome();
});
