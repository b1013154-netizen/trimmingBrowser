'use strict';
// Windows API の呼び出し（ウィンドウの切り抜き・最前面・透明度・クリック透過・ウィンドウ一覧）
// koffi で user32 / gdi32 / dwmapi を直接呼ぶ。Windows 以外では何もしない（画面確認用）
const isWin = process.platform === 'win32';

let api = null;
function lib() {
  if (api || !isWin) return api;
  const koffi = require('koffi');
  const user32 = koffi.load('user32.dll');
  const gdi32 = koffi.load('gdi32.dll');
  const dwmapi = koffi.load('dwmapi.dll');
  koffi.struct('TB_RECT', { left: 'int32_t', top: 'int32_t', right: 'int32_t', bottom: 'int32_t' });
  const EnumProc = koffi.proto('bool __stdcall TB_EnumWindowsProc(intptr_t hwnd, intptr_t lParam)');
  api = {
    EnumWindows: user32.func('bool __stdcall EnumWindows(TB_EnumWindowsProc *cb, intptr_t lParam)'),
    EnumProc,
    IsWindow: user32.func('bool __stdcall IsWindow(intptr_t hWnd)'),
    IsWindowVisible: user32.func('bool __stdcall IsWindowVisible(intptr_t hWnd)'),
    IsIconic: user32.func('bool __stdcall IsIconic(intptr_t hWnd)'),
    IsZoomed: user32.func('bool __stdcall IsZoomed(intptr_t hWnd)'),
    GetWindow: user32.func('intptr_t __stdcall GetWindow(intptr_t hWnd, uint32_t uCmd)'),
    GetWindowTextW: user32.func('int __stdcall GetWindowTextW(intptr_t hWnd, _Out_ uint16_t *lpString, int nMaxCount)'),
    GetClassNameW: user32.func('int __stdcall GetClassNameW(intptr_t hWnd, _Out_ uint16_t *lpClassName, int nMaxCount)'),
    GetWindowThreadProcessId: user32.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t hWnd, _Out_ uint32_t *lpdwProcessId)'),
    GetWindowRect: user32.func('bool __stdcall GetWindowRect(intptr_t hWnd, _Out_ TB_RECT *lpRect)'),
    GetClientRect: user32.func('bool __stdcall GetClientRect(intptr_t hWnd, _Out_ TB_RECT *lpRect)'),
    SetParent: user32.func('intptr_t __stdcall SetParent(intptr_t hWndChild, intptr_t hWndNewParent)'),
    GetParent: user32.func('intptr_t __stdcall GetParent(intptr_t hWnd)'),
    SetWindowPos: user32.func('bool __stdcall SetWindowPos(intptr_t hWnd, intptr_t hWndInsertAfter, int X, int Y, int cx, int cy, uint32_t uFlags)'),
    ShowWindow: user32.func('bool __stdcall ShowWindow(intptr_t hWnd, int nCmdShow)'),
    GetForegroundWindow: user32.func('intptr_t __stdcall GetForegroundWindow()'),
    SetForegroundWindow: user32.func('bool __stdcall SetForegroundWindow(intptr_t hWnd)'),
    PostMessageW: user32.func('bool __stdcall PostMessageW(intptr_t hWnd, uint32_t Msg, uintptr_t wParam, intptr_t lParam)'),
    GetWindowLongPtrW: user32.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t hWnd, int nIndex)'),
    SetWindowLongPtrW: user32.func('intptr_t __stdcall SetWindowLongPtrW(intptr_t hWnd, int nIndex, intptr_t dwNewLong)'),
    SetLayeredWindowAttributes: user32.func('bool __stdcall SetLayeredWindowAttributes(intptr_t hWnd, uint32_t crKey, uint8_t bAlpha, uint32_t dwFlags)'),
    SetWindowRgn: user32.func('int __stdcall SetWindowRgn(intptr_t hWnd, intptr_t hRgn, bool bRedraw)'),
    GetWindowRgn: user32.func('int __stdcall GetWindowRgn(intptr_t hWnd, intptr_t hRgn)'),
    CreateRectRgn: gdi32.func('intptr_t __stdcall CreateRectRgn(int x1, int y1, int x2, int y2)'),
    CreateRoundRectRgn: gdi32.func('intptr_t __stdcall CreateRoundRectRgn(int x1, int y1, int x2, int y2, int w, int h)'),
    CreateEllipticRgn: gdi32.func('intptr_t __stdcall CreateEllipticRgn(int x1, int y1, int x2, int y2)'),
    CreatePolygonRgn: gdi32.func('intptr_t __stdcall CreatePolygonRgn(const int32_t *pptl, int cPoint, int iMode)'),
    DeleteObject: gdi32.func('bool __stdcall DeleteObject(intptr_t ho)'),
    DwmGetWindowAttribute: dwmapi.func('int32_t __stdcall DwmGetWindowAttribute(intptr_t hwnd, uint32_t dwAttribute, _Out_ int32_t *pvAttribute, uint32_t cbAttribute)')
  };
  return api;
}

