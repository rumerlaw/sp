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
const fromOurPage = (e) => e.senderFrame && e.senderFrame.url.startsWith('file://');

function createWindow() {
  const win = new BrowserWindow({
    width: 560, height: 920, backgroundColor: '#050806', title: 'SP Inventory',
    icon: path.join(__dirname, 'icon-512.png'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true, nodeIntegration: false, sandbox: true,
      webSecurity: true, allowRunningInsecureContent: false, spellcheck: false
    }
  });
  win.setMenuBarVisibility(false);
  /* The window can only ever show this app's own page. Links go to the normal browser. */
  win.webContents.on('will-navigate', (e, url) => { if (!url.startsWith('file://')) { e.preventDefault(); if (/^https:\/\//i.test(url)) shell.openExternal(url); } });
  win.webContents.setWindowOpenHandler(({ url }) => { if (/^https:\/\//i.test(url)) shell.openExternal(url); return { action: 'deny' }; });
  win.loadFile('index.html');
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
  const buf = Buffer.from(bytes);
  if (buf.length > 50 * 1024 * 1024 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error('That is not a spreadsheet.');
  const tmp = f + '.saving-' + process.pid;
  await fs.promises.writeFile(tmp, buf);
  try { await fs.promises.rename(tmp, f); }
  catch (err) { try { await fs.promises.unlink(tmp); } catch (e2) {} throw err; }
});

app.whenReady().then(() => {
  loadAllowed();
  /* No camera, microphone, location or other device permissions are ever granted. */
  session.defaultSession.setPermissionRequestHandler((wc, perm, cb) => cb(false));
  createWindow();
  app.on('activate', () => { if (BrowserWindow.getAllWindows().length === 0) createWindow(); });
});
app.on('web-contents-created', (e, contents) => { contents.on('will-attach-webview', (ev) => ev.preventDefault()); });
app.on('window-all-closed', () => { if (process.platform !== 'darwin') app.quit(); });
