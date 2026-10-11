/**
 * FOR INTEGRATORS: Terminal plumbing, no SDK call. A program with its own UI does not need this file; skip it on a first read.
 *
 * The two questions: which device type, and how many seconds.
 *
 * The validation is pure (`offeredTypes`, `parseDeviceChoice`, `parseSeconds` from `args.ts`), so the
 * tests call it directly. The asking goes through a small `LineReader`, so a test can script the answers
 * and the real program can use `node:readline/promises`.
 *
 * A flag pre-answers a question and is checked by the SAME rule as a typed answer: `--device KPOWER` is
 * refused exactly as typing `KPOWER` at the prompt is.
 */
import {createInterface} from 'node:readline/promises';
import {DeviceType, deviceTypeFromString} from '@kinvent/companion-sdk';
import {parseSeconds, SECONDS_MAX, SECONDS_MIN} from './args.js';

/**
 * The product name of each `DeviceType`.
 * Only the types this sample offers have one.
 */
const LABELS: Partial<Record<DeviceType, string>> = {
    [DeviceType.GRIP]: 'K-Grip',
    [DeviceType.MUSCLE_TESTER]: 'K-Push',
    [DeviceType.PLATES]: 'K-Plates',
    [DeviceType.BUBBLE]: 'K-Bubble',
    [DeviceType.LINK]: 'K-Pull',
    [DeviceType.HEXAS]: 'K-Deltas',
    [DeviceType.DELTAS_3D]: 'K-Deltas 3D',
    [DeviceType.EMG]: 'K-Myo',
};

/**
 * The force types. Not offered: `KPOWER` and `SENS` (not supported in this sample yet),
 * `UNKNOWN` (not a product), and `EMG`: the companion does
 * not describe its live values yet.
 * The K-Myo label stays, for E11's sentence.
 */
const FORCE_TYPES: ReadonlySet<DeviceType> = new Set<DeviceType>([
    DeviceType.GRIP,
    DeviceType.MUSCLE_TESTER,
    DeviceType.LINK,
    DeviceType.PLATES,
    DeviceType.HEXAS,
    DeviceType.DELTAS_3D,
    DeviceType.BUBBLE,
]);

/**
 * The types the companion expands to a LEFT + RIGHT pair (or to LEFT alone when the exercise is monopodal):
 * K-Plates, K-Deltas and K-Deltas 3D, the types whose snapshots carry a `side`.
 * The SDK exports no "is a pair type" function, so the sample names them here.
 */
const PAIR_TYPES: ReadonlySet<DeviceType> = new Set<DeviceType>([DeviceType.PLATES, DeviceType.HEXAS, DeviceType.DELTAS_3D]);

/** Whether `type` is recorded as a LEFT + RIGHT pair unless `--single` is given. */
export function isPairType(type: DeviceType): boolean {
    return PAIR_TYPES.has(type);
}

/** The noun of one sensor of a pair type, for the `--single` question: "plate", "K-Delta", "3D Delta". */
export function singleNounOf(type: DeviceType): string {
    switch (type) {
        case DeviceType.PLATES:
            return 'plate';
        case DeviceType.HEXAS:
            return 'K-Delta';
        case DeviceType.DELTAS_3D:
            return '3D Delta';
        default:
            return labelOf(type);
    }
}

export interface OfferedType {
    type: DeviceType;
    label: string;
}

/** A device type's product name, or the enum name for a type this sample has no label for. */
export function labelOf(type: DeviceType): string {
    return LABELS[type] ?? type;
}

/** The menu, in the order of the SDK's `DeviceType` const, restricted to the offered types. */
export function offeredTypes(): OfferedType[] {
    return (Object.values(DeviceType) as DeviceType[])
        .filter((type) => FORCE_TYPES.has(type))
        .map((type) => ({type, label: labelOf(type)}));
}

const DIGITS = /^[0-9]+$/;

/** The outcome of one answer to the device question. */
export type DeviceChoice = {ok: true; type: DeviceType} | {ok: false; message: string};

/**
 * One answer to the device question: a menu number or an enum name in any case. Returns the type, or the message to show
 * before asking again. (A tagged result, because a `DeviceType` is itself a string.)
 */
export function parseDeviceChoice(text: string, offered: readonly OfferedType[]): DeviceChoice {
    const range = `Please type a number from 1 to ${offered.length}.`;
    const refuse = (message: string): DeviceChoice => ({ok: false, message});
    const trimmed = text.trim();
    if (trimmed === '') return refuse(range);
    if (DIGITS.test(trimmed)) {
        const index = Number(trimmed);
        return Number.isSafeInteger(index) && index >= 1 && index <= offered.length
            ? {ok: true, type: offered[index - 1]!.type}
            : refuse(range);
    }
    const type = deviceTypeFromString(trimmed.toUpperCase());
    if (type === undefined) return refuse(`Unknown device type "${trimmed}". ${range}`);
    if (offered.some((entry) => entry.type === type)) return {ok: true, type};
    if (type === DeviceType.EMG) {
        return refuse(`EMG (K-Myo) is not offered: the companion does not describe its live values yet. ${range}`);
    }
    return refuse(`${type} is not offered by this sample. ${range}`);
}

