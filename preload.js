const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('cactusNative', {
  open: () => ipcRenderer.invoke('open'),
  create: () => ipcRenderer.invoke('create'),
  exists: (p) => ipcRenderer.invoke('exists', p),
  stat: (p) => ipcRenderer.invoke('stat', p),
  read: (p) => ipcRenderer.invoke('read', p),
  write: (p, bytes) => ipcRenderer.invoke('write', p, bytes),
  backup: (p) => ipcRenderer.invoke('backup', p)
});
