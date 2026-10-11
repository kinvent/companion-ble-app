/**
 * FOR INTEGRATORS: No SDK call. Copy it if you need a CSV file that the Kinvent tools read (the mobile app's export
 * layout); the format is described for users in GUIDE.md section 9. The file is health data: mode 0600.
 *
 * The recorder: one CSV file per recording.
 *
 * LAYOUT. The same layout as the Kinvent mobile app's CSV export, with the `CHANNEL_n` columns that export
 * writes. Cells are encoded as the Kinvent CSV exports encode them: every TEXT cell quoted, inner quotes
 * doubled, a leading `= + - @ TAB CR` guarded with `'` unless the cell is only dashes; NUMERIC cells raw.
 * Rows joined with `,`, lines with `\n`, UTF-8 without a byte-order mark.
 *
 *   1. traceability row          written by `open`
 *   2. Session Date / Session Time (local time)
 *   3. Configuration block
 *   4. Channels block            (field name, unit symbol, StreamUnit member, per CHANNEL_n)
 *   5. blank row, "Raw Channel Data"
 *      "Time at time zero", device-title row, "Time (sec)" header   written with the FIRST batch (the
 *                                time zero is the wall clock of the first sample), or at `end` when no
 *                                sample arrived, so the table head is always there
 *      one row per sample        written by `append`, one write per batch (a batch boundary)
 *   6. blank row, "Summary"      written by `end`, unless the file could not be written
 *
 * TWO OR MORE DEVICES: the ALIGNED version of the mobile export's multi-device
 * layout.
 * Each device owns a block of columns: a spacer column (for the first device it is `Time (sec)`), then its
 * `CHANNEL_1..N` (numbered per device). The device-title row puts each device's title over its
 * `CHANNEL_1`. Rows are joined BY INDEX, not by time, as the export does: row i holds every device's i-th
 * sample; the longest device sets the row count, a shorter one is padded with empty cells of its width.
 * The time column is the FIRST (left) device's relative time. Unlike the export, no row carries an extra
 * trailing cell: every row has the header's width. A one-device recording keeps the layout above, byte
 * for byte.
 *
 * A JUMP TEST: the layout becomes final only when the measurement starts (the
 * companion changes a K-Deltas to one value, `forceTotal`, at the first `measureStart` and sends `stream.layout`).
 * So when `facts.jump` is given, `open` creates the file but writes NOTHING: every row from the traceability
 * row to the table head waits, and the batches that arrive meanwhile wait in memory, until `settleLayout`
 * hands over each device's final layout (fields, set rate, mode, protocol). Then the preamble is written from
 * those facts, the Configuration gains "Exercise type", "Mode" and "Jump protocol" rows, and the waiting
 * batches follow. If the recording ends before that, `end` writes it from the facts it has (mode and protocol
 * "unknown"). Without `facts.jump` nothing of this happens.
 *
 * DATA PROTECTION. The file holds sensor data of a person. The folder is created
 * with mode 0o700 when it does not exist (an existing folder is left as it is); the file is created with
 * mode 0o600 and flag `wx`, so an existing file is never overwritten: the next free name gets `-2`, `-3`, ….
 * The name is `<DEVICE TYPE>-<yyyyMMdd-HHmmss>.csv`, local time, with no identifier. The serial code is
 * written only when the caller passes it (`--include-serial`), and only in the traceability row.
 */
import {open as openFile, mkdir} from 'node:fs/promises';
import {join, resolve} from 'node:path';
import type {Writable} from 'node:stream';
import {JUMP_MODE, type ForceSample, type StreamField} from '@kinvent/companion-sdk';
import {unitSymbol} from './units/source.js';

// ---------------------------------------------------------------------------------------------------
// Cell encoding: as the Kinvent CSV exports encode a cell.
// ---------------------------------------------------------------------------------------------------

/** A cell that is nothing but dashes cannot start a formula, so it is not guarded. */
const DASH_ONLY = /^[-–—]+$/;

/** A TEXT cell: quoted, inner quotes doubled, a leading formula trigger (= + - @ TAB CR) guarded with `'`. */
export function csvText(value: unknown): string {
    let text = String(value ?? '');
    if (/^[=+\-@\t\r]/.test(text) && !DASH_ONLY.test(text)) {
        text = `'${text}`;
    }
    return `"${text.replace(/"/g, '""')}"`;
}

/** A NUMERIC cell: raw, never quoted, never guarded (a leading `-` is a negative value). */
export function csvNum(value: unknown): string {
    return String(value ?? '');
}

/** One row of already-encoded cells. */
export function csvRow(cells: readonly string[]): string {
    return cells.join(',');
}

// ---------------------------------------------------------------------------------------------------
// Value and time formatting.
// ---------------------------------------------------------------------------------------------------

/** Seconds since the first sample, as a plain decimal string: `(timeStamp - first) / 1000`. */
export function formatSeconds(timeStamp: number, firstTimeStamp: number): string {
    return String((timeStamp - firstTimeStamp) / 1000);
}

/** A channel value, as received (no unit conversion), with 15 decimals. A slot the frame lacks is empty. */
export function formatChannel(value: number | undefined): string {
    return value === undefined ? '' : value.toFixed(15);
}

const pad = (n: number, width = 2): string => String(n).padStart(width, '0');

/** `yyyy-MM-dd`, local time. */
export function formatDate(at: Date): string {
    return `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`;
}

