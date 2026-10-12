/**
 * FOR INTEGRATORS: Terminal plumbing, no SDK call. A program with its own UI does not need this file; skip it on a first read. It shows how a value is labelled: `channels[field.index]`, then the
 * field's unit after it.
 *
 * The live view: pure formatting functions, and a small writer
 * that refreshes the block in place on a terminal.
 *
 *   K-Grip (GRIP)  ·  75 Hz set (device configuration)  ·  74 Hz measured  ·  150 samples  ·  2.0 s elapsed, 3.0 s left
 *     force1      12.35 kg
 *     data loss: 1 gap on the stream (2 frames missed)
 *
 * ONE LINE PER FIELD: the name left-aligned, the value right-aligned to {@link VALUE_WIDTH} characters
 * with a fixed number of decimals per unit ({@link decimalsFor}), one space, then the unit symbol. The
 * value of a field is the latest sample's `channels[field.index]`; the field table comes from
 * `units/source.ts`, so this file knows no index and no unit of any device type.
 *
 * On a terminal the block is redrawn in place with ANSI "cursor up" and "clear line" (no UI library).
 * When stdout is not a terminal (piped, CI) one plain line is written per second, with no escape code.
 *
 * Two or more devices (a K-Plates or K-Deltas pair): the elapsed and remaining time once, then a block
 * per device, each with its title (the Bluetooth name with the side), its set and measured rate, its sample
 * count, its fields with the unit to the right of the value, and its own loss note:
 *
 *   K-Plates (PLATES)  ·  2 devices  ·  2.0 s elapsed, 3.0 s left
 *     K-Plate Left  ·  75 Hz set (device configuration)  ·  74 Hz measured  ·  150 samples
 *       force1      12.35 kg
 *     K-Plate Right  ·  75 Hz set (device configuration)  ·  74 Hz measured  ·  148 samples
 *       force1       3.10 kg
 *
 * One device keeps the single block above, unchanged.
 */
import {StreamUnit, type StreamField} from '@kinvent/companion-sdk';
import {unitSymbol} from './units/source.js';
import type {Clock} from './timer.js';

/** The width the value is right-aligned to. Fits `-99999.999`. A wider value is shown whole, never cut. */
export const VALUE_WIDTH = 10;

/**
 * Decimals per unit. kg and mbar: 2. The others, chosen here:
 * µV 1, ° 1, m 3 (millimetres), m/s 2, m/s² 2. A `Record`, so a new member of the
 * enum does not compile until it has a value.
 */
const DECIMALS: Readonly<Record<StreamUnit, number>> = {
    [StreamUnit.KILOGRAM]: 2,
    [StreamUnit.MILLIBAR]: 2,
    [StreamUnit.MICROVOLT]: 1,
    [StreamUnit.DEGREE]: 1,
    [StreamUnit.METER]: 3,
    [StreamUnit.METER_PER_SECOND]: 2,
    [StreamUnit.METER_PER_SECOND_SQUARED]: 2,
};

export function decimalsFor(unit: StreamUnit): number {
    return (DECIMALS as Record<string, number | undefined>)[unit] ?? 2;
}

/** A value with its unit's decimals; `--` when there is none yet. Never `-0.00`. */
export function formatValue(value: number | undefined, unit: StreamUnit): string {
    if (value === undefined || !Number.isFinite(value)) return '--';
    const text = value.toFixed(decimalsFor(unit));
    return /^-0(\.0+)?$/.test(text) ? text.slice(1) : text;
}

/** One line per field: name left-aligned to the longest name, value right-aligned, then the unit. */
export function fieldLines(fields: readonly StreamField[], channels: readonly number[] | undefined): string[] {
    const nameWidth = Math.max(0, ...fields.map((field) => field.name.length));
    return fields.map((field) => {
        const value = formatValue(channels?.[field.index], field.unit);
        return `  ${field.name.padEnd(nameWidth)}  ${value.padStart(VALUE_WIDTH)} ${unitSymbol(field.unit)}`;
    });
}

