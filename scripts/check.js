'use strict';
// 構文チェックと、Electron に依存しない部分（図形・設定）のテスト
const { execFileSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const root = path.join(__dirname, '..');
const files = ['src', 'src/renderer', 'scripts'].flatMap(d => fs.readdirSync(path.join(root, d)).filter(f => f.endsWith('.js')).map(f => path.join(root, d, f)));
for (const f of files) execFileSync(process.execPath, ['--check', f], { stdio: 'inherit' });
console.log(`構文チェック OK（${files.length} ファイル）`);

const shapes = require('../src/shapes');
const store = require('../src/config');
let n = 0;
const t = (name, fn) => { fn(); n++; };

t('ドラッグ方向に関係なく四角形になる', () => {
  assert.deepStrictEqual(shapes.rectFromDrag(100, 80, 20, 10), { x: 20, y: 10, w: 80, h: 70 });
  assert.deepStrictEqual(shapes.rectFromDrag(10, 10, 50, 30, true), { x: 10, y: 10, w: 40, h: 40 });
  assert.deepStrictEqual(shapes.rectFromDrag(50, 50, 40, 20, true), { x: 20, y: 20, w: 30, h: 30 });
});

t('範囲はウィンドウの内側に収まり、小さすぎると null', () => {
  assert.deepStrictEqual(shapes.normalizeCrop({ shape: 'rect', x: -10, y: 5, w: 500, h: 100 }, 300, 200), { shape: 'rect', x: 0, y: 5, w: 300, h: 100 });
  assert.strictEqual(shapes.normalizeCrop({ shape: 'rect', x: 0, y: 0, w: 10, h: 100 }, 300, 200), null);
  assert.strictEqual(shapes.normalizeCrop({ shape: 'star', x: 0, y: 0, w: 100, h: 100 }, 300, 200), null);
  const p = shapes.normalizeCrop({ shape: 'polygon', points: [[10, 10], [200, 20], [90, 150]] }, 300, 200);
  assert.deepStrictEqual([p.x, p.y, p.w, p.h], [10, 10, 190, 140]);
  assert.strictEqual(shapes.normalizeCrop({ shape: 'polygon', points: [[0, 0], [100, 100]] }, 300, 200), null);
});

t('DIP から物理ピクセルへの変換（150%）', () => {
  assert.deepStrictEqual(shapes.scaleCrop({ shape: 'ellipse', x: 10, y: 20, w: 100, h: 50 }, 1.5), { shape: 'ellipse', x: 15, y: 30, w: 150, h: 75 });
  assert.deepStrictEqual(shapes.scaleCrop({ shape: 'polygon', x: 0, y: 0, w: 2, h: 2, points: [[1, 2]] }, 2).points, [[2, 4]]);
});

t('六角形・ひし形の頂点は範囲の内側', () => {
  for (const shape of ['hexagon', 'diamond']) {
    const c = { shape, x: 10, y: 20, w: 200, h: 100 };
    for (const [x, y] of shapes.polygonPoints(c)) {
      assert.ok(x >= 10 && x <= 210 && y >= 20 && y <= 120, `${shape} ${x},${y}`);
    }
  }
  assert.strictEqual(shapes.polygonPoints({ shape: 'rect', x: 0, y: 0, w: 1, h: 1 }), null);
});

t('すべての図形で SVG パスを作れる', () => {
  for (const s of shapes.SHAPES) {
    const c = { shape: s.id, x: 0, y: 0, w: 100, h: 60, points: [[0, 0], [100, 0], [50, 60]] };
    assert.match(shapes.svgPath(c), /^M[\d.,-]+.*Z$/);
  }
});

t('URL の補完と拒否', () => {
  assert.strictEqual(store.normalizeUrl('youtube.com'), 'https://youtube.com/');
  assert.strictEqual(store.normalizeUrl(' https://example.com/a?b=1 '), 'https://example.com/a?b=1');
  assert.strictEqual(store.normalizeUrl('javascript:alert(1)'), '');
  assert.strictEqual(store.normalizeUrl('file:///C:/x'), '');
  assert.strictEqual(store.normalizeUrl(''), '');
});

t('設定の既定値と不正値の補正', () => {
  const c = store.normalize({ general: { defaultMode: 'x', opacity: 5, windowW: 'abc', topmost: 'yes' }, favorites: 'no' });
  assert.strictEqual(c.general.defaultMode, 'chrome');
  assert.strictEqual(c.general.opacity, 20);
  assert.strictEqual(c.general.windowW, 960);
  assert.strictEqual(c.general.topmost, true);
  assert.deepStrictEqual(c.favorites, []);
  assert.deepStrictEqual(store.normalize(null), store.defaultConfig());
});

t('お気に入りの検証（範囲が不正なものは捨てる・ID の重複を直す）', () => {
  const good = { id: 'a', url: 'https://www.youtube.com/watch?v=1', mode: 'builtin', winW: 960, winH: 600, crop: { shape: 'ellipse', x: 100, y: 50, w: 400, h: 300 }, x: 30, y: 40, opacity: 80, topmost: false };
  const c = store.normalize({ favorites: [good, { ...good }, { ...good, crop: { shape: 'rect', x: 0, y: 0, w: 5, h: 5 } }, { ...good, url: 'ftp://x' }] });
  assert.strictEqual(c.favorites.length, 2);
  assert.notStrictEqual(c.favorites[0].id, c.favorites[1].id);
  assert.strictEqual(c.favorites[0].name, 'www.youtube.com');
  assert.strictEqual(c.favorites[0].mode, 'builtin');
  assert.strictEqual(c.favorites[0].opacity, 80);
});

t('最近開いた URL は重複なし・新しい順・15 件まで', () => {
  const c = store.defaultConfig();
  for (let i = 0; i < 20; i++) store.addRecent(c, `https://e.com/${i}`);
  store.addRecent(c, 'https://e.com/5');
  assert.strictEqual(c.recentUrls.length, 15);
  assert.strictEqual(c.recentUrls[0], 'https://e.com/5');
  assert.strictEqual(c.recentUrls.filter(u => u === 'https://e.com/5').length, 1);
});

t('保存と読み込み・壊れた設定の退避', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'tb-'));
  const file = path.join(dir, 'config.json');
  const c = store.defaultConfig();
  c.general.opacity = 70;
  store.save(file, c);
  assert.strictEqual(store.load(file).general.opacity, 70);
  fs.writeFileSync(file, '{ broken');
  assert.deepStrictEqual(store.load(file), store.defaultConfig());
  assert.ok(fs.readdirSync(dir).some(f => f.startsWith('config.json.broken-')));
});

console.log(`テスト OK（${n} 件）`);
