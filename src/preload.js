'use strict';
const { contextBridge, ipcRenderer } = require('electron');

// 画面（ホーム・範囲選択・操作バー）から呼べる処理の一覧
const INVOKE = new Set([
  'home:state', 'home:open', 'home:windows', 'home:trimWindow', 'home:openFavorite', 'home:renameFavorite',
  'home:deleteFavorite', 'home:moveFavorite', 'home:setGeneral', 'home:pickBrowser', 'home:restoreAll',
  'docs:read', 'docs:openExternal',
  'select:init', 'select:done', 'select:cancel',
  'bar:init', 'bar:action', 'bar:menu'
]);
const SEND = new Set(['bar:dragStart', 'bar:dragMove', 'bar:dragEnd', 'bar:hover']);
const ON = new Set(['state', 'toast', 'bar:state', 'show-tab']);

contextBridge.exposeInMainWorld('tb', {
  invoke: (ch, ...args) => (INVOKE.has(ch) ? ipcRenderer.invoke(ch, ...args) : Promise.reject(new Error(`unknown channel ${ch}`))),
  send: (ch, ...args) => { if (SEND.has(ch)) ipcRenderer.send(ch, ...args); },
  on: (ch, cb) => {
    if (!ON.has(ch)) return () => {};
    const fn = (_e, data) => cb(data);
    ipcRenderer.on(ch, fn);
    return () => ipcRenderer.removeListener(ch, fn);
  }
});
