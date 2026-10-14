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
    if (!event.isTrusted) return;
    // DataTransfer is readable only during dispatch. Capture native paths now,
    // but decide after every page listener (including dynamically added window
    // listeners) has had its chance to keep the file with preventDefault().
    const paths = pdfs(event).map(file => webUtils.getPathForFile(file)).filter(Boolean);
    if (!paths.length) return;
    setTimeout(() => {
      if (!event.defaultPrevented) ipcRenderer.invoke('workspace:pdf-drop', paths).catch(() => {});
    }, 0);
  };
  // Chromium's file-drop navigation is disabled by the webPreferences. The
  // next-task decision therefore cannot race a navigation or replace this tab.
  window.addEventListener('drop', drop, true);
  const listen = () => {
    // Refresh at the start of each gesture so even window handlers installed
    // by the page after preload run before the fallback dragover listener.
    window.removeEventListener('dragover', dragover);
    window.addEventListener('dragover', dragover);
  };
  window.addEventListener('dragenter', listen);
  listen();
}
