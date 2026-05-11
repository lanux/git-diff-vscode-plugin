import { splitTextToLines } from './byline';

export interface ParsedConflictMarkers {
  local: string;
  base: string;
  remote: string;
}

export function hasConflictMarkers(text: string): boolean {
  return /^(<{7}|={7}|>{7})/m.test(text);
}

export function parseConflictMarkers(text: string): ParsedConflictMarkers | null {
  if (!hasConflictMarkers(text)) return null;

  const lines = splitTextToLines(text);
  const local: string[] = [];
  const base: string[] = [];
  const remote: string[] = [];
  let index = 0;
  let sawConflict = false;

  while (index < lines.length) {
    const line = lines[index];
    if (!isStartMarker(line)) {
      local.push(line);
      base.push(line);
      remote.push(line);
      index++;
      continue;
    }

    sawConflict = true;
    index++;
    const localChunk: string[] = [];
    const baseChunk: string[] = [];
    const remoteChunk: string[] = [];
    let section: 'local' | 'base' | 'remote' = 'local';
    let sawDivider = false;
    let closed = false;

    while (index < lines.length) {
      const chunkLine = lines[index];
      if (isStartMarker(chunkLine)) return null;
      if (isBaseMarker(chunkLine)) {
        if (section !== 'local') return null;
        section = 'base';
        index++;
        continue;
      }
      if (isDividerMarker(chunkLine)) {
        if (section === 'remote') return null;
        section = 'remote';
        sawDivider = true;
        index++;
        continue;
      }
      if (isEndMarker(chunkLine)) {
        if (!sawDivider) return null;
        closed = true;
        index++;
        break;
      }

      if (section === 'local') localChunk.push(chunkLine);
      else if (section === 'base') baseChunk.push(chunkLine);
      else remoteChunk.push(chunkLine);
      index++;
    }

    if (!closed) return null;
    local.push(...localChunk);
    base.push(...baseChunk);
    remote.push(...remoteChunk);
  }

  if (!sawConflict) return null;
  return {
    local: local.join('\n'),
    base: base.join('\n'),
    remote: remote.join('\n')
  };
}

function isStartMarker(line: string): boolean {
  return line.startsWith('<<<<<<<');
}

function isBaseMarker(line: string): boolean {
  return line.startsWith('|||||||');
}

function isDividerMarker(line: string): boolean {
  return line.startsWith('=======');
}

function isEndMarker(line: string): boolean {
  return line.startsWith('>>>>>>>');
}
