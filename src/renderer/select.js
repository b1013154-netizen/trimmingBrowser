'use strict';
// 範囲選択画面（対象ウィンドウがある画面全体を覆う透明な窓）
//  - ドラッグで囲む（Shift で正方形・正円）
//  - 囲んだあとは中をドラッグで移動、四隅のつまみで大きさ変更
//  - 自由な多角形はクリックで頂点を追加し、最初の点のクリック・ダブルクリック・Enter で閉じる
const $ = s => document.querySelector(s);
const S = window.TBShapes;
const NS = 'http://www.w3.org/2000/svg';

let init = null;   // { win: {x,y,w,h}, shape, shapes, crop, title }
let shape = 'rect';
let sel = null;    // 画面上（この窓の座標）の範囲 { x, y, w, h, points? }
let draft = null;  // 多角形を描いている途中の頂点
let op = null;     // ドラッグ中の操作

const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const W = () => init.win;
const inWin = (x, y) => [clamp(x, W().x, W().x + W().w), clamp(y, W().y, W().y + W().h)];

function shapeIcon(id) {
  const c = id === 'polygon'
    ? { shape: 'polygon', points: [[2, 14], [7, 2], [15, 5], [21, 1], [19, 15], [10, 16]] }
    : { shape: id, x: 1.5, y: 1.5, w: 19, h: 14 };
  if (c.points) Object.assign(c, S.boundsOf(c.points));
  return `<svg viewBox="0 0 22 17"><path d="${S.svgPath(c)}"/></svg>`;
}

// ---------- 描画 ----------
function render() {
  const vw = innerWidth, vh = innerHeight, w = W();
  const full = `M0,0 H${vw} V${vh} H0 Z`;
  const winPath = `M${w.x},${w.y} H${w.x + w.w} V${w.y + w.h} H${w.x} Z`;
  $('#outside').setAttribute('d', `${full} ${winPath}`);
  const frame = $('#frame');
  frame.setAttribute('x', w.x); frame.setAttribute('y', w.y); frame.setAttribute('width', w.w); frame.setAttribute('height', w.h);
  const selPath = sel ? S.svgPath({ ...sel, shape }) : '';
  $('#dim').setAttribute('d', `${winPath} ${selPath}`);
  $('#sel').setAttribute('d', selPath);
  $('#draft').setAttribute('points', draft ? draft.map(p => p.join(',')).join(' ') + (op && op.kind === 'draft' ? ` ${op.x},${op.y}` : '') : '');
  renderHandles();
  $('#ok').disabled = !sel;
  $('#shapes').querySelectorAll('.shape').forEach(b => b.classList.toggle('on', b.dataset.shape === shape));
  hint();
}

function renderHandles() {
  const g = $('#handles');
  g.innerHTML = '';
  if (!sel || op?.kind === 'new') return;
  const add = (x, y, cls, data) => {
    const c = document.createElementNS(NS, 'circle');
    c.setAttribute('cx', x); c.setAttribute('cy', y); c.setAttribute('r', 6);
    c.setAttribute('class', `handle ${cls}`);
    Object.assign(c.dataset, data);
    g.appendChild(c);
  };
  if (shape === 'polygon') {
    sel.points.forEach((p, i) => add(p[0], p[1], 'pt', { pt: i }));
  } else {
    const { x, y, w, h } = sel;
    add(x, y, 'nwse', { corner: 'nw' });
    add(x + w, y, 'nesw', { corner: 'ne' });
    add(x, y + h, 'nesw', { corner: 'sw' });
    add(x + w, y + h, 'nwse', { corner: 'se' });
  }
}

function hint() {
  let t;
  if (shape === 'polygon') {
    t = draft ? 'クリックで頂点を追加／最初の点・ダブルクリック・Enter で閉じる／Backspace で 1 つ戻す' : sel ? '頂点をドラッグで調整、中をドラッグで移動。Enter で切り出します' : '見たい部分の角を順にクリックして囲みます';
  } else {
    t = sel ? '中をドラッグで移動、四隅で大きさ変更。Enter で切り出します（Esc でキャンセル）' : '見たい部分をドラッグで囲みます（Shift で正方形・正円）';
  }
  const el = $('#hint');
  el.textContent = t;
  const w = W();
  const tools = $('#tools').getBoundingClientRect();
  el.style.left = `${clamp(w.x + w.w / 2 - el.offsetWidth / 2, 8, innerWidth - el.offsetWidth - 8)}px`;
  el.style.top = `${tools.bottom + 8}px`;
}

function placeTools() {
  const t = $('#tools');
  const w = W();
  const x = clamp(w.x + w.w / 2 - t.offsetWidth / 2, 8, innerWidth - t.offsetWidth - 8);
  let y = w.y - t.offsetHeight - 40;
  if (y < 8) y = w.y + 10;
  t.style.left = `${x}px`;
  t.style.top = `${y}px`;
}

// ---------- 図形の切り替え ----------
function setShape(id) {
  if (id === shape) return;
  const wasPoly = shape === 'polygon';
  shape = id;
  draft = null;
  if (sel && wasPoly) sel = { x: sel.x, y: sel.y, w: sel.w, h: sel.h };
  if (sel && id === 'polygon') {
    const { x, y, w, h } = sel;
    sel = { x, y, w, h, points: [[x, y], [x + w, y], [x + w, y + h], [x, y + h]] };
  }
  render();
}

// ---------- マウス操作 ----------
const stage = $('#stage');

