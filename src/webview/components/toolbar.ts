export function byId(id: string): HTMLElement {
  const el = document.getElementById(id);
  if (!el) throw new Error(`#${id} not found`);
  return el;
}

export function setText(id: string, text: string) { byId(id).textContent = text; }

export function escapeHtml(s: string) {
  return s.replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]!));
}

export function setMode(mode: 'merge' | 'compare') {
  document.body.dataset.mode = mode;
}
