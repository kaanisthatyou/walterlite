const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('walterSettings', {
  getSettings: ()           => ipcRenderer.invoke('settings-get'),
  saveSettings: (data)      => ipcRenderer.invoke('settings-save', data),
  close:        ()          => ipcRenderer.send('settings-close'),
});
