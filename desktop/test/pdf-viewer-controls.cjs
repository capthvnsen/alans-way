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

// PDF load completion replaces the initial viewport zoom, even after a click.
async function zoomPdfIn(viewer, waitFor) {
  const { zoom } = await waitFor(() => viewer.executeJavaScript(`(() => {
    const pdf = document.querySelector('pdf-viewer');
    const toolbar = pdf?.shadowRoot?.querySelector('viewer-toolbar');
    const button = toolbar?.shadowRoot?.querySelector('[title="Zoom in"]');
    if (pdf?.loadState_ !== 'success' || pdf.isUpdatePending || toolbar?.isUpdatePending ||
        !button || button.disabled) return false;
    const zoom = pdf.viewport_.getZoom();
    button.click();
    return { zoom };
  })()`));
  return zoom;
}

module.exports = { selectPdfPage, zoomPdfIn };
