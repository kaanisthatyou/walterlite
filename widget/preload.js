const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('walter', {
  closeApp:          ()        => ipcRenderer.send('close-app'),
  onStatus:          (cb)      => ipcRenderer.on('status', (_, data) => cb(data)),
  onStep:            (cb)      => ipcRenderer.on('step',   (_, data) => cb(data)),
  onPlan:            (cb)      => ipcRenderer.on('plan',   (_, data) => cb(data)),
  switchWindow:      (target)  => ipcRenderer.send('switch-window', target),
  openSettings:      ()        => ipcRenderer.send('open-settings'),
  executeCommand:    (text)    => ipcRenderer.send('execute-command', text),
  // Local mic recording
  sendAudio:         (uint8)   => ipcRenderer.send('recording-audio', uint8),
  onToggleRecording: (cb)      => ipcRenderer.on('toggle-recording', () => cb()),
});
