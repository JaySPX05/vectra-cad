// Bridge between the sandboxed page and the main process: only these file/menu calls exist.
const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('vectra', {
  isDesktop: true,
  /** Drawing passed on the command line / double-clicked in Explorer, if any. */
  initialFile: () => ipcRenderer.invoke('file:initial'),
  /** Native Open dialog; resolves { path, name, data } or null. */
  openFile: () => ipcRenderer.invoke('file:open'),
  /** Write DXF bytes to an existing .dxf path. */
  saveFile: (path, data) => ipcRenderer.invoke('file:save', path, data),
  /** Native Save As dialog, then write; resolves { path, name } or null. */
  saveFileAs: (suggestedPath, data) => ipcRenderer.invoke('file:save-as', suggestedPath, data),
  /** Real path of a dropped File (Electron no longer exposes File.path). */
  pathForFile: (file) => webUtils.getPathForFile(file),
  setDocState: (dirty, title) => ipcRenderer.send('doc:state', dirty, title),
  closeConfirmed: () => ipcRenderer.send('app:close-ok'),
  onFileOpened: (cb) => ipcRenderer.on('file:opened', (_e, f) => cb(f)),
  onMenu: (cb) => ipcRenderer.on('menu', (_e, name) => cb(name)),
});
