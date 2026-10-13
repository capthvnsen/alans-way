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
    if (!event.isTrusted || event.source === window || event.origin !== 'chrome-extension://mhjfbmdgcfjbbpaeojofohoefgiehjai' || event.data?.workspacePdfDrop !== true || !Array.isArray(event.data.files)) return;
    try { open(event.data.files.filter(file => /\.pdf$/i.test(file.name))); } catch {}
  });
  const dragover = event => {
    if (!event.isTrusted || event.defaultPrevented) return;
    // The page's upload zone gets first refusal. Only advertise the PDF
    // fallback; other file drags keep their normal browser/page behaviour.
    if ([...(event.dataTransfer?.items || [])].some(item => item.kind === 'file' && item.type === 'application/pdf')) event.preventDefault();
  };
  const drop = event => {
    if (!event.isTrusted || event.defaultPrevented) return;
    const files = pdfs(event);
    if (!files.length) return;
    event.preventDefault();
    open(files);
  };
  const listen = () => {
    // Refresh at the start of each gesture so even window handlers installed
    // by the page after preload run before the fallback bubble listeners.
    window.removeEventListener('dragover', dragover);
    window.removeEventListener('drop', drop);
    window.addEventListener('dragover', dragover);
    window.addEventListener('drop', drop);
  };
  window.addEventListener('dragenter', listen);
  listen();
}