/** Where the set rate was read. */
export type RateSource = 'device configuration' | 'companion setting';

export interface SetRate {
    hz: number | undefined;
    source: RateSource | undefined;
}

/** Everything one frame of the live view shows. */
export interface LiveState {
    title: string;
    fields: readonly StreamField[];
    setRate: SetRate;
    measuredHz: number;
    samples: number;
    elapsedMs: number;
    totalMs: number;
    /** The latest sample's channels; `undefined` before the first sample. */
    channels: readonly number[] | undefined;
    gapEvents: number;
    missedFrames: number;
    lossEvents: number;
    lostFrames: number;
}

/** What one device of a multi-device recording shows. */
export interface DeviceLiveState {
    /** The Bluetooth name with the side, for example "K-Plate Left". */
    title: string;
    fields: readonly StreamField[];
    setRate: SetRate;
    measuredHz: number;
    samples: number;
    channels: readonly number[] | undefined;
    gapEvents: number;
    missedFrames: number;
    lossEvents: number;
    lostFrames: number;
}

/** Everything one frame of the multi-device live view shows. */
export interface MultiLiveState {
    title: string;
    elapsedMs: number;
    totalMs: number;
    devices: readonly DeviceLiveState[];
}

function seconds(ms: number): string {
    return (ms / 1000).toFixed(1);
}

function setRateText(rate: SetRate): string {
    return rate.hz === undefined ? 'set rate unknown' : `${rate.hz} Hz set (${rate.source})`;
}

export function headerLine(state: LiveState): string {
    return [
        state.title,
        setRateText(state.setRate),
        `${Math.round(state.measuredHz)} Hz measured`,
        `${state.samples} samples`,
        `${seconds(state.elapsedMs)} s elapsed, ${seconds(state.totalMs - state.elapsedMs)} s left`,
    ].join('  ·  ');
}

function plural(count: number, one: string, many: string): string {
    return `${count} ${count === 1 ? one : many}`;
}

/** The data-loss note, or `undefined` when nothing was lost. */
export function lossText(state: Pick<LiveState, 'gapEvents' | 'missedFrames' | 'lossEvents' | 'lostFrames'>): string | undefined {
    const parts: string[] = [];
    if (state.gapEvents > 0) {
        parts.push(`${plural(state.gapEvents, 'gap', 'gaps')} on the stream (${plural(state.missedFrames, 'frame', 'frames')} missed)`);
    }
    if (state.lossEvents > 0) {
        parts.push(`${plural(state.lossEvents, 'drop', 'drops')} by the companion (${plural(state.lostFrames, 'frame', 'frames')} lost)`);
    }
    return parts.length === 0 ? undefined : `data loss: ${parts.join(', ')}`;
}

/** The block for a terminal: header, one line per field, then the loss note if any. */
export function renderBlock(state: LiveState): string[] {
    const lines = [headerLine(state), ...fieldLines(state.fields, state.channels)];
    const loss = lossText(state);
    if (loss !== undefined) lines.push(`  ${loss}`);
    return lines;
}

/** The plain line written once per second when stdout is not a terminal. No escape code. */
export function renderSingleLine(state: LiveState): string {
    const values = state.fields.map(
        (field) => `${field.name} ${formatValue(state.channels?.[field.index], field.unit)} ${unitSymbol(field.unit)}`,
    );
    const loss = lossText(state);
    return [
        `${seconds(state.elapsedMs)}/${seconds(state.totalMs)} s`,
        setRateText(state.setRate),
        `${Math.round(state.measuredHz)} Hz measured`,
        `${state.samples} samples`,
        ...values,
        ...(loss === undefined ? [] : [loss]),
    ].join('  |  ');
}