/** `HH:mm:ss`, local time. */
export function formatTimeOfDay(at: Date): string {
    return `${pad(at.getHours())}:${pad(at.getMinutes())}:${pad(at.getSeconds())}`;
}

/** `HH:mm:ss:SSS`, local time (the exports' "Time at time zero"). */
export function formatTimeOfDayMs(at: Date): string {
    return `${formatTimeOfDay(at)}:${pad(at.getMilliseconds(), 3)}`;
}

/** `<DEVICE TYPE>-<yyyyMMdd-HHmmss>`, local time; `-<n>` for the n-th file of the same second. */
export function fileBaseName(deviceType: string, at: Date, attempt = 1): string {
    const stamp =
        `${at.getFullYear()}${pad(at.getMonth() + 1)}${pad(at.getDate())}-` +
        `${pad(at.getHours())}${pad(at.getMinutes())}${pad(at.getSeconds())}`;
    return `${deviceType}-${stamp}${attempt > 1 ? `-${attempt}` : ''}.csv`;
}

// ---------------------------------------------------------------------------------------------------
// The rows.
// ---------------------------------------------------------------------------------------------------

/** What the preamble says. Everything is known before `measureStart`. */
export interface RecordingFacts {
    sampleVersion: string;
    companionVersion: string;
    sdkVersion: string;
    /** The `DeviceType` member, for example `MUSCLE_TESTER`. */
    deviceType: string;
    /** The product name, for example `K-Push`. */
    deviceTitle: string;
    /** Only with `--include-serial`. `null`: the flag was given and the device reported none. */
    serialCode?: string | null | undefined;
    seconds: number;
    /** The set rate in Hz; `undefined` when neither the device nor the companion said. */
    sampleRateHz: number | undefined;
    countdownSeconds: number;
    fields: readonly StreamField[];
    /**
     * The devices of the recording, in column order (left first). TWO OR MORE select the multi-device
     * layout, and then only these describe the devices (the single-device `deviceTitle`, `serialCode`,
     * `sampleRateHz` and `fields` above are not read). Absent or one entry: the single-device layout.
     */
    devices?: readonly DeviceFacts[] | undefined;
    /**
     * A jump test. Present: the head of the file waits for `Recorder.settleLayout` (see the file header) and
     * the Configuration gains the jump rows. Absent: no jump row.
     */
    jump?: JumpFacts | undefined;
}

/** What a jump test records about one device, from the layout in force once the measurement started. */
export interface JumpDeviceFacts {
    /** The layout's `mode`: `'jump'` (`JUMP_MODE`) on a jump protocol, `null` otherwise; `undefined`: not known. */
    mode: string | null | undefined;
    /** Whether the device's `protocolType` is a jump protocol; `undefined`: not known. */
    jumpProtocol: boolean | undefined;
}

/** The jump facts of a recording, one entry per device in column order. */
export interface JumpFacts {
    devices: readonly JumpDeviceFacts[];
}

/** One device's layout once the measurement started, handed to `Recorder.settleLayout`. */
export interface FinalLayout {
    fields: readonly StreamField[];
    /** The set rate of the final configuration; `undefined` keeps the rate known at ready. */
    sampleRateHz: number | undefined;
    mode: string | null | undefined;
    jumpProtocol: boolean | undefined;
}

/** The "Mode" cell: `jump` for the jump layout, `normal` for any other, `unknown` when not known. */
export function modeText(mode: string | null | undefined): string {
    return mode === undefined ? 'unknown' : mode === JUMP_MODE ? 'jump' : 'normal';
}

/** The "Jump protocol" cell. */
export function jumpProtocolText(jumpProtocol: boolean | undefined): string {
    return jumpProtocol === undefined ? 'unknown' : jumpProtocol ? 'yes' : 'no';
}

/** The exercise type a jump test sends (the only one the sample ever sends; `companion.ts`). */
export const JUMP_EXERCISE_TYPE = 'JUMP_ANALYSIS';

/**
 * The jump rows of the Configuration. One device: "Exercise type", "Mode", "Jump protocol". Two or more:
 * one "Mode" row when the devices agree, else one per device; one "Jump protocol (<title>)" row per device.
 */
export function jumpLines(jump: JumpFacts, titles?: readonly string[]): string[] {
    const lines = [csvRow([csvText('Exercise type'), csvText(JUMP_EXERCISE_TYPE)])];
    if (titles === undefined) {
        const device = jump.devices[0];
        lines.push(csvRow([csvText('Mode'), csvText(modeText(device?.mode))]));
        lines.push(csvRow([csvText('Jump protocol'), csvText(jumpProtocolText(device?.jumpProtocol))]));
        return lines;
    }
    const modes = titles.map((_, k) => modeText(jump.devices[k]?.mode));
    if (modes.every((mode) => mode === modes[0])) {
        lines.push(csvRow([csvText('Mode'), csvText(modes[0] ?? 'unknown')]));
    } else {
        lines.push(...titles.map((title, k) => csvRow([csvText(`Mode (${title})`), csvText(modes[k]!)])));
    }
    lines.push(...titles.map((title, k) => csvRow([csvText(`Jump protocol (${title})`), csvText(jumpProtocolText(jump.devices[k]?.jumpProtocol))])));
    return lines;
}

