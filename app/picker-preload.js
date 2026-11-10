// Bridge for the screen-share picker; see picker-ui.js.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('airlockBrowserPicker', {
  sources: () => ipcRenderer.invoke('picker:sources'),
  choose: (id) => ipcRenderer.send('picker:choose', id),
});
