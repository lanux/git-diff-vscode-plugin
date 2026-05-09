export class BitSet {
  private words: Uint32Array;

  constructor(private _size = 0) {
    this.words = new Uint32Array(BitSet.wordCount(_size));
  }

  get size(): number {
    return this._size;
  }

  get(index: number): boolean {
    if (index < 0) throw new RangeError(`Invalid BitSet index ${index}`);
    if (index >= this._size) return false;
    const word = index >>> 5;
    const mask = 1 << (index & 31);
    return (this.words[word] & mask) !== 0;
  }

  set(index: number, value?: boolean): void;
  set(from: number, to: number, value?: boolean): void;
  set(from: number, toOrValue: number | boolean = true, value = true): void {
    if (typeof toOrValue === 'boolean') {
      this.setBit(from, toOrValue);
      return;
    }
    this.setRange(from, toOrValue, value);
  }

  setRange(from: number, to: number, value = true): void {
    if (from < 0 || to < from) throw new RangeError(`Invalid BitSet range [${from}, ${to})`);
    if (from === to) return;
    this.ensureSize(to);
    for (let i = from; i < to; i++) this.setBit(i, value);
  }

  setBit(index: number, value = true): void {
    if (index < 0) throw new RangeError(`Invalid BitSet index ${index}`);
    this.ensureSize(index + 1);
    const word = index >>> 5;
    const mask = 1 << (index & 31);
    if (value) this.words[word] |= mask;
    else this.words[word] &= ~mask;
  }

  clone(): BitSet {
    const copy = new BitSet(this._size);
    copy.words.set(this.words);
    return copy;
  }

  toBooleans(length = this._size): boolean[] {
    const out: boolean[] = [];
    for (let i = 0; i < length; i++) out.push(this.get(i));
    return out;
  }

  private ensureSize(size: number) {
    if (size <= this._size) return;
    this._size = size;
    const need = BitSet.wordCount(size);
    if (need <= this.words.length) return;
    const next = new Uint32Array(need);
    next.set(this.words);
    this.words = next;
  }

  private static wordCount(size: number): number {
    return Math.ceil(size / 32);
  }
}