/** One device of a multi-device recording. */
export interface DeviceFacts {
    /** The Bluetooth name with the side, for example "K-Plate Left". */
    title: string;
    /** As {@link RecordingFacts.serialCode}: only with `--include-serial`. */
    serialCode?: string | null | undefined;
    fields: readonly StreamField[];
    sampleRateHz: number | undefined;
    /** `DeviceConfiguration.timeSynced`: `false` is written as "Time sync (<title>)","not confirmed". */
    timeSynced?: boolean | null | undefined;
}

/** Whether `facts` select the multi-device layout. */
export function isMultiDevice(facts: Pick<RecordingFacts, 'devices'>): facts is {devices: readonly DeviceFacts[]} {
    return facts.devices !== undefined && facts.devices.length >= 2;
}

/** The device cell of the traceability row: the title, and the serial only when it was asked for. */
export function deviceCell(facts: Pick<RecordingFacts, 'deviceTitle' | 'serialCode'>): string {
    if (facts.serialCode === undefined) return facts.deviceTitle;
    return `${facts.deviceTitle} (serial ${facts.serialCode ?? 'not reported'})`;
}

/** Rows 1-4 and the start of row group 5 ("Raw Channel Data"), each a full line without its `\n`. */
export function preambleLines(facts: RecordingFacts, startedAt: Date): string[] {
    const channel = (i: number): string => `CHANNEL_${i + 1}`;
    return [
        csvRow([
            csvText(`Kinvent Companion CLI sample ${facts.sampleVersion}`),
            csvText(`Companion ${facts.companionVersion}`),
            csvText(`companion-sdk ${facts.sdkVersion}`),
            csvText('Devices:'),
            csvText(deviceCell(facts)),
        ]),
        csvRow([csvText('Session Date'), csvText(formatDate(startedAt))]),
        csvRow([csvText('Session Time'), csvText(formatTimeOfDay(startedAt))]),
        csvRow([csvText('Configuration')]),
        csvRow([csvText('Device type'), csvText(facts.deviceType)]),
        csvRow([csvText('Recording time (sec)'), csvNum(facts.seconds)]),
        csvRow([csvText('Sample rate set (Hz)'), facts.sampleRateHz === undefined ? csvText('unknown') : csvNum(facts.sampleRateHz)]),
        csvRow([csvText('Countdown (sec)'), csvNum(facts.countdownSeconds)]),
        ...(facts.jump === undefined ? [] : jumpLines(facts.jump)),
        csvRow([csvText('Channels')]),
        csvRow([csvText('Column'), csvText('Field'), csvText('Unit'), csvText('Unit code')]),
        ...facts.fields.map((field, i) =>
            csvRow([csvText(channel(i)), csvText(field.name), csvText(unitSymbol(field.unit)), csvText(field.unit)]),
        ),
        '',
        csvRow([csvText('Raw Channel Data')]),
    ];
}

/** The table head: time zero, the device-title row, the header row. `timeZero` undefined: no sample came. */
export function tableHeadLines(facts: Pick<RecordingFacts, 'deviceTitle' | 'fields'>, timeZero: Date | undefined): string[] {
    const n = facts.fields.length;
    return [
        csvRow([csvText('Time at time zero'), csvText(timeZero === undefined ? '' : formatTimeOfDayMs(timeZero))]),
        csvRow([csvText(''), csvText(facts.deviceTitle), ...Array.from({length: Math.max(0, n - 1)}, () => csvText(''))]),
        csvRow([csvText('Time (sec)'), ...facts.fields.map((_, i) => csvText(`CHANNEL_${i + 1}`))]),
    ];
}

/** One sample row: seconds since the first sample, then each field's channel in descriptor order. */
export function sampleLine(fields: readonly StreamField[], sample: ForceSample, firstTimeStamp: number): string {
    return csvRow([
        csvNum(formatSeconds(sample.timeStamp, firstTimeStamp)),
        ...fields.map((field) => csvNum(formatChannel(sample.channels[field.index]))),
    ]);
}

// ---------------------------------------------------------------------------------------------------
// The multi-device layout (two or more devices).
// ---------------------------------------------------------------------------------------------------

/** The note of the Channels section: how the devices' rows are put side by side. */
export function joinNote(firstTitle: string): string {
    return `Rows are joined by index, as the Kinvent app's export does, not by timestamp. Time (sec) is the ${firstTitle}'s.`;
}

/** Rows 1-4 and the start of row group 5 for two or more devices. */
export function multiPreambleLines(facts: RecordingFacts & {devices: readonly DeviceFacts[]}, startedAt: Date): string[] {
    const devices = facts.devices;
    const rates = devices.map((device) => device.sampleRateHz);
    const rateCell = (hz: number | undefined): string => (hz === undefined ? csvText('unknown') : csvNum(hz));
    const sameRate = rates.every((hz) => hz === rates[0]);
    return [
        csvRow([
            csvText(`Kinvent Companion CLI sample ${facts.sampleVersion}`),
            csvText(`Companion ${facts.companionVersion}`),
            csvText(`companion-sdk ${facts.sdkVersion}`),
            csvText('Devices:'),
            ...devices.map((device) => csvText(deviceCell({deviceTitle: device.title, serialCode: device.serialCode}))),
        ]),
        csvRow([csvText('Session Date'), csvText(formatDate(startedAt))]),
        csvRow([csvText('Session Time'), csvText(formatTimeOfDay(startedAt))]),
        csvRow([csvText('Configuration')]),
        csvRow([csvText('Device type'), csvText(facts.deviceType)]),
        csvRow([csvText('Recording time (sec)'), csvNum(facts.seconds)]),
        ...(sameRate
            ? [csvRow([csvText('Sample rate set (Hz)'), rateCell(rates[0])])]
            : devices.map((device) => csvRow([csvText(`Sample rate set (Hz) (${device.title})`), rateCell(device.sampleRateHz)]))),
        csvRow([csvText('Countdown (sec)'), csvNum(facts.countdownSeconds)]),
        ...devices
            .filter((device) => device.timeSynced === false)
            .map((device) => csvRow([csvText(`Time sync (${device.title})`), csvText('not confirmed')])),
        ...(facts.jump === undefined ? [] : jumpLines(facts.jump, devices.map((device) => device.title))),
        csvRow([csvText('Channels')]),
        csvRow([csvText('Column'), csvText('Device'), csvText('Field'), csvText('Unit'), csvText('Unit code')]),
        ...devices.flatMap((device) =>
            device.fields.map((field, i) =>
                csvRow([csvText(`CHANNEL_${i + 1}`), csvText(device.title), csvText(field.name), csvText(unitSymbol(field.unit)), csvText(field.unit)]),
            ),
        ),
        csvRow([csvText('Join'), csvText(joinNote(devices[0]!.title))]),
        '',
        csvRow([csvText('Raw Channel Data')]),
    ];
}

