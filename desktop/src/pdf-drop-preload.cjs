// Isolated-world listener: pages cannot manufacture a native File path or a
// trusted drop. Main also checks the source view's human ownership.
const { ipcRenderer, webUtils } = require('electron');
if (process.isMainFrame) {
  const pdfs = event => [...(event.dataTransfer?.files || [])].filter(file => /\.pdf$/i.test(file.name));
  const open = files => ipcRenderer.invoke('workspace:pdf-drop', files.map(file => webUtils.getPathForFile(file)).filter(Boolean)).catch(() => {});
  // The bundled viewer cannot run Electron preloads. Its trusted drop listener
  // relays native File objects to this isolated world; getPathForFile rejects
  // files constructed by page JavaScript (they have no on-disk backing).
  window.addEventListener('message', event => {
    if (event.source === window || event.origin !== 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai' || event.data?.workspacePdfDrop !== true || !Array.isArray(event.data.files)) return;
    try { open(event.data.files.filter(file => /\.pdf$/i.test(file.name))); } catch {}
  });
  window.addEventListener('dragover', event => {
    if (event.isTrusted && [...(event.dataTransfer?.items || [])].some(item => item.kind === 'file')) event.preventDefault();
  }, true);
  window.addEventListener('drop', event => {
    if (!event.isTrusted) return;
    const files = pdfs(event);
    if (!files.length) return;
    event.preventDefault(); event.stopImmediatePropagation();
    open(files);
  }, true);
}
