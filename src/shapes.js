(function () {
'use strict';
// 切り出し図形の定義と座標計算（Electron 非依存。scripts/check.js でテストする）
// メインプロセスからは require、選択画面からは <script> で読み込む（window.TBShapes）
//
// 切り出し範囲は「対象ウィンドウの左上を (0,0) とした物理ピクセル座標」で表す。
//   { shape, x, y, w, h, points? }
// points は自由な多角形のときだけ使う（同じ座標系の [[x,y], ...]）。

const SHAPES = [
  { id: 'rect', label: '四角形', icon: '▭' },
  { id: 'rounded', label: '角丸', icon: '▢' },
  { id: 'ellipse', label: '楕円', icon: '◯' },
  { id: 'hexagon', label: '六角形', icon: '⬡' },
  { id: 'diamond', label: 'ひし形', icon: '◇' },
  { id: 'polygon', label: '自由な多角形', icon: '✎' }
];
const SHAPE_IDS = SHAPES.map(s => s.id);
const MIN_SIZE = 40;

// 角丸の半径（短い辺の 1/8、8〜48px）
function roundRadius(w, h) {
  return Math.max(8, Math.min(48, Math.round(Math.min(w, h) / 8)));
}

// 多角形として描く図形の頂点（四角形・角丸・楕円は Windows API の専用関数で作るので null）
function polygonPoints(crop) {
  const { x, y, w, h } = crop;
  switch (crop.shape) {
    case 'hexagon': {
      const d = Math.round(Math.min(w / 4, h / 2));
      return [[x + d, y], [x + w - d, y], [x + w, y + h / 2], [x + w - d, y + h], [x + d, y + h], [x, y + h / 2]].map(round);
    }
    case 'diamond':
      return [[x + w / 2, y], [x + w, y + h / 2], [x + w / 2, y + h], [x, y + h / 2]].map(round);
    case 'polygon':
      return (crop.points || []).map(round);
    default:
      return null;
  }
}
const round = p => [Math.round(p[0]), Math.round(p[1])];

// 2 点のドラッグから四角形を作る。square=true なら正方形（Shift キー）
function rectFromDrag(x1, y1, x2, y2, square) {
  let w = Math.abs(x2 - x1);
  let h = Math.abs(y2 - y1);
  if (square) w = h = Math.max(w, h);
  const x = x2 >= x1 ? x1 : x1 - w;
  const y = y2 >= y1 ? y1 : y1 - h;
  return { x, y, w, h };
}

function boundsOf(points) {
  const xs = points.map(p => p[0]);
  const ys = points.map(p => p[1]);
  const x = Math.min(...xs);
  const y = Math.min(...ys);
  return { x, y, w: Math.max(...xs) - x, h: Math.max(...ys) - y };
}

// 選択画面（DIP 座標）で作った範囲を、ウィンドウの物理ピクセル座標に変換する
function scaleCrop(crop, ratio) {
  const s = v => Math.round(v * ratio);
  const out = { shape: crop.shape, x: s(crop.x), y: s(crop.y), w: s(crop.w), h: s(crop.h) };
  if (crop.points) out.points = crop.points.map(p => [s(p[0]), s(p[1])]);
  return out;
}

// 範囲をウィンドウの大きさ（winW × winH）の内側に収める。小さすぎる・図形が不正なら null
function normalizeCrop(crop, winW, winH) {
  if (!crop || !SHAPE_IDS.includes(crop.shape)) return null;
  const c = { shape: crop.shape };
  if (crop.shape === 'polygon') {
    const pts = (crop.points || []).filter(p => Array.isArray(p) && isFinite(p[0]) && isFinite(p[1]))
      .map(p => [clamp(Math.round(p[0]), 0, winW), clamp(Math.round(p[1]), 0, winH)]);
    if (pts.length < 3) return null;
    Object.assign(c, boundsOf(pts), { points: pts });
  } else {
    const x = clamp(Math.round(crop.x), 0, winW);
    const y = clamp(Math.round(crop.y), 0, winH);
    Object.assign(c, { x, y, w: clamp(Math.round(crop.w), 0, winW - x), h: clamp(Math.round(crop.h), 0, winH - y) });
  }
  if (c.w < MIN_SIZE || c.h < MIN_SIZE) return null;
  return c;
}

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

// 図形の SVG パス（選択画面のプレビュー用）
function svgPath(crop) {
  const { x, y, w, h } = crop;
  if (crop.shape === 'ellipse') {
    const rx = w / 2, ry = h / 2;
    return `M${x},${y + ry} a${rx},${ry} 0 1,0 ${w},0 a${rx},${ry} 0 1,0 ${-w},0 Z`;
  }
  if (crop.shape === 'rounded') {
    const r = Math.min(roundRadius(w, h), w / 2, h / 2);
    return `M${x + r},${y} H${x + w - r} Q${x + w},${y} ${x + w},${y + r} V${y + h - r} Q${x + w},${y + h} ${x + w - r},${y + h} H${x + r} Q${x},${y + h} ${x},${y + h - r} V${y + r} Q${x},${y} ${x + r},${y} Z`;
  }
  const pts = polygonPoints(crop);
  if (pts) return `M${pts.map(p => p.join(',')).join(' L')} Z`;
  return `M${x},${y} H${x + w} V${y + h} H${x} Z`;
}

const api = { SHAPES, SHAPE_IDS, MIN_SIZE, roundRadius, polygonPoints, rectFromDrag, boundsOf, scaleCrop, normalizeCrop, svgPath };
if (typeof module !== 'undefined' && module.exports) module.exports = api;
else window.TBShapes = api;
})();