/** The width of a device's column block: its spacer column (the time for the first device) and its channels. */
export function blockWidth(device: Pick<DeviceFacts, 'fields'>): number {
    return device.fields.length + 1;
}

/**
 * The multi-device table head: time zero (the FIRST device's first sample), the device-title row (each
 * title over its device's `CHANNEL_1`), the header row (`Time (sec)` or an empty spacer, then
 * `CHANNEL_1..N` per device). Every row has the same width, the sum of the blocks.
 */
export function multiTableHeadLines(devices: readonly Pick<DeviceFacts, 'title' | 'fields'>[], timeZero: Date | undefined): string[] {
    return [
        csvRow([csvText('Time at time zero'), csvText(timeZero === undefined ? '' : formatTimeOfDayMs(timeZero))]),
        csvRow(devices.flatMap((device) => [csvText(''), csvText(device.title), ...Array.from({length: Math.max(0, device.fields.length - 1)}, () => csvText(''))])),
        csvRow(devices.flatMap((device, k) => [csvText(k === 0 ? 'Time (sec)' : ''), ...device.fields.map((_, i) => csvText(`CHANNEL_${i + 1}`))])),
    ];
}

/** One device's cells of a data row: the time (first device) or an empty spacer, then its channels. */
export function deviceCells(deviceIndex: number, fields: readonly StreamField[], sample: ForceSample, firstTimeStamp: number): string[] {
    return [
        deviceIndex === 0 ? csvNum(formatSeconds(sample.timeStamp, firstTimeStamp)) : csvText(''),
        ...fields.map((field) => csvNum(formatChannel(sample.channels[field.index]))),
    ];
}

/** The cells of a device that has no sample at a row index: empty cells of its block's width. */
export function fillerCells(device: Pick<DeviceFacts, 'fields'>): string[] {
    return Array.from({length: blockWidth(device)}, () => csvText(''));
}

/** One device's line of the multi-device Summary. */
export interface DeviceSummary {
    title: string;
    rows: number;
    measuredHz: number | undefined;
    samplesLost: number;
    gaps: number;
}

/** Row group 6 for two or more devices: the table's row count, then each figure per device, then the reason. */
export function multiSummaryLines(summary: {rows: number; devices: readonly DeviceSummary[]; reason: EndReason}): string[] {
    const per = (label: string, cell: (device: DeviceSummary) => string): string[] =>
        summary.devices.map((device) => csvRow([csvText(`${label} (${device.title})`), cell(device)]));
    return [
        '',
        csvRow([csvText('Summary')]),
        csvRow([csvText('Rows'), csvNum(summary.rows)]),
        ...per('Rows', (device) => csvNum(device.rows)),
        ...per('Sample rate measured (Hz)', (device) => (device.measuredHz === undefined ? csvText('-') : csvNum(formatMeasuredRate(device.measuredHz)))),
        ...per('Samples lost', (device) => csvNum(device.samplesLost)),
        ...per('Gaps', (device) => csvNum(device.gaps)),
        csvRow([csvText('End reason'), csvText(summary.reason)]),
    ];
}

/** Why the recording ended, or a write error's own words. */
export type EndReason = 'time end' | 'Ctrl-C' | 'device lost' | 'session lost' | 'disk full' | (string & {});

export interface SummaryFacts {
    rows: number;
    /** The rate of the rows, from {@link measuredRateHz}; `undefined` when it cannot be measured. */
    measuredHz: number | undefined;
    samplesLost: number;
    gaps: number;
    reason: EndReason;
}

/**
 * The measured rate of the rows: `(rows − 1) / (last time − first time)` in Hz, the
 * times in seconds as the time column writes them. `undefined` when fewer than two rows exist or the rows
 * span no time. The one function behind both the Summary row and the end-of-run message.
 */
export function measuredRateHz(rows: number, firstSeconds: number, lastSeconds: number): number | undefined {
    const span = lastSeconds - firstSeconds;
    if (rows < 2 || !(span > 0)) return undefined;
    return (rows - 1) / span;
}

/** A measured rate with one decimal: `75.0`. */
export function formatMeasuredRate(hz: number): string {
    return hz.toFixed(1);
}

