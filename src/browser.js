'use strict';
// 「いつものブラウザ」で開く（Chrome / Edge のアプリモード: タブとアドレスバーのないウィンドウ）
// いつものプロフィールで開くので、ログイン状態や拡張機能はそのまま使える
const fs = require('fs');
const path = require('path');
const { spawn } = require('child_process');
const win32 = require('./win32');

function candidates(kind) {
  const env = process.env;
  const roots = [env.ProgramFiles, env['ProgramFiles(x86)'], env.LOCALAPPDATA].filter(Boolean);
  const rel = {
    chrome: path.join('Google', 'Chrome', 'Application', 'chrome.exe'),
    edge: path.join('Microsoft', 'Edge', 'Application', 'msedge.exe')
  }[kind];
  return roots.map(r => path.join(r, rel));
}

// 戻り値: { path, name } または null
function findBrowser(general) {
  if (general.browser === 'custom') {
    return general.browserPath && fs.existsSync(general.browserPath) ? { path: general.browserPath, name: path.basename(general.browserPath, '.exe') } : null;
  }
  const kinds = general.browser === 'auto' ? ['chrome', 'edge'] : [general.browser];
  for (const k of kinds) {
    const p = candidates(k).find(c => fs.existsSync(c));
    if (p) return { path: p, name: k === 'chrome' ? 'Google Chrome' : 'Microsoft Edge' };
  }
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));
const CHROMIUM_CLASS = 'Chrome_WidgetWin_1';

// ブラウザをアプリモードで開き、新しくできたウィンドウの HWND を返す。
// ブラウザがすでに起動していると、起動したプロセスは既存のプロセスに処理を渡してすぐ終わるため、
// プロセス ID ではなく「開く前になかったウィンドウ」を探す。
async function openAppWindow(exe, url, size, ownPid) {
  const before = new Set(win32.listWindows(ownPid).filter(w => w.cls === CHROMIUM_CLASS).map(w => w.hwnd));
  const args = [`--app=${url}`, '--new-window'];
  if (size) args.push(`--window-size=${size.w},${size.h}`);
  const child = spawn(exe, args, { detached: true, stdio: 'ignore' });
  child.on('error', () => { /* 下のタイムアウトで知らせる */ });
  child.unref();
  for (let i = 0; i < 100; i++) {
    await sleep(150);
    const found = win32.listWindows(ownPid).find(w => w.cls === CHROMIUM_CLASS && !before.has(w.hwnd));
    if (found) return found.hwnd;
  }
  throw new Error('ブラウザのウィンドウが見つかりませんでした。ブラウザの場所を設定で確認してください。');
}

module.exports = { findBrowser, openAppWindow };
