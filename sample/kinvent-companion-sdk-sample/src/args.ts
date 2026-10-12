/**
 * FOR INTEGRATORS: Terminal plumbing, no SDK call. A program with its own UI does not need this file; skip it on a first read.
 *
 * Command-line flags. Pure: no I/O, no process access, so the
 * tests can call it with any argv.
 *
 * Flags only pre-answer questions. `--device` is kept as typed here: whether the type is offered is
 * the prompt's job, so the same rule applies to a flag and to an answer typed at the
 * prompt.
 *
 * `--jump` / `--normal` pre-answer the jump question (K-Deltas, K-Plates), and
 * `--pair` pre-answers the single-sensor question the other way from `--single`. A pair of opposite flags
 * given together is a usage error here (exit 1); whether a flag fits the device type is the prompt's rule.
 */
import {parseArgs} from 'node:util';

export const SECONDS_MIN = 1;
/** Upper bound of a recording, in seconds (one hour). */
export const SECONDS_MAX = 3600;
export const DEFAULT_HOST = '127.0.0.1';
export const DEFAULT_OUT = 'recordings';
/** How long to wait for the sensors to be ready, in seconds. */
export const DEFAULT_CONNECT_TIMEOUT_S = 60;
/** No upper bound is required for the connect timeout; one hour, as for a recording. */
export const CONNECT_TIMEOUT_MAX_S = 3600;
export const PORT_MIN = 1;
export const PORT_MAX = 65535;

export interface CliOptions {
    /** Device type as typed, trimmed; `undefined` means "ask". */
    device: string | undefined;
    /** Recording time in whole seconds; `undefined` means "ask". */
    seconds: number | undefined;
    host: string;
    /** `undefined` means "walk the companion's port ladder". */
    port: number | undefined;
    /** Output folder, as typed (resolved against the current folder later). */
    out: string;
    connectTimeoutSeconds: number;
    /** Requested sampling rate in Hz; `undefined` means "leave the companion's setting". */
    rate: number | undefined;
    /** Write `configuration.serialCode` into the file. Off by default. */
    includeSerial: boolean;
    /**
     * Record ONE sensor of a pair type (K-Plates, K-Deltas, K-Deltas 3D): the plan is sent with
     * `isMonopodal: true`, so the companion connects the LEFT sensor only. Off by default (a pair).
     */
    single: boolean;
    /** Record BOTH sensors of a pair type without asking (the opposite of `--single`). */
    pair: boolean;
    /**
     * A jump test (K-Deltas, K-Plates): the plan is sent with `exerciseType: 'JUMP_ANALYSIS'` and the two
     * ballistic K-Deltas rate families are set to the jump protocol first. Off by default.
     */
    jump: boolean;
    /** A normal test, without asking the jump question (the opposite of `--jump`). */
    normal: boolean;
    help: boolean;
    /** `--help-all`: the help with every flag, not only the main ones. */
    helpAll: boolean;
    /** Forget the sensors remembered for the chosen pair type, and scan afresh. */
    forgetDevices: boolean;
}

export type ParseResult = {ok: true; options: CliOptions} | {ok: false; error: string};

/** One line per flag, printed by `--help`. Kept beside the parser so the two cannot drift apart. */
export const FLAG_HELP: ReadonlyArray<readonly [string, string]> = [
    ['--device <TYPE>', 'Device type, for example PLATES or GRIP. Skips the device question.'],
    ['--seconds <n>', `Recording time in whole seconds, ${SECONDS_MIN} to ${SECONDS_MAX}. Skips the time question.`],
    ['--host <host>', `Companion host. Default ${DEFAULT_HOST}. The companion accepts loopback hosts only.`],
    ['--port <port>', 'Companion port. Default: try 8477 to 8481. A fixed port turns the search off.'],
    ['--out <folder>', `Folder for the recording. Default ./${DEFAULT_OUT}/ under the current folder.`],
    ['--connect-timeout <s>', `Seconds to wait for the sensor to connect. Default ${DEFAULT_CONNECT_TIMEOUT_S}.`],
    ['--rate <Hz>', 'Sampling rate to set. Changed only if it differs. A change disconnects every sensor.'],
    ['--include-serial', 'Write the device serial code into the file. Off by default.'],
    ['--single', 'K-Plates, K-Deltas, K-Deltas 3D: record one sensor (the left one) instead of the pair.'],
    ['--pair', 'K-Plates, K-Deltas, K-Deltas 3D: record the pair (left and right) without asking.'],
    ['--jump', 'K-Deltas, K-Deltas 3D, K-Plates: jump test. With K-Deltas, --rate is the jump rate.'],
    ['--normal', 'K-Deltas, K-Deltas 3D, K-Plates: normal test, without asking the jump question.'],
    ['--forget-devices', 'K-Plates, K-Deltas, K-Deltas 3D: forget the sensors used last time and scan afresh.'],
    ['-h, --help', 'Print the main flags and exit.'],
    ['--help-all', 'Print every flag and exit.'],
];

/**
 * The flags `--help` shows. Every other flag still works; they are for scripts and special cases, and at a
 * terminal the questions cover them, so `--help-all` lists them.
 */
