// Bridge for the drop-down bar; see bar-ui.js.
const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('airlockBrowserBar', {
  state: () => ipcRenderer.invoke('bar:state'),
  act: (action, arg) => ipcRenderer.send('bar:act', action, arg),
  size: (width, height) => ipcRenderer.send('bar:size', width, height),
  onState: (fn) => ipcRenderer.on('bar:state', (event, state) => fn(state)),
  onToggle: (fn) => ipcRenderer.on('bar:toggle', () => fn()),
});