/** Row group 6. */
export function summaryLines(summary: SummaryFacts): string[] {
    return [
        '',
        csvRow([csvText('Summary')]),
        csvRow([csvText('Rows'), csvNum(summary.rows)]),
        csvRow([
            csvText('Sample rate measured (Hz)'),
            summary.measuredHz === undefined ? csvText('-') : csvNum(formatMeasuredRate(summary.measuredHz)),
        ]),
        csvRow([csvText('Samples lost'), csvNum(summary.samplesLost)]),
        csvRow([csvText('Gaps'), csvNum(summary.gaps)]),
        csvRow([csvText('End reason'), csvText(summary.reason)]),
    ];
}

/**
 * Bytes of one sample row of this encoder, `\n` included, for a representative sample: 1234.567 s into
 * the recording and every field at -12.345678901234567 kg (19 characters with 15 decimals). Measured on
 * the real encoder, not estimated.
 */
export function bytesPerRow(fieldCount: number): number {
    const fields = Array.from({length: fieldCount}, (_, index) => ({index, name: `f${index}`, unit: 'KILOGRAM'}) as StreamField);
    const sample: ForceSample = {timeStamp: 1_234_567, isTimeStampFromEpoch: false, channels: fields.map(() => -12.345678901234567)};
    return Buffer.byteLength(`${sampleLine(fields, sample, 0)}\n`, 'utf8');
}

/** The size estimate of a recording, in bytes. */
export function estimateBytes(rateHz: number, seconds: number, fieldCount: number): number {
    return Math.round(rateHz * seconds * bytesPerRow(fieldCount));
}

/** A recording estimated above this asks for confirmation. */
export const SIZE_WARNING_BYTES = 100 * 1000 * 1000;

/** `12.3 MB`, decimal megabytes. */
export function formatMegabytes(bytes: number): string {
    return `${(bytes / 1_000_000).toFixed(1)} MB`;
}

// ---------------------------------------------------------------------------------------------------
// The writer.
// ---------------------------------------------------------------------------------------------------

/** Opens the file for writing; throws an error with `code: 'EEXIST'` when the name is taken. */
export type OpenSink = (path: string) => Promise<Writable>;

/** The default sink: flag `wx` (never overwrite), mode 0o600, through `node:fs`'s write stream. */
export const openFileSink: OpenSink = async (path) => {
    const handle = await openFile(path, 'wx', 0o600);
    return handle.createWriteStream({encoding: 'utf8'});
};

export interface RecorderOptions {
    /** The folder, as typed (`--out`); resolved against `cwd`. */
    folder: string;
    cwd: string;
    /** Wall clock, epoch milliseconds. A test fixes it. */
    now?: () => number;
    /** A test injects a sink that fails. */
    openSink?: OpenSink;
}

export interface RecorderResult {
    /** Absolute path of the file. */
    path: string;
    /** Sample rows handed to the file. */
    rows: number;
    /** Sample rows the file system confirmed. Equal to `rows` unless writing failed. */
    rowsWritten: number;
    reason: EndReason;
    /** Whether the Summary rows are in the file. */
    summaryWritten: boolean;
    /** The measured rate of the rows ({@link measuredRateHz}); `undefined` below two rows. Multi-device: see `devices`. */
    measuredHz: number | undefined;
    /** The write error, when there was one. */
    error: NodeJS.ErrnoException | undefined;
    /** Two or more devices: each device's samples and measured rate, in column order. */
    devices?: DeviceSummary[] | undefined;
}

/** What the Summary counts as lost. `perDevice` is read only for two or more devices, in column order. */
export interface Losses {
    samplesLost: number;
    gaps: number;
    perDevice?: ReadonlyArray<{samplesLost: number; gaps: number}> | undefined;
}

/** The per-device state of a multi-device recording. */
interface MultiState {
    /** Replaced once by `settleLayout`. */
    devices: readonly DeviceFacts[];
    /** Formatted cells waiting for the other devices' sample of the same index. */
    queues: string[][][];
    counts: number[];
    first: Array<number | undefined>;
    last: Array<number | undefined>;
    timeZero: Date | undefined;
}

/** A write to the recording failed. `reason` is what the Summary would say: `disk full` or the error code. */
export class RecorderWriteError extends Error {
    constructor(
        readonly path: string,
        readonly error: NodeJS.ErrnoException,
    ) {
        super(`Could not write ${path}: ${describeWriteError(error)}.`);
        this.name = 'RecorderWriteError';
    }

    get reason(): EndReason {
        return writeErrorReason(this.error);
    }
}

/** The end reason for a write error: `disk full` for ENOSPC, else `write error (<code>)`. */
export function writeErrorReason(error: NodeJS.ErrnoException): EndReason {
    return error.code === 'ENOSPC' ? 'disk full' : `write error (${error.code ?? error.message})`;
}

function describeWriteError(error: NodeJS.ErrnoException): string {
    switch (error.code) {
        case 'ENOSPC':
            return 'disk full';
        case 'EACCES':
        case 'EPERM':
            return 'permission denied';
        case 'EROFS':
            return 'the disk is read-only';
        default:
            return error.code ?? error.message;
    }
}

/** How many names `-2`, `-3`, … are tried before giving up. */
const MAX_ATTEMPTS = 1000;