export const MAIN_FLAGS: ReadonlySet<string> = new Set(['--device <TYPE>', '--seconds <n>', '--out <folder>', '-h, --help', '--help-all']);

const DECIMAL_INTEGER = /^[0-9]+$/;

/**
 * Whole decimal number in [min, max]: digits only after trimming, so no sign, no decimal point, no
 * exponent, no hex. Returns the number or the message for the user.
 */
export function parseWholeNumber(text: string, min: number, max: number): number | string {
    const trimmed = text.trim();
    if (!DECIMAL_INTEGER.test(trimmed)) return 'Please type a whole number.';
    const value = Number(trimmed);
    if (!Number.isSafeInteger(value) || value < min || value > max) {
        return `Please type a number from ${min} to ${max}.`;
    }
    return value;
}

/** Shared by `--seconds` and the seconds prompt. */
export function parseSeconds(text: string): number | string {
    return parseWholeNumber(text, SECONDS_MIN, SECONDS_MAX);
}

export function parseCliArgs(argv: readonly string[]): ParseResult {
    let values: Record<string, string | boolean | undefined>;
    try {
        ({values} = parseArgs({
            args: [...argv],
            strict: true,
            allowPositionals: false,
            options: {
                device: {type: 'string'},
                seconds: {type: 'string'},
                host: {type: 'string'},
                port: {type: 'string'},
                out: {type: 'string'},
                'connect-timeout': {type: 'string'},
                rate: {type: 'string'},
                'include-serial': {type: 'boolean'},
                single: {type: 'boolean'},
                pair: {type: 'boolean'},
                jump: {type: 'boolean'},
                normal: {type: 'boolean'},
                help: {type: 'boolean', short: 'h'},
                'help-all': {type: 'boolean'},
                'forget-devices': {type: 'boolean'},
            },
        }));
    } catch (error) {
        return {ok: false, error: error instanceof Error ? error.message : String(error)};
    }

    const str = (name: string): string | undefined => values[name] as string | undefined;

    const nonEmpty = (name: string): string | undefined | {error: string} => {
        const raw = str(name);
        if (raw === undefined) return undefined;
        const trimmed = raw.trim();
        return trimmed === '' ? {error: `--${name}: must not be empty.`} : trimmed;
    };

    const number = (name: string, min: number, max: number): number | undefined | {error: string} => {
        const raw = str(name);
        if (raw === undefined) return undefined;
        const parsed = parseWholeNumber(raw, min, max);
        return typeof parsed === 'string' ? {error: `--${name}: ${parsed}`} : parsed;
    };

    const device = nonEmpty('device');
    const host = nonEmpty('host');
    const out = nonEmpty('out');
    const seconds = number('seconds', SECONDS_MIN, SECONDS_MAX);
    const port = number('port', PORT_MIN, PORT_MAX);
    const connectTimeout = number('connect-timeout', 1, CONNECT_TIMEOUT_MAX_S);
    // The valid rates are the companion's (`frequencySettings().options`), checked after connecting; here only
    // "a positive whole number". The bound is a sanity cap, not a device limit.
    const rate = number('rate', 1, 100_000);

    for (const v of [device, seconds, host, port, out, connectTimeout, rate]) {
        if (typeof v === 'object' && v !== null) return {ok: false, error: v.error};
    }
    // Opposite answers to the same question.
    if (values.single === true && values.pair === true) return {ok: false, error: '--single and --pair: choose one.'};
    if (values.jump === true && values.normal === true) return {ok: false, error: '--jump and --normal: choose one.'};

    return {
        ok: true,
        options: {
            device: device as string | undefined,
            seconds: seconds as number | undefined,
            host: (host as string | undefined) ?? DEFAULT_HOST,
            port: port as number | undefined,
            out: (out as string | undefined) ?? DEFAULT_OUT,
            connectTimeoutSeconds: (connectTimeout as number | undefined) ?? DEFAULT_CONNECT_TIMEOUT_S,
            rate: rate as number | undefined,
            includeSerial: values['include-serial'] === true,
            single: values.single === true,
            pair: values.pair === true,
            jump: values.jump === true,
            normal: values.normal === true,
            help: values.help === true,
            helpAll: values['help-all'] === true,
            forgetDevices: values['forget-devices'] === true,
        },
    };
}

export function usage(program = 'kinvent-companion-sample', all = false): string {
    const shown = all ? FLAG_HELP : FLAG_HELP.filter(([flag]) => MAIN_FLAGS.has(flag));
    const width = Math.max(...shown.map(([flag]) => flag.length));
    const lines = shown.map(([flag, text]) => `  ${flag.padEnd(width)}  ${text}`);
    return [
        `Usage: ${program} [flags]`,
        '',
        'Records raw samples from one Kinvent sensor or a sensor pair through a running Kinvent companion app.',
        'Without flags it asks for the device type, single sensor or pair (K-Plates, K-Deltas, K-Deltas 3D),',
        'jump test (K-Plates, K-Deltas, K-Deltas 3D), and the recording time.',
        '',
        all ? 'Flags:' : 'Main flags (--help-all lists every flag):',
        ...lines,
        '',
    ].join('\n');
}
