/**
 * A strict RFC 4180 reader for the tests, with no dependency. Strict about the sample's own dialect: `,` between fields, `\n` after every
 * record (the last one included), fields either quoted (`""` for a quote inside) or bare (no quote, no
 * comma, no line end). Anything else throws, with the offset.
 *
 * Each cell says whether it was quoted, so a test can check that a NUMERIC cell is never quoted.
 */
export interface Cell {
    value: string;
    quoted: boolean;
}

export type Csv = Cell[][];

export function parseCsv(text: string): Csv {
    const records: Csv = [];
    let record: Cell[] = [];
    let i = 0;
    if (text.length === 0) return records;
    if (!text.endsWith('\n')) throw new Error('RFC 4180: the last record has no line end');
    for (;;) {
        // One field.
        let cell: Cell;
        if (text[i] === '"') {
            let value = '';
            i += 1;
            for (;;) {
                if (i >= text.length) throw new Error(`RFC 4180: unterminated quoted field at ${i}`);
                const c = text[i]!;
                if (c === '"') {
                    if (text[i + 1] === '"') {
                        value += '"';
                        i += 2;
                        continue;
                    }
                    i += 1;
                    break;
                }
                value += c;
                i += 1;
            }
            cell = {value, quoted: true};
        } else {
            let value = '';
            while (i < text.length && text[i] !== ',' && text[i] !== '\n') {
                if (text[i] === '"' || text[i] === '\r') throw new Error(`RFC 4180: ${JSON.stringify(text[i])} in a bare field at ${i}`);
                value += text[i];
                i += 1;
            }
            cell = {value, quoted: false};
        }
        record.push(cell);
        // What follows a field.
        const next = text[i];
        if (next === ',') {
            i += 1;
            continue;
        }
        if (next === '\n') {
            records.push(record);
            record = [];
            i += 1;
            if (i === text.length) return records;
            continue;
        }
        throw new Error(`RFC 4180: ${JSON.stringify(next)} after a field at ${i}`);
    }
}

/** The values of a record. */
export const values = (record: readonly Cell[]): string[] => record.map((cell) => cell.value);

/** The index of the first record whose first cell is `first` (and, if given, the second `second`). */
export function findRow(csv: Csv, first: string, from = 0): number {
    for (let i = from; i < csv.length; i += 1) if (csv[i]![0]?.value === first) return i;
    return -1;
}

/** The sample rows: the records after the `Time (sec)` header up to the first blank row or the end. */
export function sampleRows(csv: Csv): Cell[][] {
    const header = findRow(csv, 'Time (sec)');
    if (header < 0) throw new Error('no "Time (sec)" header');
    const rows: Cell[][] = [];
    for (let i = header + 1; i < csv.length; i += 1) {
        const record = csv[i]!;
        if (record.length === 1 && record[0]!.value === '' && !record[0]!.quoted) break;
        rows.push(record);
    }
    return rows;
}

/** The Summary's value for a label (`Rows`, `End reason`, …), or `undefined` when there is no Summary. */
export function summaryValue(csv: Csv, label: string): string | undefined {
    const summary = findRow(csv, 'Summary');
    if (summary < 0) return undefined;
    const row = findRow(csv, label, summary);
    return row < 0 ? undefined : csv[row]![1]?.value;
}
