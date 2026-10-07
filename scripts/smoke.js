'use strict';
// Windows 上での動作確認（CI で `electron . --smoke` として実行する）
//  内蔵ブラウザとアプリモードのブラウザ（Chrome / Edge）を実際に開いて切り出し、
//  小窓の大きさ・中身の拡大率・図形・不透明度・クリック透過・移動・元に戻す・閉じるを確かめる。
//  画面のスクリーンショットを smoke-out/ に保存し、縮小版をログにも出す（IMG: で始まる行）。
const fs = require('fs');
// 異常終了しても途中までのログが残るよう、同期で書き出す
const log = t => fs.writeSync(1, `${t}\n`);
const path = require('path');
const { desktopCapturer, screen } = require('electron');
const shapes = require('../src/shapes');

const OUT = path.join(__dirname, '..', 'smoke-out');
const sleep = ms => new Promise(r => setTimeout(r, ms));
const near = (a, b, tol = 3) => Math.abs(a - b) <= tol;

module.exports = async function smoke({ app, openUrl, trim, win32 }) {
  fs.mkdirSync(OUT, { recursive: true });
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok: !!ok, detail });
    log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  };

  async function shot(name) {
    const d = screen.getPrimaryDisplay();
    const size = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
    const [src] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
    if (!src) return;
    fs.writeFileSync(path.join(OUT, `${name}.png`), src.thumbnail.toPNG());
    images.push([name, src.thumbnail.resize({ width: 480 }).toJPEG(45).toString('base64')]);
  }
  const images = [];
  // 縮小した画面をログの最後にまとめて出す（成果物をダウンロードできない環境でも確認できるように）
  const dumpImages = () => {
    for (const [name, b64] of images.filter(([n]) => /trimmed|bigger|polygon/.test(n))) {
      for (let i = 0; i < b64.length; i += 8000) log(`IMG:${name}:${b64.slice(i, i + 8000)}`);
    }
  };
  process.on('uncaughtException', e => log(`FAIL uncaughtException ${e.stack}`));
  const step = t => log(`.. ${t}`);

  const WS_EX_TRANSPARENT = 0x20;

  async function exercise(label, s) {
    check(`${label}: 窓を開く`, s && s.state === 'pending');
    await shot(`${label}-0-opened`);

    // 範囲選択画面を開いて、範囲を選んだことにする（元の窓の 20%〜70%）
    trim.select(s);
    await sleep(1500);
    check(`${label}: 範囲選択画面が開く`, !!s.overlay);
    if (!s.overlay) return;
    const init = s.overlay.tbInit;
    s.overlay.tbFinish({ shape: 'rect', x: init.win.w * 0.2, y: init.win.h * 0.2, w: init.win.w * 0.5, h: init.win.h * 0.5 });
    await sleep(1200);
    check(`${label}: 切り出した小窓ができる`, s.state === 'trimmed' && s.host && !s.host.isDestroyed());
    const [hw, hh] = s.host.getContentSize();
    check(`${label}: 小窓は範囲と同じ大きさ`, near(hw, init.win.w * 0.5, 4) && near(hh, init.win.h * 0.5, 4), `${hw}x${hh} / 範囲 ${Math.round(init.win.w * 0.5)}x${Math.round(init.win.h * 0.5)}`);
    if (s.view) {
      check(`${label}: 中身の位置（範囲の左上が小窓の左上）`, near(s.view.getBounds().x, -init.win.w * 0.2, 4), JSON.stringify(s.view.getBounds()));
    } else {
      check(`${label}: 元の窓が小窓の中に入る`, win32.parentOf(s.hwnd) === win32.hwndOf(s.host));
    }
    check(`${label}: 最前面`, s.host.isAlwaysOnTop());
    await shot(`${label}-1-trimmed`);

    step('拡大');
    // 拡大（＋ボタン）: 小窓が 1.25 倍になり、中身も同じ比率で拡大する
    trim.action(s, 'size', 1.25);
    await sleep(800);
    const [w2, h2] = s.host.getContentSize();
    check(`${label}: ＋で小窓が大きくなる`, near(w2, hw * 1.25, 4) && near(w2 / h2, hw / hh, 0.05), `${hw}x${hh} → ${w2}x${h2}`);
    if (s.view) {
      const z = s.view.webContents.getZoomFactor();
      check(`${label}: 中身も拡大する`, near(z, w2 / hw, 0.03), `zoom ${z.toFixed(3)}`);
    } else {
      const child = win32.rectOf(s.hwnd);
      check(`${label}: 中の窓も比率どおり大きくなる`, near(child.w / s.src.w, w2 / hw, 0.03), `${s.src.w} → ${child.w}`);
    }
    await shot(`${label}-2-bigger`);

    step('つまみ');
    // つまみで大きさ変更・移動
    const b0 = s.host.getBounds();
    trim.dragStart(s, { x: 100, y: 100, mode: 'resize' });
    trim.dragMove(s, { x: 40, y: 100 });
    trim.dragEnd(s);
    await sleep(500);
    const b1 = s.host.getBounds();
    check(`${label}: つまみで小さくなる（縦横比を保つ）`, b1.width < b0.width && near(b1.width / b1.height, b0.width / b0.height, 0.05), `${b0.width}x${b0.height} → ${b1.width}x${b1.height}`);
    trim.dragStart(s, { x: 100, y: 100 });
    trim.dragMove(s, { x: 160, y: 130 });
    trim.dragEnd(s);
    const b2 = s.host.getBounds();
    check(`${label}: ドラッグで移動`, b2.x === b1.x + 60 && b2.y === b1.y + 30, `${b1.x},${b1.y} → ${b2.x},${b2.y}`);

    step('図形');
    // 図形（切り出しをやめて、図形を変えて切り出し直す）
    for (const sh of shapes.SHAPE_IDS) {
      step(`図形 ${sh}`);
      trim.action(s, 'restore');
      const crop = sh === 'polygon'
        ? { shape: sh, points: [[60, 60], [300, 90], [260, 260], [90, 220]] }
        : { shape: sh, x: 60, y: 60, w: 320, h: 200 };
      trim.trimWith(s, crop, null);
      await sleep(400);
      const ok = s.state === 'trimmed' && (sh === 'rect' || win32.hasRegion(win32.hwndOf(s.host)));
      check(`${label}: 図形 ${sh}`, ok);
    }
    await shot(`${label}-3-polygon`);

    trim.action(s, 'opacity', 60);
    check(`${label}: 不透明度 60%`, near(s.host.getOpacity(), 0.6, 0.02));
    trim.action(s, 'clickThrough');
    check(`${label}: クリック透過オン`, win32.getExStyle(win32.hwndOf(s.host)) & WS_EX_TRANSPARENT);
    trim.action(s, 'clickThrough');
    check(`${label}: クリック透過オフ`, !(win32.getExStyle(win32.hwndOf(s.host)) & WS_EX_TRANSPARENT));

    trim.action(s, 'restore');
    await sleep(500);
    if (s.view) check(`${label}: 元に戻す`, s.state === 'pending' && s.browse.isVisible() && s.view.webContents.getZoomFactor() === 1);
    else check(`${label}: 元に戻す`, s.state === 'pending' && win32.parentOf(s.hwnd) === 0 && near(win32.rectOf(s.hwnd).w, s.src.w, 2));
    await shot(`${label}-4-restored`);
  }

  try {
    const b = await openUrl({ url: 'https://example.com/', mode: 'builtin', w: 800, h: 560 });
    await sleep(2000);
    await exercise('builtin', b);
    trim.action(b, 'close');
    await sleep(500);
    check('builtin: 閉じる', b.browse.isDestroyed() && !trim.sessions.has(b.id));

    const c = await openUrl({ url: 'https://example.com/', mode: 'chrome', w: 800, h: 560 });
    await sleep(4000);
    await exercise('chrome', c);
    // 小窓を Alt+F4 などで閉じた場合: 元の窓を戻してから閉じる
    trim.select(c);
    await sleep(1500);
    c.overlay.tbFinish({ shape: 'ellipse', x: 100, y: 100, w: 300, h: 200 });
    await sleep(800);
    c.host.close();
    await sleep(1500);
    check('chrome: 小窓を閉じるとブラウザの窓も閉じる', !win32.exists(c.hwnd) && !trim.sessions.has(c.id));
  } catch (e) {
    check('例外なく終わる', false, e.stack);
  }

  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  dumpImages();
  for (const r of results.filter(x => !x.ok)) log(`FAILED: ${r.name} ${r.detail}`);
  const failed = results.filter(r => !r.ok).length;
  log(`\n${results.length - failed}/${results.length} OK`);
  app.exit(failed ? 1 : 0);
};
