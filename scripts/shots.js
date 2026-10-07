'use strict';
// 説明書・PR 用のスクリーンショットを撮る（TB_SHOTS=1 で起動。Linux の xvfb 上でも動く）
// Windows API を使う「切り抜き」そのものは Windows でしか見えないので、ここではホーム画面・範囲選択・操作バーを撮る
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BrowserWindow } = require('electron');

const OUT = path.join(__dirname, '..', 'screenshots');
const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = async function shots({ app, openHome, getHome, trim }) {
  fs.mkdirSync(OUT, { recursive: true });
  const screen = name => {
    try { execFileSync('import', ['-window', 'root', path.join(OUT, `${name}.png`)]); } catch (e) { console.error('import failed', e.message); }
  };
  const page = async (w, name) => fs.writeFileSync(path.join(OUT, `${name}.png`), (await w.webContents.capturePage()).toPNG());

  openHome();
  await sleep(1500);
  const home = getHome();
  home.setBounds({ x: 40, y: 40, width: 1000, height: 720 });
  await sleep(500);
  await page(home, 'home-open');
  for (const tab of ['windows', 'favorites', 'settings', 'help']) {
    await home.webContents.executeJavaScript(`showTab(${JSON.stringify(tab)})`);
    await sleep(700);
    await page(home, `home-${tab}`);
  }
  home.minimize();

  // 内蔵ブラウザの代わりにデモページを開いて、操作バー・範囲選択を撮る
  const w = new BrowserWindow({ x: 220, y: 160, width: 960, height: 600, title: '内蔵ブラウザ - TrimmingBrowser', autoHideMenuBar: true });
  await w.loadFile(path.join(__dirname, 'demo.html'));
  const s = trim.create({ hwnd: 1, kind: 'builtin', url: 'https://demo.example/', builtin: w });
  await sleep(1200);
  screen('bar-pending');

  trim.select(s);
  await sleep(1500);
  const sel = s.overlay;
  await sel.webContents.executeJavaScript(`
    sel = { x: init.win.x + 20, y: init.win.y + 76, w: 640, h: 360 }; shape = 'rounded'; render();`);
  await sleep(500);
  screen('select');
  await sel.webContents.executeJavaScript(`
    shape = 'polygon'; sel = null; draft = [[init.win.x + 60, init.win.y + 90], [init.win.x + 600, init.win.y + 110], [init.win.x + 640, init.win.y + 400]];
    op = { kind: 'draft', x: init.win.x + 120, y: init.win.y + 420 }; render();`);
  await sleep(500);
  screen('select-polygon');
  sel.tbFinish({ shape: 'rounded', x: 20, y: 76, w: 640, h: 360 });
  await sleep(800);
  s.bar.showInactive();
  await sleep(400);
  await page(s.bar, 'bar-trimmed');
  screen('trimmed-linux');
  app.exit(0);
};