/** The header line of the multi-device view; the time appears here once. */
export function multiHeaderLine(state: MultiLiveState): string {
    return [
        state.title,
        `${state.devices.length} devices`,
        `${seconds(state.elapsedMs)} s elapsed, ${seconds(state.totalMs - state.elapsedMs)} s left`,
    ].join('  ·  ');
}

/** One device's line in the multi-device view. */
export function deviceHeaderLine(device: DeviceLiveState): string {
    return `  ${[device.title, setRateText(device.setRate), `${Math.round(device.measuredHz)} Hz measured`, `${device.samples} samples`].join('  ·  ')}`;
}

/** The multi-device block for a terminal: the header once, then per device its line, its fields, its loss note. */
export function renderMultiBlock(state: MultiLiveState): string[] {
    const lines = [multiHeaderLine(state)];
    for (const device of state.devices) {
        lines.push(deviceHeaderLine(device), ...fieldLines(device.fields, device.channels).map((line) => `  ${line}`));
        const loss = lossText(device);
        if (loss !== undefined) lines.push(`    ${loss}`);
    }
    return lines;
}

/** The plain once-a-second line of the multi-device view. No escape code. */
export function renderMultiSingleLine(state: MultiLiveState): string {
    const parts = [`${seconds(state.elapsedMs)}/${seconds(state.totalMs)} s`];
    for (const device of state.devices) {
        const values = device.fields.map(
            (field) => `${field.name} ${formatValue(device.channels?.[field.index], field.unit)} ${unitSymbol(field.unit)}`,
        );
        const loss = lossText(device);
        parts.push(
            [`${device.title}: ${setRateText(device.setRate)}`, `${Math.round(device.measuredHz)} Hz measured`, `${device.samples} samples`, ...values, ...(loss === undefined ? [] : [loss])].join(', '),
        );
    }
    return parts.join('  |  ');
}

const ESC = '\u001b[';

/** Moves the cursor up over the `previous` lines drawn last time, then clears and writes each line. */
export function ansiRedraw(previous: number, lines: readonly string[]): string {
    const up = previous > 0 ? `${ESC}${previous}A` : '';
    return up + lines.map((line) => `\r${ESC}2K${line}\n`).join('');
}

/** The countdown's text for one number. On a terminal it is rewritten in place. */
export function countdownText(remaining: number): string {
    return `Starting in ${remaining}…`;
}

export interface Writer {
    write(text: string): void;
}

/** How often the block may be redrawn on a terminal (about 10 times a second). */
export const TTY_REFRESH_MS = 100;
/** How often a plain line is written when stdout is not a terminal. */
export const PLAIN_REFRESH_MS = 1000;

/**
 * Writes the live state: in place on a terminal, at most every {@link TTY_REFRESH_MS}; one plain line
 * every {@link PLAIN_REFRESH_MS} otherwise. `finish` always writes the final state once.
 */
export class LiveView {
    private drawn = 0;
    private lastAt: number | undefined;

    constructor(
        private readonly out: Writer,
        private readonly tty: boolean,
        private readonly clock: Clock,
    ) {}

    update(state: LiveState | MultiLiveState): void {
        const now = this.clock.now();
        const every = this.tty ? TTY_REFRESH_MS : PLAIN_REFRESH_MS;
        if (this.lastAt !== undefined && now - this.lastAt < every) return;
        this.lastAt = now;
        this.draw(state);
    }

    finish(state: LiveState | MultiLiveState): void {
        this.lastAt = this.clock.now();
        this.draw(state);
    }

    private draw(state: LiveState | MultiLiveState): void {
        const multi = 'devices' in state;
        if (this.tty) {
            const lines = multi ? renderMultiBlock(state) : renderBlock(state);
            // A block that shrank (a loss note cannot disappear, but be safe) leaves no stale line behind.
            while (lines.length < this.drawn) lines.push('');
            this.out.write(ansiRedraw(this.drawn, lines));
            this.drawn = lines.length;
        } else {
            this.out.write(`${multi ? renderMultiSingleLine(state) : renderSingleLine(state)}\n`);
        }
    }
}
