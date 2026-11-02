const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('example', {
  dialog: () => ipcRenderer.invoke('dialog'),
  contextMenu: () => ipcRenderer.send('context-menu'),
  newWindow: () => ipcRenderer.send('new-window'),
  onMenu: (fn) => ipcRenderer.on('menu', (_e, label) => fn(label)),
});