const HWND_TOPMOST = -1;
const HWND_NOTOPMOST = -2;
const SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10, SWP_FRAMECHANGED = 0x20;
const GWL_EXSTYLE = -20;
const GWL_STYLE = -16;
const WS_CHILD = 0x40000000, WS_POPUP = 0x80000000, WS_CAPTION = 0xC00000, WS_THICKFRAME = 0x40000, WS_MAXIMIZE = 0x1000000, WS_MINIMIZE = 0x20000000;
const SW_SHOW = 5;
const WS_EX_TOPMOST = 0x8, WS_EX_TRANSPARENT = 0x20, WS_EX_TOOLWINDOW = 0x80, WS_EX_LAYERED = 0x80000;
const LWA_ALPHA = 0x2;
const GW_OWNER = 4;
const SW_RESTORE = 9;
const WM_CLOSE = 0x10;
const DWMWA_CLOAKED = 14;
const ALTERNATE = 1;

// Electron の BrowserWindow から HWND を取り出す
function hwndOf(win) {
  const buf = win.getNativeWindowHandle();
  return buf.length >= 8 ? Number(buf.readBigInt64LE(0)) : buf.readInt32LE(0);
}

function readText(fn, hwnd, max = 512) {
  const buf = Buffer.alloc(max * 2);
  const n = fn(hwnd, buf, max);
  return n > 0 ? buf.toString('utf16le', 0, n * 2) : '';
}

function exists(hwnd) {
  return isWin && !!hwnd && lib().IsWindow(hwnd);
}

function rectOf(hwnd) {
  if (!isWin) return null;
  const r = {};
  if (!lib().GetWindowRect(hwnd, r)) return null;
  return { x: r.left, y: r.top, w: r.right - r.left, h: r.bottom - r.top };
}

function info(hwnd) {
  const a = lib();
  const pid = new Uint32Array(1);
  a.GetWindowThreadProcessId(hwnd, pid);
  return { hwnd, title: readText(a.GetWindowTextW, hwnd), cls: readText(a.GetClassNameW, hwnd, 256), pid: pid[0] };
}

// 切り出しの対象にできるウィンドウ（見えていて、タイトルがあり、他のウィンドウに属さないもの）
function listWindows(excludePid) {
  if (!isWin) return [];
  const a = lib();
  const out = [];
  const cloaked = new Int32Array(1);
  a.EnumWindows(hwnd => {
    if (!a.IsWindowVisible(hwnd) || a.GetWindow(hwnd, GW_OWNER)) return true;
    const ex = Number(a.GetWindowLongPtrW(hwnd, GWL_EXSTYLE));
    if (ex & WS_EX_TOOLWINDOW) return true;
    cloaked[0] = 0;
    a.DwmGetWindowAttribute(hwnd, DWMWA_CLOAKED, cloaked, 4);
    if (cloaked[0]) return true; // 別の仮想デスクトップや非表示のストアアプリ
    const w = info(hwnd);
    if (!w.title || w.pid === excludePid || w.cls === 'Progman' || w.cls === 'Shell_TrayWnd') return true;
    out.push(w);
    return true;
  }, 0);
  return out;
}

function foreground() {
  return isWin ? Number(lib().GetForegroundWindow()) : 0;
}

// 最小化・最大化を解除する（最大化のままだと移動できないため、同じ大きさの通常ウィンドウにする）
function prepare(hwnd) {
  if (!isWin) return;
  const a = lib();
  const before = rectOf(hwnd);
  if (a.IsIconic(hwnd) || a.IsZoomed(hwnd)) {
    const wasZoomed = a.IsZoomed(hwnd);
    a.ShowWindow(hwnd, SW_RESTORE);
    if (wasZoomed && before) a.SetWindowPos(hwnd, 0, before.x, before.y, before.w, before.h, SWP_NOZORDER | SWP_NOACTIVATE);
  }
  a.SetForegroundWindow(hwnd);
}

