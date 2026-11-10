// Bridge for the settings overlay; the remote desktop page gets no preload.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('airlockBrowser', {
  state: () => ipcRenderer.invoke('airlock-browser:state'),
  save: (settings) => ipcRenderer.invoke('airlock-browser:save', settings),
  run: (settings, id, action) => ipcRenderer.invoke('airlock-browser:run', settings, id, action),
  close: () => ipcRenderer.send('airlock-browser:close'),
});
