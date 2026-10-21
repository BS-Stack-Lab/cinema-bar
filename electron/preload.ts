import { contextBridge, ipcRenderer } from 'electron';
import type { CinemaApi, Snapshot } from './types.js';
const api: CinemaApi = {
  getPoster: (input) => ipcRenderer.invoke('cinema:getPoster', input),
  cancelPoster: (input) => ipcRenderer.invoke('cinema:cancelPoster', input),
  getCatalog: (input) => ipcRenderer.invoke('cinema:getCatalog', input),
  cancelCatalog: (input) => ipcRenderer.invoke('cinema:cancelCatalog', input),
  getSnapshot: () => ipcRenderer.invoke('cinema:getSnapshot'),
  saveRule: (input) => ipcRenderer.invoke('cinema:saveRule', input),
  deleteRule: (id) => ipcRenderer.invoke('cinema:deleteRule', id),
  setPaused: (value) => ipcRenderer.invoke('cinema:setPaused', value),
  saveWebhook: (url) => ipcRenderer.invoke('cinema:saveWebhook', url),
  deleteWebhook: () => ipcRenderer.invoke('cinema:deleteWebhook'),
  updateSettings: (input) => ipcRenderer.invoke('cinema:updateSettings', input),
  refresh: () => ipcRenderer.invoke('cinema:refresh'),
  openBooking: (input) => ipcRenderer.invoke('cinema:openBooking', input),
  recoverStorage: () => ipcRenderer.invoke('cinema:recoverStorage'),
  quit: () => ipcRenderer.invoke('cinema:quit'),
  onSnapshot: (listener) => {
    const handler = (_event: unknown, value: Snapshot) => listener(value);
    ipcRenderer.on('cinema:snapshot', handler);
    return () => {
      ipcRenderer.removeListener('cinema:snapshot', handler);
    };
  },
};
contextBridge.exposeInMainWorld('cinema', api);
for (const event of ['online', 'offline'])
  window.addEventListener(event, () => {
    void ipcRenderer.invoke('cinema:networkChanged').catch(() => undefined);
  });
