'use strict';
// 設定の既定値・検証・保存（Electron 非依存。scripts/check.js でテストする）
const fs = require('fs');
const path = require('path');
const shapes = require('./shapes');

const MODES = ['chrome', 'builtin'];
const BROWSERS = ['auto', 'chrome', 'edge', 'custom'];

function defaultConfig() {
  return {
    version: 1,
    general: {
      defaultMode: 'chrome',      // chrome: いつものブラウザ（ログイン状態のまま） / builtin: 内蔵ブラウザ（ログインなし）
      browser: 'auto',            // auto: Chrome → Edge の順に探す
      browserPath: '',            // browser = custom のときの exe
      defaultShape: 'rect',
      windowW: 960,               // 開くときのウィンドウの大きさ（中身の大きさの目安）
      windowH: 600,
      opacity: 100,               // 切り出した窓の不透明度（%）
      topmost: true,              // 切り出した窓を常に最前面にする
      barAutoHide: true,          // 操作バーはマウスを乗せたときだけ出す
      loadWaitMs: 2500,           // お気に入りを開くとき、ページの表示を待つ時間
      hotkeyTrim: 'Ctrl+Alt+X',   // いま前面にあるウィンドウを切り出す
      hotkeyClick: 'Ctrl+Alt+C'   // クリック透過の切り替え（透過中は窓をクリックできないため）
    },
    recentUrls: [],
    favorites: []
  };
}

const int = (v, lo, hi, d) => (Number.isFinite(Number(v)) ? Math.min(hi, Math.max(lo, Math.round(Number(v)))) : d);
const str = (v, d = '') => (typeof v === 'string' ? v : d);
const bool = (v, d) => (typeof v === 'boolean' ? v : d);
const oneOf = (v, list, d) => (list.includes(v) ? v : d);

let seq = 0;
const newId = () => `f${Date.now().toString(36)}${(seq++).toString(36)}`;

// http(s) 以外は開かない。スキームなしの入力（youtube.com など）は https を補う
function normalizeUrl(input) {
  const s = str(input).trim();
  if (!s) return '';
  const withScheme = /^[a-z][a-z0-9+.-]*:/i.test(s) ? s : `https://${s}`;
  try {
    const u = new URL(withScheme);
    return u.protocol === 'http:' || u.protocol === 'https:' ? u.href : '';
  } catch {
    return '';
  }
}

function normalizeFavorite(f, g) {
  if (!f || typeof f !== 'object') return null;
  const url = normalizeUrl(f.url);
  if (!url) return null;
  const winW = int(f.winW, 200, 7680, g.windowW);
  const winH = int(f.winH, 150, 4320, g.windowH);
  const crop = shapes.normalizeCrop(f.crop, winW, winH);
  if (!crop) return null;
  return {
    id: str(f.id) || newId(),
    name: str(f.name).trim().slice(0, 60) || new URL(url).hostname,
    url,
    mode: oneOf(f.mode, MODES, g.defaultMode),
    winW,
    winH,
    crop,
    x: f.x == null ? null : int(f.x, -20000, 20000, 0), // 切り出した窓の左上（画面上の位置）
    y: f.y == null ? null : int(f.y, -20000, 20000, 0),
    opacity: int(f.opacity, 20, 100, g.opacity),
    topmost: bool(f.topmost, g.topmost)
  };
}

function normalize(input) {
  const d = defaultConfig();
  const c = input && typeof input === 'object' ? input : {};
  const gi = c.general || {};
  const g = {
    defaultMode: oneOf(gi.defaultMode, MODES, d.general.defaultMode),
    browser: oneOf(gi.browser, BROWSERS, d.general.browser),
    browserPath: str(gi.browserPath),
    defaultShape: oneOf(gi.defaultShape, shapes.SHAPE_IDS, d.general.defaultShape),
    windowW: int(gi.windowW, 200, 7680, d.general.windowW),
    windowH: int(gi.windowH, 150, 4320, d.general.windowH),
    opacity: int(gi.opacity, 20, 100, d.general.opacity),
    topmost: bool(gi.topmost, d.general.topmost),
    barAutoHide: bool(gi.barAutoHide, d.general.barAutoHide),
    loadWaitMs: int(gi.loadWaitMs, 0, 30000, d.general.loadWaitMs),
    hotkeyTrim: str(gi.hotkeyTrim, d.general.hotkeyTrim),
    hotkeyClick: str(gi.hotkeyClick, d.general.hotkeyClick)
  };
  const recentUrls = (Array.isArray(c.recentUrls) ? c.recentUrls : []).map(normalizeUrl).filter(Boolean);
  const favorites = (Array.isArray(c.favorites) ? c.favorites : []).map(f => normalizeFavorite(f, g)).filter(Boolean);
  const seen = new Set();
  for (const f of favorites) {
    if (seen.has(f.id)) f.id = newId();
    seen.add(f.id);
  }
  return { version: 1, general: g, recentUrls: [...new Set(recentUrls)].slice(0, 15), favorites };
}

function addRecent(config, url) {
  config.recentUrls = [url, ...config.recentUrls.filter(u => u !== url)].slice(0, 15);
}

function load(file) {
  try {
    return normalize(JSON.parse(fs.readFileSync(file, 'utf8')));
  } catch (e) {
    if (e.code !== 'ENOENT') {
      // 壊れた設定は消さずに退避してから既定値で起動する
      try { fs.renameSync(file, `${file}.broken-${Date.now()}`); } catch { /* 退避できなくても起動は続ける */ }
    }
    return defaultConfig();
  }
}

function save(file, config) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
  fs.renameSync(tmp, file);
}

module.exports = { MODES, BROWSERS, defaultConfig, normalize, normalizeFavorite, normalizeUrl, addRecent, load, save, newId };