export class Recorder {
    private sink: Writable | undefined;
    private filePath: string | undefined;
    private facts: RecordingFacts | undefined;
    private firstTimeStamp: number | undefined;
    private lastTimeStamp: number | undefined;
    private headWritten = false;
    private rows = 0;
    private rowsWritten = 0;
    private failure: NodeJS.ErrnoException | undefined;
    /** Writes run one after the other: an `append` waits for the one before it. */
    private queue: Promise<void> = Promise.resolve();
    private ending: Promise<RecorderResult> | undefined;
    private multi: MultiState | undefined;
    /** When the head waits for the final layout, the batches that arrived meanwhile, with their arrival time. */
    private pending: Array<{batch: ForceSample[]; deviceIndex: number; at: number}> | undefined;
    private startedAt: Date | undefined;
    private readonly now: () => number;
    private readonly openSink: OpenSink;
    /** Set when the name had to be changed because a file of the first name existed. */
    suffixed = false;

    constructor(private readonly options: RecorderOptions) {
        this.now = options.now ?? Date.now;
        this.openSink = options.openSink ?? openFileSink;
    }

    /** The absolute folder the file goes to. */
    get folder(): string {
        return resolve(this.options.cwd, this.options.folder);
    }

    /** The absolute path, once `open` has chosen it. */
    get path(): string | undefined {
        return this.filePath;
    }

    get isOpen(): boolean {
        return this.sink !== undefined;
    }

    /** Sample rows handed to the file so far. */
    get rowCount(): number {
        return this.rows;
    }

    /** Whether the head of the file still waits for `settleLayout`. */
    get headPending(): boolean {
        return this.pending !== undefined;
    }