/** One line of input; `undefined` means the input ended (Ctrl-D, or the stream closed). */
export interface LineReader {
    ask(prompt: string): Promise<string | undefined>;
}

/** Where the prompts write. */
export interface PromptOutput {
    write(text: string): void;
}

/** The user ended the input (Ctrl-D) at a question. The caller exits 130 with no side effects. */
export class InputClosed extends Error {
    constructor() {
        super('Input ended.');
        this.name = 'InputClosed';
    }
}

/**
 * A missing answer cannot be asked for: stdin is not a terminal and the flag was not given. A usage
 * error, so the caller exits with E10's code (1).
 */
export class AnswerRequired extends Error {
    constructor(readonly flag: string) {
        super(`${flag} is required when the input is not a terminal (for example in a script or a pipe).`);
        this.name = 'AnswerRequired';
    }
}

/** A flag value that the prompt's rule refuses. A usage error (E10, exit 1). */
export class BadFlagValue extends Error {
    constructor(message: string) {
        super(message);
        this.name = 'BadFlagValue';
    }
}

export interface PromptContext {
    /** `undefined` when there is no terminal to ask on. */
    reader: LineReader | undefined;
    out: PromptOutput;
}

/** The device question. Honours `--device`; otherwise shows the menu and asks until the answer is valid. */
export async function askDeviceType(flag: string | undefined, ctx: PromptContext): Promise<DeviceType> {
    const offered = offeredTypes();
    if (flag !== undefined) {
        const parsed = parseDeviceChoice(flag, offered);
        if (!parsed.ok) {
            throw new BadFlagValue(`--device: ${parsed.message} Offered: ${offered.map((entry) => entry.type).join(', ')}.`);
        }
        return parsed.type;
    }
    if (ctx.reader === undefined) throw new AnswerRequired('--device');

    const width = String(offered.length).length;
    ctx.out.write('Which device type?\n');
    for (const [index, entry] of offered.entries()) {
        ctx.out.write(`  ${String(index + 1).padStart(width)}. ${entry.label} (${entry.type})\n`);
    }
    for (;;) {
        const answer = await ctx.reader.ask(`Device (1-${offered.length} or name): `);
        if (answer === undefined) throw new InputClosed();
        const parsed = parseDeviceChoice(answer, offered);
        if (parsed.ok) return parsed.type;
        ctx.out.write(`${parsed.message}\n`);
    }
}

/**
 * One answer to the sampling-rate question: a menu number, or one of the offered rates in Hz ("250" or
 * "250 Hz"); empty keeps `current`. The rates the companion offers start at 25 Hz and a menu has at most a
 * dozen entries, so a number is never both. Returns the rate, or the message to show before asking again.
 */
export function parseRateChoice(text: string, rates: readonly number[], current: number | undefined): number | string {
    const range =
        current === undefined
            ? `Please type a number from 1 to ${rates.length}.`
            : `Please type a number from 1 to ${rates.length}, or press Enter to keep ${current} Hz.`;
    const trimmed = text.trim().toLowerCase().replace(/\s*hz$/, '');
    if (trimmed === '') return current ?? range;
    if (!/^[0-9]+$/.test(trimmed)) return range;
    const value = Number(trimmed);
    if (value >= 1 && value <= rates.length) return rates[value - 1]!;
    if (rates.includes(value)) return value;
    return `${value} Hz is not offered. ${range}`;
}

/**
 * The sampling rate, from the rates the companion offers for this device (the same list as the
 * mobile app). Asked only at a terminal; without one the current rate is kept.
 */
export async function askRate(
    label: string,
    rates: readonly number[],
    current: number | undefined,
    ctx: PromptContext,
    notes: ReadonlyMap<number, string> = new Map(),
): Promise<number | undefined> {
    if (ctx.reader === undefined || rates.length === 0) return current;
    const width = String(rates.length).length;
    ctx.out.write(`Sampling rate for the ${label}?\n`);
    for (const [index, rate] of rates.entries()) {
        const note = notes.get(rate);
        ctx.out.write(`  ${String(index + 1).padStart(width)}. ${rate} Hz${rate === current ? ' (current)' : ''}${note === undefined ? '' : ` (${note})`}\n`);
    }
    const hint = current === undefined ? '' : `, Enter keeps ${current} Hz`;
    for (;;) {
        const answer = await ctx.reader.ask(`Sampling rate (1-${rates.length}${hint}): `);
        if (answer === undefined) throw new InputClosed();
        const parsed = parseRateChoice(answer, rates, current);
        if (typeof parsed === 'number') return parsed;
        ctx.out.write(`${parsed}\n`);
    }
}

