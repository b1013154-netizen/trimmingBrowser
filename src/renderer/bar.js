'use strict';
// 切り出した窓の操作バー（マウスを乗せたときだけ表示される）
const $ = s => document.querySelector(s);
let st = null;

function render() {
  $('#pending').hidden = st.state !== 'pending';
  $('#trimmed').hidden = st.state !== 'trimmed';
  $('#topmost').classList.toggle('on', st.topmost);
  $('#click').classList.toggle('on', st.clickThrough);
  $('#fav').disabled = !st.canFavorite;
  $('#fav').title = st.canFavorite ? 'お気に入りに保存（ページ・範囲・位置を覚える）' : '開いている窓から切り出した場合はお気に入りに保存できません';
  const x = document.querySelector('#trimmed .x');
  x.title = st.kind === 'window' ? '切り出しを終える（窓は閉じません）' : '閉じる';
  document.querySelector('#pending [data-act="close"]').title = st.kind === 'window' ? '切り出しをやめる' : 'この窓を閉じる';
  if (document.activeElement !== $('#opacity')) $('#opacity').value = st.opacity;
  $('#opv').textContent = `${st.opacity}%`;
}

document.querySelectorAll('[data-act]').forEach(b => {
  b.onclick = () => {
    const act = b.dataset.act;
    if (act === 'menu') window.tb.invoke('bar:menu');
    else window.tb.invoke('bar:action', act);
  };
});

const op = $('#opacity');
op.oninput = () => {
  $('#opv').textContent = `${op.value}%`;
  window.tb.invoke('bar:action', 'opacity', Number(op.value));
};

// つまみをドラッグして窓を移動する（ボタンを離すまで画面の外でも追いかける）
const grip = $('#grip');
grip.addEventListener('pointerdown', e => {
  grip.setPointerCapture(e.pointerId);
  window.tb.send('bar:dragStart', { x: e.screenX, y: e.screenY });
});
grip.addEventListener('pointermove', e => {
  if (grip.hasPointerCapture(e.pointerId)) window.tb.send('bar:dragMove', { x: e.screenX, y: e.screenY });
});
const end = () => window.tb.send('bar:dragEnd');
grip.addEventListener('pointerup', end);
grip.addEventListener('lostpointercapture', end);

window.tb.on('bar:state', s => { st = s; render(); });