stage.addEventListener('pointerdown', e => {
  if (e.button !== 0) return;
  stage.setPointerCapture(e.pointerId);
  const [x, y] = inWin(e.clientX, e.clientY);
  const t = e.target;
  if (t.dataset.corner) {
    const { x: sx, y: sy, w, h } = sel;
    const fixed = { nw: [sx + w, sy + h], ne: [sx, sy + h], sw: [sx + w, sy], se: [sx, sy] }[t.dataset.corner];
    op = { kind: 'resize', fx: fixed[0], fy: fixed[1] };
  } else if (t.dataset.pt) {
    op = { kind: 'point', i: Number(t.dataset.pt) };
  } else if (t.id === 'sel' && sel) {
    op = { kind: 'move', sx: x, sy: y, orig: JSON.parse(JSON.stringify(sel)) };
  } else if (shape === 'polygon') {
    if (draft && draft.length >= 3 && Math.hypot(draft[0][0] - x, draft[0][1] - y) < 10) return closePolygon();
    if (!draft) { draft = []; sel = null; }
    draft.push([x, y]);
    op = { kind: 'draft', x, y };
  } else {
    op = { kind: 'new', x1: x, y1: y };
    sel = null;
  }
  render();
});

stage.addEventListener('pointermove', e => {
  if (!op) return;
  const [x, y] = inWin(e.clientX, e.clientY);
  if (op.kind === 'new') {
    const r = S.rectFromDrag(op.x1, op.y1, x, y, e.shiftKey);
    sel = fitRect(r);
  } else if (op.kind === 'resize') {
    sel = fitRect(S.rectFromDrag(op.fx, op.fy, x, y, e.shiftKey));
  } else if (op.kind === 'move') {
    const o = op.orig;
    const dx = clamp(x - op.sx, W().x - o.x, W().x + W().w - o.x - o.w);
    const dy = clamp(y - op.sy, W().y - o.y, W().y + W().h - o.y - o.h);
    sel = { x: o.x + dx, y: o.y + dy, w: o.w, h: o.h };
    if (o.points) sel.points = o.points.map(p => [p[0] + dx, p[1] + dy]);
  } else if (op.kind === 'point') {
    sel.points[op.i] = [x, y];
    Object.assign(sel, S.boundsOf(sel.points));
  } else if (op.kind === 'draft') {
    op.x = x;
    op.y = y;
  }
  render();
});

stage.addEventListener('pointerup', () => {
  if (op && op.kind === 'draft') return; // 多角形は次のクリックまで線を伸ばす
  if (op && op.kind === 'new' && sel && (sel.w < 8 || sel.h < 8)) sel = null;
  op = null;
  render();
});

stage.addEventListener('dblclick', () => {
  if (shape === 'polygon' && draft) {
    // ダブルクリックの 2 回目のクリックで追加された重複点を除く
    if (draft.length > 1) {
      const a = draft[draft.length - 1], b = draft[draft.length - 2];
      if (Math.hypot(a[0] - b[0], a[1] - b[1]) < 4) draft.pop();
    }
    closePolygon();
  }
});

// 正方形・正円にしたとき、ウィンドウからはみ出さないように縮める
function fitRect(r) {
  const w = W();
  let { x, y, w: rw, h: rh } = r;
  if (x < w.x) { rw -= w.x - x; x = w.x; }
  if (y < w.y) { rh -= w.y - y; y = w.y; }
  rw = Math.min(rw, w.x + w.w - x);
  rh = Math.min(rh, w.y + w.h - y);
  return { x, y, w: Math.max(0, rw), h: Math.max(0, rh) };
}

function closePolygon() {
  op = null;
  if (draft && draft.length >= 3) sel = { ...S.boundsOf(draft), points: draft };
  draft = null;
  render();
}

// ---------- 確定・キャンセル ----------
function done() {
  if (draft) closePolygon();
  if (!sel) return;
  if (sel.w < S.MIN_SIZE || sel.h < S.MIN_SIZE) {
    $('#hint').textContent = `小さすぎます。${S.MIN_SIZE}px 以上の大きさで囲んでください。`;
    return;
  }
  const w = W();
  const crop = { shape, x: sel.x - w.x, y: sel.y - w.y, w: sel.w, h: sel.h };
  if (shape === 'polygon') crop.points = sel.points.map(p => [p[0] - w.x, p[1] - w.y]);
  window.tb.invoke('select:done', crop);
}

const cancel = () => window.tb.invoke('select:cancel');

document.addEventListener('keydown', e => {
  if (e.key === 'Escape') {
    if (draft) { draft = null; op = null; render(); } else cancel();
  } else if (e.key === 'Enter') done();
  else if (e.key === 'Backspace' && draft) {
    draft.pop();
    if (!draft.length) { draft = null; op = null; }
    render();
  }
});

$('#ok').onclick = done;
$('#cancel').onclick = cancel;
$('#reset').onclick = () => { sel = null; draft = null; op = null; render(); };

// ---------- 開始 ----------
(async () => {
  init = await window.tb.invoke('select:init');
  shape = init.shape;
  $('#title').textContent = init.title || '';
  $('#shapes').innerHTML = init.shapes.map(s => `<button class="shape" data-shape="${s.id}" title="${s.label}">${shapeIcon(s.id)}</button>`).join('');
  $('#shapes').querySelectorAll('.shape').forEach(b => { b.onclick = () => setShape(b.dataset.shape); });
  if (init.crop) {
    const c = init.crop, w = W();
    sel = { x: c.x + w.x, y: c.y + w.y, w: c.w, h: c.h };
    if (c.points) sel.points = c.points.map(p => [p[0] + w.x, p[1] + w.y]);
    shape = c.shape;
  }
  placeTools();
  render();
  window.focus();
})();