    /**
     * Creates the folder (0o700) if needed and the file (0o600, never overwriting), and writes rows 1-5's
     * preamble. Rejects with a {@link RecorderWriteError} when the folder or the file cannot be created.
     */
    async open(facts: RecordingFacts): Promise<string> {
        if (this.sink !== undefined || this.ending !== undefined) throw new Error('Recorder.open: already opened');
        this.facts = facts;
        const startedAt = new Date(this.now());
        this.startedAt = startedAt;
        const folder = this.folder;
        try {
            await mkdir(folder, {recursive: true, mode: 0o700});
        } catch (error) {
            throw new RecorderWriteError(folder, error as NodeJS.ErrnoException);
        }
        for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
            const candidate = join(folder, fileBaseName(facts.deviceType, startedAt, attempt));
            try {
                this.sink = await this.openSink(candidate);
                this.filePath = candidate;
                this.suffixed = attempt > 1;
                break;
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code === 'EEXIST') continue;
                throw new RecorderWriteError(candidate, error as NodeJS.ErrnoException);
            }
        }
        if (this.sink === undefined || this.filePath === undefined) {
            throw new RecorderWriteError(join(folder, fileBaseName(facts.deviceType, startedAt)), Object.assign(new Error('no free file name'), {code: 'EEXIST'}));
        }
        // A stream error is kept; the next write or `end` reports it.
        this.sink.on('error', (error: NodeJS.ErrnoException) => {
            this.failure ??= error;
        });
        if (isMultiDevice(facts)) {
            const n = facts.devices.length;
            this.multi = {
                devices: facts.devices,
                queues: Array.from({length: n}, () => []),
                counts: new Array<number>(n).fill(0),
                first: new Array<number | undefined>(n).fill(undefined),
                last: new Array<number | undefined>(n).fill(undefined),
                timeZero: undefined,
            };
        }
        if (facts.jump !== undefined) {
            // Nothing is written until the layout is final (`settleLayout`, or `end`).
            this.pending = [];
            return this.filePath;
        }
        await this.enqueue(isMultiDevice(facts) ? multiPreambleLines(facts, startedAt) : preambleLines(facts, startedAt), 0);
        return this.filePath;
    }

    /**
     * The layout of every device is final (a `stream.layout` event, or the companion's answer once every
     * device sent its first batch). Writes the preamble from `final` (an entry per device in column order;
     * `undefined` keeps what is known), then the batches that waited. Once only; later calls do nothing.
     * Rejects with a {@link RecorderWriteError} when a write fails.
     */
    settleLayout(final: ReadonlyArray<FinalLayout | undefined>): Promise<void> {
        const pending = this.pending;
        if (pending === undefined || this.facts === undefined || this.startedAt === undefined) return this.queue;
        this.pending = undefined;
        const facts = withFinalLayout(this.facts, final);
        this.facts = facts;
        if (this.multi !== undefined && facts.devices !== undefined) this.multi.devices = facts.devices;
        const writes: Array<Promise<void>> = [
            this.enqueue(isMultiDevice(facts) ? multiPreambleLines(facts, this.startedAt) : preambleLines(facts, this.startedAt), 0),
        ];
        for (const entry of pending) writes.push(this.appendAt(entry.batch, entry.deviceIndex, entry.at));
        return Promise.all(writes).then(() => undefined);
    }

    /**
     * Appends one batch: one row per sample, in one write (a batch boundary). The first batch writes the
     * table head first. Rejects with a {@link RecorderWriteError} once a write has failed.
     *
     * Two or more devices: `deviceIndex` is the device's column block (0 = the first, left, device).
     * A row is written once EVERY device has its sample of that index (rows are joined by index); the rest
     * waits in memory and is written, padded, by `end`.
     */
    append(batch: readonly ForceSample[], deviceIndex = 0): Promise<void> {
        if (this.sink === undefined || this.facts === undefined) return Promise.reject(new Error('Recorder.append: not open'));
        if (this.ending !== undefined) return Promise.reject(new Error('Recorder.append: already ended'));
        if (batch.length === 0) return this.queue;
        if (this.pending !== undefined) {
            // The head waits for the final layout; so does the batch (a copy: the caller may reuse it).
            this.pending.push({batch: batch.map((sample) => ({...sample, channels: [...sample.channels]})), deviceIndex, at: this.now()});
            return Promise.resolve();
        }
        return this.appendAt(batch, deviceIndex, this.now());
    }

    /** `append`, with the time the batch reached the recorder (the time zero of samples not from the epoch). */
    private appendAt(batch: readonly ForceSample[], deviceIndex: number, at: number): Promise<void> {
        if (this.facts === undefined) return Promise.reject(new Error('Recorder.append: not open'));
        if (this.multi !== undefined) return this.appendMulti(batch, deviceIndex, this.multi, at);
        const facts = this.facts;
        const lines: string[] = [];
        if (!this.headWritten) {
            const first = batch[0]!;
            this.firstTimeStamp = first.timeStamp;
            lines.push(...tableHeadLines(facts, this.timeZeroOf(first, at)));
            this.headWritten = true;
        }
        const firstTimeStamp = this.firstTimeStamp!;
        for (const sample of batch) lines.push(sampleLine(facts.fields, sample, firstTimeStamp));
        this.rows += batch.length;
        this.lastTimeStamp = batch[batch.length - 1]!.timeStamp;
        return this.enqueue(lines, batch.length);
    }

    /**
     * Ends the file: the Summary rows (unless writing failed), then closes it and waits until it is on
     * disk. Idempotent: a second call returns the first one's result, whatever its reason.
     */
    end(reason: EndReason, losses: Losses = {samplesLost: 0, gaps: 0}): Promise<RecorderResult> {
        this.ending ??= this.finish(reason, losses);
        return this.ending;
    }

    private appendMulti(batch: readonly ForceSample[], deviceIndex: number, multi: MultiState, at: number): Promise<void> {
        const device = multi.devices[deviceIndex];
        if (device === undefined) return Promise.reject(new Error(`Recorder.append: no device ${deviceIndex}`));
        if (multi.first[deviceIndex] === undefined) {
            multi.first[deviceIndex] = batch[0]!.timeStamp;
            // Time zero and the time column are the FIRST device's.
            if (deviceIndex === 0) multi.timeZero = this.timeZeroOf(batch[0]!, at);
        }
        const first = multi.first[deviceIndex]!;
        for (const sample of batch) multi.queues[deviceIndex]!.push(deviceCells(deviceIndex, device.fields, sample, first));
        multi.counts[deviceIndex]! += batch.length;
        multi.last[deviceIndex] = batch[batch.length - 1]!.timeStamp;

        const lines: string[] = [];
        let rows = 0;
        while (multi.queues.every((queue) => queue.length > 0)) {
            if (!this.headWritten) {
                lines.push(...multiTableHeadLines(multi.devices, multi.timeZero));
                this.headWritten = true;
            }
            lines.push(csvRow(multi.queues.flatMap((queue) => queue.shift()!)));
            rows += 1;
        }
        if (rows === 0) return this.queue;
        this.rows += rows;
        return this.enqueue(lines, rows);
    }

    /** The rows still waiting at the end, padded where a device has no sample of that index. */
    private flushMulti(multi: MultiState): {lines: string[]; rows: number} {
        const lines: string[] = [];
        let rows = 0;
        if (!this.headWritten) {
            lines.push(...multiTableHeadLines(multi.devices, multi.timeZero));
            this.headWritten = true;
        }
        while (multi.queues.some((queue) => queue.length > 0)) {
            lines.push(csvRow(multi.queues.flatMap((queue, k) => queue.shift() ?? fillerCells(multi.devices[k]!))));
            rows += 1;
        }
        return {lines, rows};
    }

    /** Each device's samples, measured rate and losses, for the Summary and the result. */
    private deviceSummaries(multi: MultiState, losses: Losses): DeviceSummary[] {
        return multi.devices.map((device, k) => {
            const first = multi.first[k];
            const last = multi.last[k];
            const span = first === undefined || last === undefined ? 0 : Number(formatSeconds(last, first));
            return {
                title: device.title,
                rows: multi.counts[k]!,
                measuredHz: measuredRateHz(multi.counts[k]!, 0, span),
                samplesLost: losses.perDevice?.[k]?.samplesLost ?? 0,
                gaps: losses.perDevice?.[k]?.gaps ?? 0,
            };
        });
    }

    /** The wall clock of the first sample: its own time when it is from the epoch, else the arrival time `at`. */
    private timeZeroOf(first: ForceSample, at: number): Date {
        return new Date(first.isTimeStampFromEpoch ? first.timeStamp : at);
    }

    private enqueue(lines: readonly string[], rows: number): Promise<void> {
        const text = lines.map((line) => `${line}\n`).join('');
        const next = this.queue.then(() => this.write(text)).then(() => {
            this.rowsWritten += rows;
        });
        // The chain itself never rejects, so a later write still runs (and reports the same error).
        this.queue = next.catch(() => undefined);
        return next;
    }

    private write(text: string): Promise<void> {
        const sink = this.sink!;
        const path = this.filePath!;
        if (this.failure !== undefined) return Promise.reject(new RecorderWriteError(path, this.failure));
        return new Promise<void>((resolveWrite, rejectWrite) => {
            const fail = (error: NodeJS.ErrnoException): void => {
                this.failure ??= error;
                rejectWrite(new RecorderWriteError(path, this.failure));
            };
            let flushed = false;
            let drained = true;
            const settle = (): void => {
                if (flushed && drained) resolveWrite();
            };
            const ok = sink.write(text, (error) => {
                if (error) {
                    fail(error as NodeJS.ErrnoException);
                    return;
                }
                flushed = true;
                settle();
            });
            if (!ok) {
                // Back-pressure: wait for `drain` before the next batch is written (no sample is dropped).
                drained = false;
                const onDrain = (): void => {
                    sink.off('error', onError);
                    drained = true;
                    settle();
                };
                const onError = (error: NodeJS.ErrnoException): void => {
                    sink.off('drain', onDrain);
                    fail(error);
                };
                sink.once('drain', onDrain);
                sink.once('error', onError);
            }
        });
    }

    private async finish(reason: EndReason, losses: Losses): Promise<RecorderResult> {
        const path = this.filePath ?? '';
        const sink = this.sink;
        if (sink === undefined || this.facts === undefined) {
            return {path, rows: 0, rowsWritten: 0, reason, summaryWritten: false, measuredHz: undefined, error: undefined};
        }
        // Ended before the layout was settled: the head is written from what is known (mode "unknown").
        if (this.pending !== undefined) await this.settleLayout([]).catch(() => undefined);
        await this.queue;
        if (this.multi !== undefined) return this.finishMulti(reason, losses, this.multi, path, sink);
        const measuredHz = this.measuredHz();
        let summaryWritten = false;
        if (this.failure === undefined) {
            const lines = this.headWritten ? [] : tableHeadLines(this.facts, undefined);
            lines.push(...summaryLines({rows: this.rows, measuredHz, samplesLost: losses.samplesLost, gaps: losses.gaps, reason}));
            this.headWritten = true;
            try {
                await this.enqueue(lines, 0);
                summaryWritten = true;
            } catch {
                summaryWritten = false;
            }
        }
        await closeSink(sink, this.failure !== undefined);
        // A failure while closing (the last bytes could not be flushed) also means the Summary is not on disk.
        return {path, rows: this.rows, rowsWritten: this.rowsWritten, reason, summaryWritten: summaryWritten && this.failure === undefined, measuredHz, error: this.failure};
    }

    /** The end of a multi-device file: the padded rows still waiting, then the Summary, then close. */
    private async finishMulti(reason: EndReason, losses: Losses, multi: MultiState, path: string, sink: Writable): Promise<RecorderResult> {
        const devices = this.deviceSummaries(multi, losses);
        let summaryWritten = false;
        if (this.failure === undefined) {
            const {lines, rows} = this.flushMulti(multi);
            this.rows += rows;
            try {
                await this.enqueue(lines, rows);
                await this.enqueue(multiSummaryLines({rows: this.rows, devices, reason}), 0);
                summaryWritten = true;
            } catch {
                summaryWritten = false;
            }
        }
        await closeSink(sink, this.failure !== undefined);
        return {
            path,
            rows: this.rows,
            rowsWritten: this.rowsWritten,
            reason,
            summaryWritten: summaryWritten && this.failure === undefined,
            measuredHz: undefined,
            error: this.failure,
            devices,
        };
    }

    /** The rate of the rows handed to the file, from the same seconds the time column writes. */
    private measuredHz(): number | undefined {
        if (this.firstTimeStamp === undefined || this.lastTimeStamp === undefined) return undefined;
        const last = Number(formatSeconds(this.lastTimeStamp, this.firstTimeStamp));
        return measuredRateHz(this.rows, 0, last);
    }
}

