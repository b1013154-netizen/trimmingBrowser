'use strict';
// 説明書・PR 用のスクリーンショットを撮る（TB_SHOTS=1 で起動。Linux の xvfb 上でも動く）
// Windows API を使う「切り抜き」そのものは Windows でしか見えないので、ここではホーム画面・範囲選択・操作バーを撮る
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { BaseWindow, WebContentsView } = require('electron');

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
  home.hide();

  // 内蔵ブラウザと同じ作り（BaseWindow + WebContentsView）でデモページを開いて、操作バー・範囲選択・小窓を撮る
  const w = new BaseWindow({ x: 220, y: 160, width: 960, height: 600, title: '内蔵ブラウザ - TrimmingBrowser', autoHideMenuBar: true });
  const view = new WebContentsView();
  w.contentView.addChildView(view);
  const [cw, ch] = w.getContentSize();
  view.setBounds({ x: 0, y: 0, width: cw, height: ch });
  await view.webContents.loadFile(path.join(__dirname, 'demo.html'));
  const s = trim.create({ kind: 'builtin', url: 'https://demo.example/', browse: w, view, hwnd: 1 });
  await sleep(1200);
  screen('bar-pending');

  trim.select(s);
  await sleep(1500);
  const sel = s.overlay;
  await sel.webContents.executeJavaScript(`
    sel = { x: init.win.x + 20, y: init.win.y + 76, w: 640, h: 360 }; shape = 'rounded'; render();`);
  await sleep(500);
  screen('select');
  sel.tbFinish({ shape: 'rect', x: 20, y: 76, w: 640, h: 360 });
  await sleep(1000);
  s.bar.showInactive();
  await sleep(400);
  await page(s.bar, 'bar-trimmed');
  screen('trimmed');
  trim.action(s, 'size', 0.6);
  await sleep(800);
  screen('trimmed-small');
  console.log('host', JSON.stringify(s.host.getBounds()), 'view', JSON.stringify(s.view.getBounds()), 'zoom', s.view.webContents.getZoomFactor());
  trim.action(s, 'restore');
  await sleep(600);
  screen('restored');
  console.log('restored zoom', s.view.webContents.getZoomFactor(), 'browse visible', w.isVisible());
  app.exit(0);
};
