'use strict';
// Windows 上での動作確認（CI で `electron . --smoke` として実行する）
//  内蔵ブラウザとアプリモードのブラウザ（Chrome / Edge）を実際に開き、
//  切り抜き・最前面・不透明度・クリック透過・移動・元に戻すを Windows API の結果で確かめる。
//  画面のスクリーンショットを smoke-out/ に保存する。
const fs = require('fs');
const path = require('path');
const { desktopCapturer, screen } = require('electron');
const shapes = require('../src/shapes');

const OUT = path.join(__dirname, '..', 'smoke-out');
const sleep = ms => new Promise(r => setTimeout(r, ms));

module.exports = async function smoke({ app, openUrl, trim, win32 }) {
  fs.mkdirSync(OUT, { recursive: true });
  const results = [];
  const check = (name, ok, detail = '') => {
    results.push({ name, ok: !!ok, detail });
    console.log(`${ok ? 'OK  ' : 'FAIL'} ${name}${detail ? ` (${detail})` : ''}`);
  };

  async function shot(name) {
    const d = screen.getPrimaryDisplay();
    const size = { width: Math.round(d.size.width * d.scaleFactor), height: Math.round(d.size.height * d.scaleFactor) };
    const [src] = await desktopCapturer.getSources({ types: ['screen'], thumbnailSize: size });
    if (src) fs.writeFileSync(path.join(OUT, `${name}.png`), src.thumbnail.toPNG());
  }

  const exStyle = h => win32.getExStyle(h);
  const WS_EX_LAYERED = 0x80000, WS_EX_TRANSPARENT = 0x20;

  async function exercise(label, s) {
    const wr = win32.rectOf(s.hwnd);
    check(`${label}: ウィンドウを取得`, wr && wr.w > 100, JSON.stringify(wr));

    // 範囲選択画面を開いて、選んだことにして閉じる
    trim.select(s);
    await sleep(1500);
    check(`${label}: 範囲選択画面が開く`, !!s.overlay);
    await shot(`${label}-1-select`);
    if (s.overlay) {
      const init = s.overlay.tbInit;
      s.overlay.tbFinish({ shape: 'ellipse', x: init.win.w * 0.2, y: init.win.h * 0.2, w: init.win.w * 0.5, h: init.win.h * 0.5 });
    }
    await sleep(800);
    check(`${label}: 切り抜かれている`, win32.hasRegion(s.hwnd));
    check(`${label}: 最前面`, win32.isTopmost(s.hwnd));
    await shot(`${label}-2-trimmed`);

    for (const sh of shapes.SHAPE_IDS) {
      const crop = sh === 'polygon'
        ? { shape: sh, points: [[50, 50], [300, 80], [260, 260], [80, 220]] }
        : { shape: sh, x: 40, y: 60, w: 320, h: 200 };
      trim.trimWith(s, crop, null);
      await sleep(250);
      check(`${label}: 図形 ${sh}`, win32.hasRegion(s.hwnd));
    }
    await shot(`${label}-3-polygon`);

    trim.action(s, 'opacity', 60);
    check(`${label}: 不透明度 60%`, exStyle(s.hwnd) & WS_EX_LAYERED);
    trim.action(s, 'clickThrough');
    check(`${label}: クリック透過オン`, exStyle(s.hwnd) & WS_EX_TRANSPARENT);
    trim.action(s, 'clickThrough');
    check(`${label}: クリック透過オフ`, !(exStyle(s.hwnd) & WS_EX_TRANSPARENT));

    const before = win32.rectOf(s.hwnd);
    trim.dragStart(s, { x: 100, y: 100 });
    trim.dragMove(s, { x: 160, y: 130 });
    trim.dragEnd(s);
    const after = win32.rectOf(s.hwnd);
    check(`${label}: ドラッグで移動`, after.x > before.x && after.y > before.y, `${before.x},${before.y} → ${after.x},${after.y}`);

    // ブラウザ側に切り抜きを外されても付け直されること（監視の確認）
    win32.clearRegion(s.hwnd);
    await sleep(1200);
    check(`${label}: 外された切り抜きを付け直す`, win32.hasRegion(s.hwnd));

    trim.action(s, 'restore');
    await sleep(300);
    check(`${label}: 元に戻す`, !win32.hasRegion(s.hwnd) && !(exStyle(s.hwnd) & WS_EX_LAYERED) && !win32.isTopmost(s.hwnd));
    trim.action(s, 'close');
    await sleep(800);
  }

  try {
    const b = await openUrl({ url: 'https://example.com/', mode: 'builtin', w: 800, h: 600 });
    await sleep(2500);
    await exercise('builtin', b);

    const c = await openUrl({ url: 'https://example.com/', mode: 'chrome', w: 800, h: 600 });
    await sleep(4000);
    await exercise('chrome', c);
    check('chrome: 閉じる', !win32.exists(c.hwnd));
  } catch (e) {
    check('例外なく終わる', false, e.stack);
  }

  fs.writeFileSync(path.join(OUT, 'results.json'), JSON.stringify(results, null, 2));
  const failed = results.filter(r => !r.ok).length;
  console.log(`\n${results.length - failed}/${results.length} OK`);
  app.exit(failed ? 1 : 0);
};
