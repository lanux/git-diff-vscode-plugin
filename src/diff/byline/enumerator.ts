export class Enumerator<T, K = T> {
  private readonly numbers = new Map<K, number>();
  private nextNumber = 1;

  constructor(private readonly keyOf: (value: T) => K = (value) => value as unknown as K) {}

  enumerate(objects: readonly T[], startShift = 0, endCut = 0): number[] {
    const length = objects.length - startShift - endCut;
    if (length < 0) throw new RangeError(`Invalid enumerate range: ${startShift}/${endCut}/${objects.length}`);

    const result = new Array<number>(length);
    for (let i = 0; i < length; i++) {
      result[i] = this.enumerateOne(objects[startShift + i]);
    }
    return result;
  }

  private enumerateOne(value: T): number {
    if (value == null) return 0;

    const key = this.keyOf(value);
    const existing = this.numbers.get(key);
    if (existing !== undefined) return existing;

    const next = this.nextNumber++;
    this.numbers.set(key, next);
    return next;
  }
}
