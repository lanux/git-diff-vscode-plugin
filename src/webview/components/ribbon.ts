import type { LineRange } from '../diff/align';

const HUNK_COLORS: Record<string, string> = {
  auto: 'rgba(98,150,85,.45)',
  conflict: 'rgba(232,118,0,.45)',
  modified: 'rgba(70,130,180,.45)',
  added: 'rgba(98,150,85,.45)',
  deleted: 'rgba(120,120,120,.45)',
  equal: 'transparent'
};

export class Ribbon {
  private svg: SVGSVGElement;
  private paths: SVGPathElement[] = [];

  constructor(container: HTMLElement) {
    this.svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
    this.svg.classList.add('ribbon-overlay');
    container.appendChild(this.svg);
  }

  update(
    leftEditor: HTMLElement,
    rightEditor: HTMLElement,
    hunks: { id: number; kind: string; left: LineRange; right: LineRange }[]
  ) {
    for (const p of this.paths) p.remove();
    this.paths = [];

    const containerRect = this.svg.parentElement!.getBoundingClientRect();
    this.svg.setAttribute('width', String(containerRect.width));
    this.svg.setAttribute('height', String(containerRect.height));

    for (const h of hunks) {
      if (h.kind === 'equal' || HUNK_COLORS[h.kind] === 'transparent') continue;
      const lTop = this.lineY(leftEditor, h.left.start);
      const lBot = this.lineY(leftEditor, h.left.start + h.left.length);
      const rTop = this.lineY(rightEditor, h.right.start);
      const rBot = this.lineY(rightEditor, h.right.start + h.right.length);

      const leftRect = leftEditor.getBoundingClientRect();
      const rightRect = rightEditor.getBoundingClientRect();
      const lX = leftRect.right - containerRect.left;
      const rX = rightRect.left - containerRect.left;

      const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
      const midX = (lX + rX) / 2;
      path.setAttribute('d',
        `M${lX},${lTop} C${midX},${lTop} ${midX},${rTop} ${rX},${rTop} ` +
        `L${rX},${rBot} C${midX},${rBot} ${midX},${lBot} ${lX},${lBot} Z`
      );
      path.setAttribute('fill', HUNK_COLORS[h.kind] ?? 'rgba(70,130,180,.3)');
      path.setAttribute('stroke', HUNK_COLORS[h.kind] ?? 'rgba(70,130,180,.5)');
      path.setAttribute('stroke-width', '0.5');
      path.classList.add('ribbon-path');
      path.dataset.hunkId = String(h.id);
      this.svg.appendChild(path);
      this.paths.push(path);
    }
  }

  private lineY(editorEl: HTMLElement, line: number): number {
    const containerRect = this.svg.parentElement!.getBoundingClientRect();
    const lineHeight = this.getLineHeight(editorEl);
    const linesContent = editorEl.querySelector('.lines-content') as HTMLElement | null;
    const editorRect = editorEl.getBoundingClientRect();
    const scrollDom = editorEl.querySelector('.scrollable-element') as HTMLElement | null;
    const scrollTop = scrollDom?.scrollTop ?? 0;
    const contentTop = editorRect.top - containerRect.top + (linesContent?.offsetTop ?? 0) - scrollTop;
    return contentTop + (line - 1) * lineHeight;
  }

  private getLineHeight(editorEl: HTMLElement): number {
    const lineEl = editorEl.querySelector('.view-line');
    if (lineEl) return (lineEl as HTMLElement).getBoundingClientRect().height || 18;
    return 18;
  }

  destroy() {
    this.svg.remove();
  }
}
