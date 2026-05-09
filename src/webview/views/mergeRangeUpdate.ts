export interface RangeUpdateResult {
  start: number;
  end: number;
  damaged: boolean;
}

export function updateRangeOnModification(
  start: number,
  end: number,
  changeStart: number,
  changeEnd: number,
  shift: number,
  greedy = false
): RangeUpdateResult {
  const newChangeEnd = changeEnd + shift;
  if (end <= changeStart) return { start, end, damaged: false };
  if (start >= changeEnd) return { start: start + shift, end: end + shift, damaged: false };
  if (start <= changeStart && end >= changeEnd) return { start, end: end + shift, damaged: false };
  if (start >= changeStart && end <= changeEnd) {
    return greedy
      ? { start: changeStart, end: newChangeEnd, damaged: true }
      : { start: newChangeEnd, end: newChangeEnd, damaged: true };
  }
  if (start < changeStart) {
    return greedy
      ? { start, end: newChangeEnd, damaged: true }
      : { start, end: changeStart, damaged: true };
  }
  return greedy
    ? { start: changeStart, end: end + shift, damaged: true }
    : { start: newChangeEnd, end: end + shift, damaged: true };
}