/** The seconds question. Honours `--seconds` (already validated by `args.ts` with the same `parseSeconds`). */
export async function askSeconds(flag: number | undefined, ctx: PromptContext): Promise<number> {
    if (flag !== undefined) return flag;
    if (ctx.reader === undefined) throw new AnswerRequired('--seconds');
    for (;;) {
        const answer = await ctx.reader.ask(`Recording time in seconds (${SECONDS_MIN}–${SECONDS_MAX}): `);
        if (answer === undefined) throw new InputClosed();
        const parsed = parseSeconds(answer);
        if (typeof parsed === 'number') return parsed;
        ctx.out.write(`${parsed}\n`);
    }
}

/** One answer to the `--single` question: `true` single, `false` pair, `undefined` not understood. */
export function parseYesNo(text: string): boolean | undefined {
    const answer = text.trim().toLowerCase();
    if (answer === '' || answer === 'n' || answer === 'no') return false;
    if (answer === 'y' || answer === 'yes') return true;
    return undefined;
}

/**
 * A pair type records BOTH sensors (LEFT and RIGHT) unless `--single` is given or the user answers
 * "y" to "Use a single plate? [y/N]". Not a pair type: `false`, nothing asked. `--single` given: `true`,
 * nothing asked. No terminal to ask on: the default, a pair (`false`).
 */
export async function askSingle(flag: boolean, type: DeviceType, ctx: PromptContext): Promise<boolean> {
    if (!isPairType(type)) return false;
    if (flag) return true;
    if (ctx.reader === undefined) return false;
    for (;;) {
        const answer = await ctx.reader.ask(`Use a single ${singleNounOf(type)}? [y/N] `);
        if (answer === undefined) throw new InputClosed();
        const parsed = parseYesNo(answer);
        if (parsed !== undefined) return parsed;
        ctx.out.write('Please type y or n.\n');
    }
}

/**
 * The types a jump test is offered for: K-Deltas (`HEXAS`: the samples become one value, `forceTotal`),
 * K-Plates (`PLATES`: a V3 plate keeps its four values, and the file records that nothing changed) and
 * K-Deltas 3D (nothing changes: nine values). The other types have no jump test. The SDK exports no such list.
 */
const JUMP_TYPES: ReadonlySet<DeviceType> = new Set<DeviceType>([DeviceType.HEXAS, DeviceType.PLATES, DeviceType.DELTAS_3D]);

/** Whether a jump test may be asked for with `type`. */
export function canJump(type: DeviceType): boolean {
    return JUMP_TYPES.has(type);
}

/** Why `--jump` is refused for `type`. */
export function jumpRefusedMessage(type: DeviceType): string {
    return `--jump: only for K-Deltas (HEXAS), K-Deltas 3D (DELTAS_3D) and K-Plates (PLATES); a ${labelOf(type)} (${type}) has no jump test.`;
}

/**
 * Whether this recording is a jump test. Not a jump type: `false`, nothing asked (`--jump` is refused
 * before, in `run.ts`). `--jump` or `--normal` given: that answer, nothing asked. No terminal to ask on: the
 * default, a normal test. Otherwise "Jump test (total force at a high rate)? [y/N]".
 */
export async function askJump(flag: 'jump' | 'normal' | undefined, type: DeviceType, ctx: PromptContext): Promise<boolean> {
    if (!canJump(type)) return false;
    if (flag !== undefined) return flag === 'jump';
    if (ctx.reader === undefined) return false;
    for (;;) {
        const answer = await ctx.reader.ask('Jump test (total force at a high rate)? [y/N] ');
        if (answer === undefined) throw new InputClosed();
        const parsed = parseYesNo(answer);
        if (parsed !== undefined) return parsed;
        ctx.out.write('Please type y or n.\n');
    }
}

/**
 * The real reader over a terminal. `onInterrupt` is called on Ctrl-C: in a terminal, readline consumes
 * the key itself, so no SIGINT reaches the process while a question is open.
 */
export function terminalReader(
    input: NodeJS.ReadableStream,
    output: NodeJS.WritableStream,
    onInterrupt: () => void,
): LineReader & {close(): void} {
    const rl = createInterface({input, output, terminal: true});
    let closed = false;
    let pending: AbortController | undefined;
    rl.on('SIGINT', () => onInterrupt());
    rl.on('close', () => {
        closed = true;
        pending?.abort();
    });
    return {
        async ask(prompt: string): Promise<string | undefined> {
            if (closed) return undefined;
            pending = new AbortController();
            try {
                return await rl.question(prompt, {signal: pending.signal});
            } catch {
                // Aborted by `close` (Ctrl-D) or by `close()` below on the way out.
                return undefined;
            } finally {
                pending = undefined;
            }
        },
        close(): void {
            if (!closed) rl.close();
        },
    };
}