function setBounds(hwnd, x, y, w, h) {
  if (!isWin) return;
  if (w == null) lib().SetWindowPos(hwnd, 0, x, y, 0, 0, SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE);
  else lib().SetWindowPos(hwnd, 0, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
}

function setTopmost(hwnd, on) {
  if (!isWin) return;
  lib().SetWindowPos(hwnd, on ? HWND_TOPMOST : HWND_NOTOPMOST, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOACTIVATE);
}

function isTopmost(hwnd) {
  return isWin && !!(Number(lib().GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) & WS_EX_TOPMOST);
}

function getExStyle(hwnd) {
  return isWin ? Number(lib().GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) : 0;
}

function setExStyle(hwnd, ex) {
  if (!isWin) return;
  lib().SetWindowLongPtrW(hwnd, GWL_EXSTYLE, ex);
  lib().SetWindowPos(hwnd, 0, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
}

// 不透明度（20〜100%）とクリック透過。origEx は切り出す前の拡張スタイル（元に戻すときに使う）
function setLook(hwnd, origEx, opacity, clickThrough) {
  if (!isWin) return;
  const layered = opacity < 100 || clickThrough;
  let ex = origEx & ~(WS_EX_TRANSPARENT | WS_EX_TOPMOST);
  if (layered) ex |= WS_EX_LAYERED;
  if (clickThrough) ex |= WS_EX_TRANSPARENT;
  ex |= getExStyle(hwnd) & WS_EX_TOPMOST;
  setExStyle(hwnd, ex);
  if (layered) lib().SetLayeredWindowAttributes(hwnd, 0, Math.round(255 * opacity / 100), LWA_ALPHA);
}

function restoreLook(hwnd, origEx) {
  if (!isWin) return;
  setExStyle(hwnd, (origEx & ~WS_EX_TOPMOST) | (getExStyle(hwnd) & WS_EX_TOPMOST));
}

// 切り出し範囲（ウィンドウ左上基準の物理ピクセル）でウィンドウを切り抜く
function applyRegion(hwnd, crop, polygonPoints, roundRadius) {
  if (!isWin) return true;
  const a = lib();
  const { x, y, w, h } = crop;
  let rgn;
  if (crop.shape === 'ellipse') rgn = a.CreateEllipticRgn(x, y, x + w + 1, y + h + 1);
  else if (crop.shape === 'rounded') {
    const d = roundRadius(w, h) * 2;
    rgn = a.CreateRoundRectRgn(x, y, x + w + 1, y + h + 1, d, d);
  } else {
    const pts = polygonPoints(crop);
    if (pts) rgn = a.CreatePolygonRgn(Int32Array.from(pts.flat()), pts.length, ALTERNATE);
    else rgn = a.CreateRectRgn(x, y, x + w, y + h);
  }
  if (!rgn) return false;
  // 成功すると領域の所有権は Windows に移るので DeleteObject しない
  if (!a.SetWindowRgn(hwnd, rgn, true)) {
    a.DeleteObject(rgn);
    return false;
  }
  return true;
}

function clearRegion(hwnd) {
  if (isWin) lib().SetWindowRgn(hwnd, 0, true);
}

// 切り抜きが外されていないか（ブラウザ側が自分で領域を作り直すことがあるため監視に使う）
function hasRegion(hwnd) {
  if (!isWin) return true;
  const a = lib();
  const tmp = a.CreateRectRgn(0, 0, 0, 0);
  const r = a.GetWindowRgn(hwnd, tmp);
  a.DeleteObject(tmp);
  return r !== 0; // 0 = ERROR（領域なし）
}

function clientSize(hwnd) {
  if (!isWin) return null;
  const r = {};
  if (!lib().GetClientRect(hwnd, r)) return null;
  return { w: r.right - r.left, h: r.bottom - r.top };
}

// 他のアプリの窓を、このアプリの窓（host）の中に子ウィンドウとして入れる。
// 戻り値は元に戻すための情報（style・拡張スタイル・画面上の位置）
function adopt(hwnd, host) {
  if (!isWin) return null;
  const a = lib();
  const saved = { style: Number(a.GetWindowLongPtrW(hwnd, GWL_STYLE)), ex: getExStyle(hwnd), rect: rectOf(hwnd) };
  // 子ウィンドウは 32 ビットの style を符号付きで扱うので、計算は >>> 0 で正の値にそろえる
  const style = ((saved.style & ~(WS_POPUP | WS_CAPTION | WS_THICKFRAME | WS_MAXIMIZE | WS_MINIMIZE)) | WS_CHILD) >>> 0;
  a.SetWindowLongPtrW(hwnd, GWL_STYLE, style | 0);
  a.SetParent(hwnd, host);
  a.SetWindowPos(hwnd, 0, 0, 0, 0, 0, SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED);
  a.ShowWindow(hwnd, SW_SHOW);
  return saved;
}

// 子ウィンドウとして入れた窓を、元の独立した窓に戻す
function release(hwnd, saved) {
  if (!isWin || !lib().IsWindow(hwnd)) return;
  const a = lib();
  a.SetParent(hwnd, 0);
  if (saved) {
    a.SetWindowLongPtrW(hwnd, GWL_STYLE, saved.style | 0);
    const r = saved.rect;
    a.SetWindowPos(hwnd, HWND_NOTOPMOST, r.x, r.y, r.w, r.h, SWP_NOACTIVATE | SWP_FRAMECHANGED);
  }
  a.ShowWindow(hwnd, SW_SHOW);
}

function parentOf(hwnd) {
  return isWin ? Number(lib().GetParent(hwnd)) : 0;
}

// 子ウィンドウの位置と大きさ（親のクライアント座標・物理ピクセル）
function placeChild(hwnd, x, y, w, h) {
  if (isWin) lib().SetWindowPos(hwnd, 0, x, y, w, h, SWP_NOZORDER | SWP_NOACTIVATE);
}

function close(hwnd) {
  if (isWin) lib().PostMessageW(hwnd, WM_CLOSE, 0, 0);
}

module.exports = {
  isWin, hwndOf, exists, rectOf, info, listWindows, foreground, prepare, setBounds,
  setTopmost, isTopmost, getExStyle, setLook, restoreLook, applyRegion, clearRegion, hasRegion, close,
  clientSize, adopt, release, parentOf, placeChild
};
