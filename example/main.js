// App de ejemplo: una ventana con controles para probar clics, arrastre, scroll, teclado,
// menú contextual y diálogos nativos desde Electron Viewer.

const path = require('node:path');
const { app, BrowserWindow, Menu, dialog, ipcMain } = require('electron');

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 640,
    title: 'Electron Viewer example',
    webPreferences: { preload: path.join(__dirname, 'preload.js') },
  });
  win.loadFile('index.html');
  console.log('window created', win.id);
  return win;
}

ipcMain.handle('dialog', (e) =>
  dialog.showMessageBox(BrowserWindow.fromWebContents(e.sender), {
    type: 'info',
    message: 'Hello from a native dialog',
    buttons: ['OK', 'Cancel'],
  }),
);

ipcMain.on('context-menu', (e) => {
  Menu.buildFromTemplate([
    { label: 'Native menu item', click: () => e.sender.send('menu', 'Native menu item') },
    { type: 'separator' },
    { role: 'reload' },
  ]).popup({ window: BrowserWindow.fromWebContents(e.sender) });
});

ipcMain.on('new-window', () => createWindow());

app.whenReady().then(createWindow);
app.on('window-all-closed', () => app.quit());
