const { app, BrowserWindow, ipcMain, dialog, shell, session } = require('electron');
const path = require('path');
const fs = require('fs');

const FILTERS = [{ name: 'Excel workbook', extensions: ['xlsx'] }];

/* The app may only touch spreadsheet files the person picked themselves in a file dialog.
   Those choices are remembered between runs, so the app can reopen the same file. */
const allowedFile = () => path.join(app.getPath('userData'), 'allowed-files.json');
let allowed = new Set();
function loadAllowed() { try { allowed = new Set(JSON.parse(fs.readFileSync(allowedFile(), 'utf8'))); } catch (e) { allowed = new Set(); } }
function allow(p) {
  allowed.add(path.resolve(p));
  try { fs.writeFileSync(allowedFile(), JSON.stringify([...allowed].slice(-20))); } catch (e) {}
}
function check(p) {
  const r = typeof p === 'string' ? path.resolve(p) : '';
  if (!r || !/\.xlsx$/i.test(r) || !allowed.has(r)) throw new Error('That file was not chosen in this app.');
  return r;
}
/* Only this app's own page (the top of the window, not anything inside it) may ask for files. */
const { pathToFileURL } = require('url');
const PAGE_URL = pathToFileURL(path.join(__dirname, 'index.html')).href;
const fromOurPage = (e) => {
  const f = e.senderFrame;
  return !!f && f.parent === null && f.url.split('#')[0].split('?')[0] === PAGE_URL;
};
/* Network: the app works offline. The only thing it may load from the internet is its two fonts. */
const NET_OK = /^https:\/\/(fonts\.googleapis\.com|fonts\.gstatic\.com)\//i;
const LOCAL_OK = /^(file|data|blob|devtools):/i;