/** `facts` with each device's final layout (`undefined` entries keep what is known). */
function withFinalLayout(facts: RecordingFacts, final: ReadonlyArray<FinalLayout | undefined>): RecordingFacts {
    const count = isMultiDevice(facts) ? facts.devices.length : 1;
    const known = facts.jump?.devices ?? [];
    const jump: JumpFacts = {
        devices: Array.from({length: count}, (_, k): JumpDeviceFacts => {
            const entry = final[k];
            return entry === undefined
                ? (known[k] ?? {mode: undefined, jumpProtocol: undefined})
                : {mode: entry.mode, jumpProtocol: entry.jumpProtocol};
        }),
    };
    if (isMultiDevice(facts)) {
        return {
            ...facts,
            jump,
            devices: facts.devices.map((device, k) => {
                const entry = final[k];
                return entry === undefined ? device : {...device, fields: entry.fields, sampleRateHz: entry.sampleRateHz ?? device.sampleRateHz};
            }),
        };
    }
    const entry = final[0];
    return entry === undefined ? {...facts, jump} : {...facts, jump, fields: entry.fields, sampleRateHz: entry.sampleRateHz ?? facts.sampleRateHz};
}

/** Ends the stream and waits until the file is closed. A failed stream is destroyed instead. */
function closeSink(sink: Writable, failed: boolean): Promise<void> {
    return new Promise<void>((resolveClose) => {
        if (sink.destroyed || sink.closed) {
            resolveClose();
            return;
        }
        const done = (): void => resolveClose();
        sink.once('close', done);
        sink.once('error', done);
        if (failed) {
            sink.destroy();
            return;
        }
        sink.end();
        // A sink that never emits `close` (a test double without autoDestroy) still ends on `finish`.
        sink.once('finish', () => setImmediate(done));
    });
}
