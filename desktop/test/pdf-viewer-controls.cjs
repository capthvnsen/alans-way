async function selectPdfPage(viewer, page, waitFor) {
  // The viewport zoom changes before Lit finishes updating the toolbar. Check
  // readiness and dispatch together so no render can intervene between them.
  await waitFor(() => viewer.executeJavaScript(`(() => {
    const pdf = document.querySelector('pdf-viewer');
    const toolbar = pdf?.shadowRoot?.querySelector('viewer-toolbar');
    const selector = toolbar?.shadowRoot?.querySelector('viewer-page-selector');
    const input = selector?.shadowRoot?.querySelector('input');
    if (pdf?.loadState_ !== 'success' || pdf.isUpdatePending || toolbar?.isUpdatePending || selector?.isUpdatePending ||
        !input || input.disabled || !(selector.docLength >= ${JSON.stringify(page)})) return false;
    input.value = ${JSON.stringify(String(page))};
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`));
}

module.exports = { selectPdfPage };