function createWindow() {
  const win = new BrowserWindow({
    width: 560, height: 920, backgroundColor: '#050806', title: 'SP Inventory',
    icon: path.join(__dirname, 'icon-512.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, spellcheck: false,
      devTools: !app.isPackaged, navigateOnDragDrop: false, safeDialogs: true
    }
  });
  win.setMenuBarVisibility(false);
  /* The window can only ever show this app's own page. Links go to the normal browser. */
  win.webContents.on('will-navigate', (e, url) => { e.preventDefault(); if (/^https:\/\//i.test(url)) shell.openExternal(url); });
  win.webContents.on('will-redirect', (e) => e.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.loadFile('index.html');
  if (process.argv.includes('--smoke-test')) {
    const report = (m) => { console.log(m); if (process.env.SP_SMOKE_FILE) { try { fs.writeFileSync(process.env.SP_SMOKE_FILE, m); } catch (err) {} } };
    /* Used by the build to prove the finished app starts and its file bridge is in place. */
    win.webContents.once('did-finish-load', async () => {
      let ok = false;
      try { ok = await win.webContents.executeJavaScript("typeof window.cactusNative === 'object' && typeof require === 'undefined' && typeof process === 'undefined'"); } catch (err) {}
      report(ok ? 'SMOKE TEST OK' : 'SMOKE TEST FAILED'); app.exit(ok ? 0 : 1);
    });
    setTimeout(() => { report('SMOKE TEST TIMED OUT'); app.exit(1); }, 60000);
  }
  return win;
}

ipcMain.handle('open', async (e) => {
  if (!fromOurPage(e)) return null;
  const r = await dialog.showOpenDialog({ properties: ['openFile'], filters: FILTERS });
  if (r.canceled) return null;
  allow(r.filePaths[0]); return r.filePaths[0];
});
ipcMain.handle('create', async (e) => {
  if (!fromOurPage(e)) return null;
  const r = await dialog.showSaveDialog({ defaultPath: 'SP Inventory.xlsx', filters: FILTERS });
  if (r.canceled) return null;
  let p = r.filePath; if (!/\.xlsx$/i.test(p)) p += '.xlsx';
  allow(p); return p;
});
ipcMain.handle('exists', async (e, p) => { if (!fromOurPage(e)) return false; try { await fs.promises.access(check(p)); return true; } catch (err) { return false; } });
ipcMain.handle('stat', async (e, p) => { if (!fromOurPage(e)) throw new Error('Not allowed.'); return (await fs.promises.stat(check(p))).mtimeMs; });
ipcMain.handle('read', async (e, p) => {
  if (!fromOurPage(e)) throw new Error('Not allowed.');
  const f = check(p), st = await fs.promises.stat(f);
  if (st.size > 50 * 1024 * 1024) throw new Error('That file is too big to be a stock list.');
  return { bytes: await fs.promises.readFile(f), mtime: st.mtimeMs };
});
/* Backup copy: "<file name> backup <date> <time>.xlsx" in a "Backups" folder next to the spreadsheet. */
function stamp() {
  const d = new Date(), p = (n) => String(n).padStart(2, '0');
  let h = d.getHours(); const ap = h >= 12 ? 'PM' : 'AM'; h = h % 12 || 12;
  return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' + h + '-' + p(d.getMinutes()) + ' ' + ap;
}
ipcMain.handle('backup', async (e, p) => {
  if (!fromOurPage(e)) throw new Error('Not allowed.');
  const f = check(p);
  const dir = path.join(path.dirname(f), 'Backups');
  await fs.promises.mkdir(dir, { recursive: true });
  const base = path.basename(f, path.extname(f)) + ' backup ' + stamp();
  let dest = path.join(dir, base + '.xlsx'), n = 2;
  while (true) { try { await fs.promises.access(dest); dest = path.join(dir, base + ' (' + (n++) + ').xlsx'); } catch (err) { break; } }
  await fs.promises.copyFile(f, dest, fs.constants.COPYFILE_EXCL);
  return path.basename(dest);
});
/* Save to a temporary file next to the spreadsheet, then swap it in, so a half-written file is never left behind. */
ipcMain.handle('write', async (e, p, bytes) => {
  if (!fromOurPage(e)) throw new Error('Not allowed.');
  const f = check(p);
  if (!(bytes instanceof Uint8Array)) throw new Error('That is not a spreadsheet.');
  const buf = Buffer.from(bytes);
  if (buf.length > 50 * 1024 * 1024 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error('That is not a spreadsheet.');
  const tmp = f + '.saving-' + process.pid;
  await fs.promises.writeFile(tmp, buf);
  try { await fs.promises.rename(tmp, f); }
  catch (err) { try { await fs.promises.unlink(tmp); } catch (e2) {} throw err; }
});

/* Only one copy of the app runs at a time, so two windows never save over each other. */
if (!app.requestSingleInstanceLock()) { app.quit(); }
app.on('second-instance', () => { const w = BrowserWindow.getAllWindows()[0]; if (w) { if (w.isMinimized()) w.restore(); w.focus(); } });

app.whenReady().then(() => {
  loadAllowed();
  const ses = session.defaultSession;
  /* No camera, microphone, location or other device permissions are ever granted. */
  ses.setPermissionRequestHandler((wc, perm, cb) => cb(false));
  ses.setPermissionCheckHandler(() => false);
  ses.setDevicePermissionHandler(() => false);
  /* Block every internet request except the fonts, so nothing can send your data anywhere. */
  ses.webRequest.onBeforeRequest((d, cb) => cb({ cancel: !(LOCAL_OK.test(d.url) || NET_OK.test(d.url)) }));
  /* "Download spreadsheet" saves a copy made inside the app; anything else is refused. You always pick where it goes. */
  ses.on('will-download', (e, item) => {
    if (!/^(blob|data):/i.test(item.getURL())) { e.preventDefault(); return; }
    item.setSaveDialogOptions({ defaultPath: item.getFilename() });
  });
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('web-contents-created', (e, contents) => {
  contents.on('will-attach-webview', (ev) => ev.preventDefault());
  contents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
});
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
