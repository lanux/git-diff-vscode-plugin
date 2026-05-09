export class UniqueLCS {
    constructor(
        private readonly first: readonly number[],
        private readonly second: readonly number[],
        private readonly start1 = 0,
        private readonly count1 = first.length,
        private readonly start2 = 0,
        private readonly count2 = second.length
    ) { }

    execute(): [number[], number[]] | null {
        const map = new Map<number, number>();
        const match = new Int32Array(this.count1);
        let count = 0;

        for (let i = 0; i < this.count1; i++) {
            const value = this.first[this.start1 + i];
            const existing = map.get(value) ?? 0;
            if (existing === -1) continue;
            if (existing === 0) map.set(value, i + 1);
            else map.set(value, -1);
        }

        for (let i = 0; i < this.count2; i++) {
            const value = this.second[this.start2 + i];
            const existing = map.get(value) ?? 0;
            if (existing <= 0) continue;

            if (match[existing - 1] === 0) {
                match[existing - 1] = i + 1;
                count++;
            } else {
                match[existing - 1] = 0;
                map.set(value, -1);
                count--;
            }
        }

        if (count === 0) return null;

        const sequence = new Int32Array(count);
        const lastElement = new Int32Array(count);
        const predecessor = new Int32Array(this.count1);
        predecessor.fill(-1);

        let length = 0;
        for (let i = 0; i < this.count1; i++) {
            const matched = match[i];
            if (matched === 0) continue;

            const position = lowerBound(sequence, matched, length);
            if (position === length || matched < sequence[position]) {
                sequence[position] = matched;
                lastElement[position] = i;
                predecessor[i] = position > 0 ? lastElement[position - 1] : -1;
                if (position === length) length++;
            }
        }

        const firstRet = new Array<number>(length);
        const secondRet = new Array<number>(length);
        let retIndex = length - 1;
        let current = lastElement[length - 1];
        while (current !== -1) {
            firstRet[retIndex] = current;
            secondRet[retIndex] = match[current] - 1;
            retIndex--;
            current = predecessor[current];
        }

        return [firstRet, secondRet];
    }
}

function lowerBound(sequence: Int32Array, value: number, length: number): number {
    let left = 0;
    let right = length;
    while (left < right) {
        const middle = left + ((right - left) >> 1);
        if (sequence[middle] < value) left = middle + 1;
        else right = middle;
    }
    return left;
}