/**
 * HOW TO READ THIS FILE (integrators). `runCli` below is the whole program, top to bottom, and the best table of
 * contents of the sample. Its steps are marked `STEP 1` to `STEP 15` and match README.md section 8. The SDK work
 * is in `companion.ts` (`CompanionLink`: connect, rates, prepare, zero) and `measure.ts` (the recording); the
 * rest (questions, flags, live view, CSV file, log) is what a command-line tool needs around it.
 *
 * The program, as a function of its environment, so the integration test can run the real flow with a
 * fake `fetch` and a fake `WebSocket` and read the exit code. `cli.ts` only builds
 * the environment from `process` and calls {@link runCli}.
 *
 * The flow: banner -> flags -> the device and seconds questions -> connect (E1-E3) -> optional rate ->
 * keep-alive -> prepare and wait (E4, E5) -> the fields from the stream descriptor (E11) -> the set rate ->
 * subscribe, countdown, `measureStart`, live view, `measureStop` at time end (`measure.ts`; E6, E7, Ctrl-C) ->
 * the one-line summary -> teardown -> exit 0.
 *
 * The file (`recorder.ts`): the size estimate and, above 100 MB, a
 * confirmation before the countdown; the file opened before `measureStart`; ended with its reason
 * after `measureStop` (time end), on E6 (device lost), E7 (session lost), E8 (disk full / write error,
 * exit 6) and Ctrl-C (by the teardown, after its `measureStop`); then the report: rows, absolute
 * path. E9: once the file is open, a second Ctrl-C exits at once with 130, leaving the file as flushed.
 *
 * A pair type (K-Plates, K-Deltas, K-Deltas 3D) records BOTH sensors, LEFT and
 * RIGHT, into one file, unless `--single` (or "y" to "Use a single plate?") asks for the left one alone.
 * Every step after "ready" is per device: fields, set rate, live block, `measureStop`, Summary rows. A
 * one-device recording keeps the one-device layout.
 *
 * `--jump` (or "y" to "Jump test …?") for K-Deltas and K-Plates: for K-Deltas the two
 * ballistic rate families are put in the jump-protocol mode BEFORE the prepare (`applyJumpRates`), the plan is
 * sent with `exerciseType: 'JUMP_ANALYSIS'`, and the file's head waits for the layout the start sequence puts
 * in force (`measure.ts`, `recorder.ts`). `--pair` answers the single-sensor question with "pair".
 */
import {CompanionClient, DeviceType, VERSION as SDK_VERSION, type CompanionClientOptions, type DeviceSnapshot} from '@kinvent/companion-sdk';
import {parseCliArgs, usage} from './args.js';
import {ballisticFamilyOf, CompanionLink, deviceName, floorNounOf, isFloorType, type JumpRatePlan} from './companion.js';
import {failureMessage, measure, setRateOf, type MeasureDevice, type MeasureOutcome, type RecordingSink} from './measure.js';
import {
    estimateBytes,
    formatMeasuredRate,
    formatMegabytes,
    Recorder,
    SIZE_WARNING_BYTES,
    writeErrorReason,
    type DeviceFacts,
    type EndReason,
    type Losses,
    type OpenSink,
    type RecorderResult,
    type RecordingFacts,
} from './recorder.js';
import type {SetRate} from './render.js';
import {lossText} from './render.js';
import {systemClock, type Clock} from './timer.js';
import {fieldsForEach} from './units/source.js';
import {
    CliExit,
    EXIT,
    exitCodeForSignal,
    interruptible,
    Interrupted,
    Interrupts,
    Teardown,
    type ExitCode,
    type SignalSource,
} from './exit.js';
import {
    AnswerRequired,
    askDeviceType,
    askSeconds,
    askJump,
    askRate,
    askSingle,
    BadFlagValue,
    canJump,
    InputClosed,
    isPairType,
    jumpRefusedMessage,
    labelOf,
    singleNounOf,
    type LineReader,
} from './prompts.js';

export const NOTICE =
    'Developer sample. Not for clinical use. Recordings contain sensor data of a person: keep them local.';

export interface Output {
    write(text: string): void;
}

export interface RunEnv {
    argv: readonly string[];
    stdout: Output;
    stderr: Output;
    /** The sample's own version (its package.json). */
    version: string;
    /** `undefined` when stdin is not a terminal: missing answers are then an error, not a question. */
    makeReader?: ((onInterrupt: () => void) => LineReader & {close(): void}) | undefined;
    signals: SignalSource;
    /** Test seam: `fetchImpl`, `webSocketImpl` and the poll cadence, passed to `CompanionClient`. */
    clientOptions?: Pick<CompanionClientOptions, 'fetchImpl' | 'webSocketImpl' | 'busyPollMs' | 'idlePollMs' | 'activityTailMs'>;
    keepAliveMs?: number;
    teardownStepTimeoutMs?: number;
    /** Whether stdout is a terminal: the live block is then redrawn in place. Default: not a terminal. */
    stdoutIsTTY?: boolean;
    /** Test seam: the plates' zero timing (see `LinkOptions`). */
    zeroTiming?: {zeroRetryMs?: number; zeroEmptyTimeoutMs?: number; zeroStepTimeoutMs?: number; stillWindowMs?: number};
    /** Test seam: where the sensors used last time are remembered. Default: the user's home folder (`registry.ts`). */
    registryPath?: string;
    /** Test seams for the timing. Defaults: the system clock, 1 s countdown steps, a 250 ms refresh tick. */
    clock?: Clock;
    countdownStepMs?: number;
    liveTickMs?: number;
    /** The folder `--out` is resolved against. Default `process.cwd()`. */
    cwd?: string;
    /** Test seams: the wall clock (epoch ms) for the file's dates, and a sink that can fail (E8). */
    now?: () => number;
    openSink?: OpenSink;
    /**
     * E9: ends the process at once (`process.exit` in `cli.ts`). Without it a second Ctrl-C only prints
     * "Already stopping; please wait."
     */
    exit?: (code: ExitCode) => void;
}

/** The countdown's length in seconds, written into the file. */
const COUNTDOWN_SECONDS = 3;

function line(out: Output, text: string): void {
    out.write(`${text}\n`);
}

export async function runCli(env: RunEnv): Promise<ExitCode> {
    line(env.stdout, `Kinvent Companion SDK sample ${env.version} (companion-sdk ${SDK_VERSION})`);
    line(env.stdout, NOTICE);
    line(env.stdout, '');

    // The SDK uses the global WebSocket for the sample stream. Node 22 has it; older Node does not.
    const webSocket = env.clientOptions?.webSocketImpl ?? (globalThis as {WebSocket?: unknown}).WebSocket;
    if (typeof webSocket !== 'function') {
        line(env.stderr, 'Node 22 or later is required (no global WebSocket in this Node.js).');
        return EXIT.ENVIRONMENT;
    }

    // STEP 1 — flags (`args.ts`). Program plumbing, no SDK.
    const parsed = parseCliArgs(env.argv);
    if (!parsed.ok) {
        env.stderr.write(`${parsed.error}\n\n${usage()}`);
        return EXIT.BAD_FLAGS;
    }
    const options = parsed.options;
    if (options.help || options.helpAll) {
        env.stdout.write(usage(undefined, options.helpAll));
        return EXIT.OK;
    }

    const teardown = new Teardown(env.teardownStepTimeoutMs, (text) => line(env.stderr, text));
    // E9: set once the file is open. A repeated signal then exits at once; before, it only says "wait".
    let openFile: string | undefined;
    const interrupts = new Interrupts(env.signals, (signal) => {
        if (openFile !== undefined && env.exit !== undefined) {
            line(env.stderr, `Second ${signal === 'SIGINT' ? 'Ctrl-C' : signal}: exiting now. The file keeps the rows written so far: ${openFile}`);
            env.exit(exitCodeForSignal(signal));
            return;
        }
        line(env.stderr, 'Already stopping; please wait.');
    });
    let recorder: Recorder | undefined;
    let fileReported = false;

    let code: ExitCode = EXIT.OK;
    try {
        // The `--single` question may be asked too (a pair type without `--single`, at a terminal).
        // And the jump question (K-Deltas, K-Plates without --jump or --normal); `--pair` answers the single one.
        const needsAnswer =
            options.device === undefined ||
            options.seconds === undefined ||
            (!options.single && !options.pair) ||
            (!options.jump && !options.normal) ||
            // Floor devices: the sampling-rate question, asked once the companion has said which rates it offers.
            options.rate === undefined;
        const reader = needsAnswer && env.makeReader ? env.makeReader(() => interrupts.trigger('SIGINT')) : undefined;
        if (reader) {
            teardown.add({name: 'close the terminal reader', run: () => reader.close()});
            // A signal while a question is open ends the question (the answer becomes "input closed").
            interrupts.onStop(() => reader.close());
        }
        // STEP 2 — the questions (`prompts.ts`): device type, single or pair, jump test, seconds. A flag answers a
        // question in advance; without a terminal a missing answer is an error (exit 1), never a hang.
        const ctx = {reader, out: env.stdout};
        const type = await askDeviceType(options.device, ctx);
        if (options.single && !isPairType(type)) {
            throw new BadFlagValue(`--single: only for a sensor pair (K-Plates, K-Deltas, K-Deltas 3D); a ${labelOf(type)} is one sensor already.`);
        }
        if (options.pair && !isPairType(type)) {
            throw new BadFlagValue(`--pair: only for a sensor pair (K-Plates, K-Deltas, K-Deltas 3D); a ${labelOf(type)} is one sensor.`);
        }
        if (options.jump && !canJump(type)) throw new BadFlagValue(jumpRefusedMessage(type));
        // The device questions together (type, single or pair, jump), then the recording time.
        const single = options.pair ? false : await askSingle(options.single, type, ctx);
        const jump = await askJump(options.jump ? 'jump' : options.normal ? 'normal' : undefined, type, ctx);
        const seconds = await askSeconds(options.seconds, ctx);
        if (interrupts.received) throw new Interrupted(interrupts.received);
        if (jump && type === DeviceType.DELTAS_3D) {
            // As in the mobile app: a jump analysis changes nothing on a 3D Delta (no jump protocol, nine channels,
            // the 3D rate).
            line(env.stdout, 'Jump test on 3D Deltas: they keep all nine channels and their rate, as in the mobile app.');
        }
        const how = !isPairType(type) ? '' : single ? `, one ${singleNounOf(type)} (the left one)` : ', a pair (left and right)';
        line(env.stdout, `Device: ${labelOf(type)} (${type})${how}${jump ? ', jump test' : ''}. Recording time: ${seconds} s.`);

        // STEP 3 — ONE `CompanionClient` for the whole program. Without `baseUrl` it walks the port ladder
        // (8477..8481 on `host`); `--port` pins one port and turns the walk off. `env.clientOptions` is the tests'
        // seam: a fake `fetch` and `WebSocket` (see `testing/doubles/fakeCompanion.ts`).
        const client = new CompanionClient({
            ...(options.port === undefined ? {} : {baseUrl: `http://${bracketed(options.host)}:${options.port}`}),
            discovery: {host: options.host},
            ...env.clientOptions,
        });
        const link = new CompanionLink(client, teardown, interrupts, {info: (text) => line(env.stdout, text)}, {
            where: {host: options.host, port: options.port},
            ...(env.keepAliveMs === undefined ? {} : {keepAliveMs: env.keepAliveMs}),
            ...(env.zeroTiming ?? {}),
            ...(env.registryPath === undefined ? {} : {registryPath: env.registryPath}),
        });

        // STEP 4 — find the companion, check the version, claim the session (`CompanionLink.connect`).
        const companionVersion = await link.connect();
        // STEP 5 — floor devices: ask the sampling rate, from the list the companion offers.
        // Floor devices: the rate is chosen from the rates the companion offers (the mobile app's list), Enter
        // keeping the one in force. The last question, because the list comes from the companion. `--rate` skips
        // it, and a K-Deltas jump test keeps its jump rate (set below, `--rate` being the jump rate there).
        const floor = isFloorType(type);
        const deltasJump = jump && type === DeviceType.HEXAS;
        let rate = options.rate;
        if (rate === undefined && floor && reader !== undefined) {
            // A K-Deltas jump test picks its JUMP rate: the ballistic families' jump-protocol rates (4000 Hz on the
            // K-Deltas XL only). Enter keeps the rate in force only when the families already jump at one rate.
            const offered = deltasJump ? await link.offeredJumpRates() : await link.offeredRates(type);
            if (offered !== undefined && offered.rates.length > 0) {
                const label = deltasJump ? `${labelOf(type)} jump test` : labelOf(type);
                const notes = 'notes' in offered ? offered.notes : undefined;
                const chosen = await interruptible(askRate(label, offered.rates, offered.current, ctx, notes), interrupts);
                if (chosen !== undefined && chosen === offered.current) {
                    line(env.stdout, `Sampling rate stays at ${chosen} Hz.`);
                } else {
                    rate = chosen;
                }
            }
        }
        reader?.close();
        if (interrupts.received) throw new Interrupted(interrupts.received);
        // STEP 6 — set the rate, only when it differs, and BEFORE the prepare (each accepted change reconnects
        // every sensor and would end a prepared activity).
        // A K-Deltas jump test sets the two ballistic families (with `--rate` as the jump rate) BEFORE the
        // prepare: every accepted PUT disconnects every sensor. A K-Plates jump test does not use them (a V2
        // plate's jump protocol has its own rate, a V3 plate keeps the plates family), so `--rate` keeps its meaning.
        let jumpRates: JumpRatePlan[] = [];
        if (deltasJump) {
            jumpRates = await link.applyJumpRates(rate);
        } else if (rate !== undefined) {
            await link.applyRate(type, rate);
        }
        // STEP 7 — keep the devices alive: one `ping()` every 10 s until the teardown.
        link.startKeepAlive();
        // Floor devices are calibrated (zeroed) while they connect: a load on them then would be zeroed away. The
        // wait-and-zero step that follows is for a person at a terminal, who can step off; a script keeps the zero
        // the companion took at connection.
        const calibrates = floor && env.makeReader !== undefined;
        if (calibrates) {
            line(env.stdout, `Do not step on the ${floorNounOf(type)}: they are calibrated while they connect. Use them only when told.`);
        } else if (floor) {
            line(env.stdout, `Not a terminal: the zero the companion took at connection is kept. Make sure nothing presses on the ${floorNounOf(type)}.`);
        }
        if (options.forgetDevices && isPairType(type)) {
            link.forgetRemembered(type);
            line(env.stdout, `Forgot the ${labelOf(type)} sensors used last time; scanning afresh.`);
        }
        // STEP 8 — prepare the activity and wait until every planned device is READY. Pairs go through
        // `prepareMatching` (the sensors used last time first, then a scan); one sensor through `prepareAndWait`.
        // A K-Deltas jump test that will be zeroed here is prepared as a NORMAL activity first and zeroed; then it is
        // prepared again as the jump test (`restartActivity`).
        const zeroFirst = calibrates && deltasJump;
        let devices = isPairType(type)
            ? await link.prepareMatching(type, options.connectTimeoutSeconds * 1000, single, zeroFirst ? false : jump)
            : await link.prepareAndWait(type, options.connectTimeoutSeconds * 1000, single, zeroFirst ? false : jump);
        const multi = devices.length > 1;
        const first = devices[0]!;

        if (multi) {
            line(env.stdout, `Devices ready: ${devices.map((device) => `${deviceName(device)} (${device.deviceType})`).join(', ')}.`);
        } else {
            const shown =
                first.deviceType === type ? labelOf(type) : `${labelOf(first.deviceType)} (accepted for a ${labelOf(type)} request)`;
            line(env.stdout, `Device ready: ${shown}, ${first.deviceType}.`);
        }

        // STEP 9 — floor devices: report a bad zero, then wait until nothing moves and zero again.
        // The zero each floor device took while connecting — said only when it failed or looks loaded.
        if (floor) for (const text of link.describeZeros(type, devices)) line(env.stdout, text);
        if (calibrates) await link.calibrateFloorDevices(type, devices);
        // STEP 10 — K-Deltas jump test only: prepare again, now as the jump test; the sensors and the zero are kept.
        if (zeroFirst) {
            line(env.stdout, 'Switching the K-Deltas to the jump test (the zero just taken is kept)…');
            devices = await link.restartActivity(type, options.connectTimeoutSeconds * 1000, single, true);
        }

        // STEP 11 — the name and unit of every value, per device, and the rate each device was set to.
        // The fields come ONLY from the stream descriptor; E11 when none.
        // One table per device, from one `GET /streams`.
        const tables = await interruptible(fieldsForEach(client, devices), interrupts);
        for (const [k, {fields, source}] of tables.entries()) {
            line(
                env.stdout,
                `Fields${multi ? ` (${deviceName(devices[k]!)})` : ''}: ${fields.map((field) => field.name).join(', ')} — from ${
                    source === 'descriptor'
                        ? "the companion's stream descriptor (GET /streams)"
                        : "the SDK's layout (streamLayoutOf); the companion listed no descriptor for this device"
                }.`,
            );
        }
        if (jump) {
            line(
                env.stdout,
                'Jump test: the companion may change the layout when the measurement starts; the file\'s channels and rate are written from the layout in force then.',
            );
        }
        const setRates: SetRate[] = [];
        for (const device of devices) setRates.push(await interruptible(setRateOf(client, device), interrupts));

        // The titles: one device keeps its product label ("K-Plates"), byte for byte; a pair
        // names each sensor by its Bluetooth name with the side ("K-Plate Left").
        const titles = devices.map((device) => (multi ? deviceName(device) : labelOf(device.deviceType)));
        const plan: MeasureDevice[] = devices.map((device, k) => ({device, fields: tables[k]!.fields, setRate: setRates[k]!, title: titles[k]!}));
        // The type in the file name and the "Device type" row: the devices' own type when they agree (a
        // 3D-Deltas may fill a K-Deltas slot), else the requested one.
        const fileType = devices.every((device) => device.deviceType === first.deviceType) ? first.deviceType : type;

        // STEP 12 — the file size estimate (and a confirmation above 100 MB), then "you can step on now".
        // The size, before the countdown; above 100 MB the user confirms at a terminal.
        await confirmSize(env, interrupts, plan, seconds, jumpRateFor(devices, jumpRates));
        if (calibrates) {
            const now = type === DeviceType.PLATES ? 'step on the plates' : `use the ${floorNounOf(type)}`;
            line(env.stdout, `You can ${now} now. The recording starts after the countdown.`);
        }

        const facts: RecordingFacts = {
            sampleVersion: env.version,
            companionVersion,
            sdkVersion: SDK_VERSION,
            deviceType: fileType,
            deviceTitle: titles[0]!,
            ...(options.includeSerial ? {serialCode: serialOf(first)} : {}),
            seconds,
            sampleRateHz: setRates[0]!.hz,
            countdownSeconds: COUNTDOWN_SECONDS,
            fields: plan[0]!.fields,
            // The file's head waits for the layout in force once the measurement started.
            ...(jump ? {jump: {devices: devices.map(() => ({mode: undefined, jumpProtocol: undefined}))}} : {}),
            ...(multi
                ? {
                      devices: plan.map(
                          (entry): DeviceFacts => ({
                              title: entry.title,
                              ...(options.includeSerial ? {serialCode: serialOf(entry.device)} : {}),
                              fields: entry.fields,
                              sampleRateHz: entry.setRate.hz,
                              timeSynced: entry.device.configuration?.timeSynced,
                          }),
                      ),
                  }
                : {}),
        };
        const file = new Recorder({
            folder: options.out,
            cwd: env.cwd ?? process.cwd(),
            ...(env.now === undefined ? {} : {now: env.now}),
            ...(env.openSink === undefined ? {} : {openSink: env.openSink}),
        });
        recorder = file;
        const recording: RecordingSink = {
            open: async () => {
                const path = await file.open(facts);
                openFile = path;
                if (file.suffixed) line(env.stdout, `A recording of the same second exists; this one is ${path}.`);
            },
            append: (batch, k) => file.append(batch, k),
            close: async (losses) => {
                await file.end(teardownReason(interrupts), losses);
            },
            settleLayout: (final) => file.settleLayout(final),
        };
        // STEP 13 — the recording (`measure.ts`): subscribe, countdown, open the file, ONE `measureStart`, live
        // values, one `measureStop` per device. `recording` above connects it to the CSV file (`recorder.ts`).
        const coarseTitle = `${labelOf(fileType)} (${fileType})`;
        const outcome = await measure(
            {
                client,
                teardown,
                interrupts,
                clock: env.clock ?? systemClock,
                out: env.stdout,
                tty: env.stdoutIsTTY === true,
                ...(env.countdownStepMs === undefined ? {} : {countdownStepMs: env.countdownStepMs}),
                ...(env.liveTickMs === undefined ? {} : {tickMs: env.liveTickMs}),
                recording,
            },
            {devices: plan, title: coarseTitle, seconds, jump},
        );
        const losses: Losses = {
            samplesLost: outcome.lostFrames,
            gaps: outcome.gapEvents,
            perDevice: outcome.devices.map((device) => ({samplesLost: device.lostFrames, gaps: device.gapEvents})),
        };
        const lostTitle = outcome.lostDevice === undefined ? undefined : titles[outcome.lostDevice];
        let result: RecorderResult;
        if (outcome.end === 'interrupted') {
            // Ctrl-C: the teardown stops the measurement, THEN ends the file ("Ctrl-C"), then the rest.
            await teardown.run();
            result = await file.end('Ctrl-C', losses);
        } else {
            // Time end, E6, E7: the measurement is stopped (or gone); E8: stopped by `measure`.
            result = await file.end(endReasonOf(outcome, multi ? lostTitle : undefined), losses);
        }
        // STEP 14 — the summary line and where the file is.
        line(env.stdout, summaryLine(outcome, coarseTitle, result.measuredHz, result.devices));
        fileReported = true;
        reportFile(env, result);
        if (result.error !== undefined) {
            throw new CliExit(
                EXIT.WRITE,
                `Could not write ${result.path}: ${writeErrorReason(result.error)}. The file is incomplete: ${result.rowsWritten} rows were written. ${
                    multi ? 'The sensors were stopped.' : 'The sensor was stopped.'
                }`,
            );
        }
        if (outcome.end === 'disconnected' || outcome.end === 'sessionLost') {
            throw new CliExit(
                EXIT.DISCONNECTED,
                failureMessage({end: outcome.end, detail: outcome.detail}, lostTitle ?? titles[0]!, outcome) +
                    (multi && outcome.end === 'disconnected' ? ' The other sensor was stopped.' : ''),
            );
        }
    } catch (error) {
        code = report(error, env);
    } finally {
        // STEP 15 — ALWAYS give back what was taken, in reverse order of taking it: stop the measurement, close
        // the file, stop the activity, stop the keep-alive, release the session (`exit.ts` `Teardown`). It runs
        // on success, on every error and on Ctrl-C, and each step runs once.
        await teardown.run();
        interrupts.dispose();
    }
    // Ended by something unexpected after the file was opened: the teardown ended the file; say where it is.
    if (recorder?.path !== undefined && !fileReported) {
        const result = await recorder.end('error');
        line(env.stderr, `Partial data kept: ${result.rows} rows in ${result.path}`);
    }
    // A signal wins over whatever the interrupted step reported on its way out.
    if (interrupts.received !== undefined) code = exitCodeForSignal(interrupts.received);
    return code;
}

/**
 * The one-line summary after a recording. The rate is the
 * file's own measured rate (`RecorderResult.measuredHz`, from `measuredRateHz`), printed with the same
 * formatter as the Summary row, so the two numbers cannot differ. With two or more
 * devices, each device's samples and measured rate (`RecorderResult.devices`).
 */
export function summaryLine(
    outcome: MeasureOutcome,
    title: string,
    measuredHz: number | undefined,
    devices?: ReadonlyArray<{title: string; rows: number; measuredHz: number | undefined}>,
): string {
    const seconds = outcome.durationMs / 1000;
    const rateOf = (hz: number | undefined): string =>
        hz === undefined ? 'rate not measured (fewer than two rows)' : `${formatMeasuredRate(hz)} Hz measured`;
    const head =
        outcome.end === 'completed' ? 'Done.' : outcome.end === 'interrupted' ? 'Stopped by Ctrl-C.' : 'Ended early.';
    const loss = lossText(outcome) ?? 'no data lost';
    if (devices !== undefined && devices.length > 1) {
        const each = devices.map((device) => `${device.title} ${device.rows} samples, ${rateOf(device.measuredHz)}`).join('; ');
        return `${head} ${outcome.samples} samples in ${seconds.toFixed(1)} s from ${title}: ${each}; ${loss}.`;
    }
    return `${head} ${outcome.samples} samples in ${seconds.toFixed(1)} s from ${title}, ${rateOf(measuredHz)}; ${loss}.`;
}

/** What the file's Summary says for an outcome that is not Ctrl-C. A pair names the sensor that was lost. */
function endReasonOf(outcome: MeasureOutcome, lostTitle: string | undefined): EndReason {
    switch (outcome.end) {
        case 'completed':
            return 'time end';
        case 'disconnected':
            return lostTitle === undefined ? 'device lost' : `device lost (${lostTitle})`;
        case 'sessionLost':
            return 'session lost';
        default:
            // E8: the Summary cannot be written anyway; `end` reports the error itself.
            return 'disk full';
    }
}

/** The reason the teardown writes when it is what ends the file. */
function teardownReason(interrupts: Interrupts): EndReason {
    if (interrupts.received === 'SIGINT') return 'Ctrl-C';
    if (interrupts.received === 'SIGTERM') return 'SIGTERM';
    return 'error';
}

/** `configuration.serialCode`, or `null` when the device reported none (only asked with `--include-serial`). */
function serialOf(device: DeviceSnapshot): string | null {
    const serial = device.configuration?.serialCode;
    return typeof serial === 'string' && serial.trim() !== '' ? serial : null;
}

/** The final report: rows, absolute path, the data-protection sentence. */
function reportFile(env: RunEnv, result: RecorderResult): void {
    if (result.error === undefined) {
        line(env.stdout, `Saved ${result.rows} rows to ${result.path}`);
    } else {
        line(env.stdout, `Partial data kept: ${result.rowsWritten} rows in ${result.path}`);
    }
    if (!result.summaryWritten) {
        line(env.stdout, 'The Summary section could not be written; the file ends at the last row written.');
    }
    line(env.stdout, 'This file contains sensor data of a person. Keep it on this computer, delete it when you no longer need it.');
}

/**
 * Above 100 MB, ask "Continue? [Y/n]" at a terminal. Refused, or no terminal to ask on: no
 * recording, exit 1 (as a missing answer without a terminal). Ctrl-D: exit 130.
 * The row holds every device's fields; the rate is the highest set rate (rows are joined by index).
 */
async function confirmSize(
    env: RunEnv,
    interrupts: Interrupts,
    plan: readonly MeasureDevice[],
    seconds: number,
    jumpHz: number | undefined,
): Promise<void> {
    // A jump test may raise the rate at the start; the field count may only drop. The estimate errs high.
    const rates = [...plan.map((entry) => entry.setRate.hz), jumpHz].filter((hz): hz is number => hz !== undefined);
    if (rates.length === 0) return;
    const hz = Math.max(...rates);
    const fieldCount = plan.reduce((total, entry) => total + entry.fields.length, 0);
    const bytes = estimateBytes(hz, seconds, fieldCount);
    if (bytes <= SIZE_WARNING_BYTES) return;
    line(
        env.stdout,
        `This recording will be about ${formatMegabytes(bytes)} (${hz} Hz × ${seconds} s × ${fieldCount} ${fieldCount === 1 ? 'field' : 'fields'}).`,
    );
    if (env.makeReader === undefined) {
        throw new CliExit(
            EXIT.BAD_FLAGS,
            `Not recording: a file above ${formatMegabytes(SIZE_WARNING_BYTES)} needs a confirmation at a terminal. Choose a shorter --seconds.`,
        );
    }
    const reader = env.makeReader(() => interrupts.trigger('SIGINT'));
    let answer: string | undefined;
    try {
        answer = await interruptible(reader.ask('Continue? [Y/n] '), interrupts);
    } finally {
        reader.close();
    }
    if (answer === undefined) throw new InputClosed();
    if (!/^(y|yes)?$/i.test(answer.trim())) throw new CliExit(EXIT.BAD_FLAGS, 'Not recording. Nothing was saved.');
}

/**
 * The highest jump rate the devices may record at: each K-Deltas's ballistic family's rate (by its variant,
 * `ballisticFamilyOf`), or the highest of both when a variant is not known. `undefined` when nothing was set.
 */
function jumpRateFor(devices: readonly DeviceSnapshot[], plans: readonly JumpRatePlan[]): number | undefined {
    if (plans.length === 0) return undefined;
    const highest = Math.max(...plans.map((entry) => entry.rate));
    const rates = devices.map((device) => {
        const family = ballisticFamilyOf(device);
        return family === undefined ? highest : (plans.find((entry) => entry.family === family)?.rate ?? highest);
    });
    return Math.max(...rates);
}

/** Prints the user's sentence for an error and returns its exit code. */
function report(error: unknown, env: RunEnv): ExitCode {
    if (error instanceof CliExit) {
        line(env.stderr, error.message);
        return error.code;
    }
    if (error instanceof Interrupted || error instanceof InputClosed) {
        line(env.stderr, 'Stopped. Nothing was recorded.');
        return error instanceof Interrupted ? exitCodeForSignal(error.signal) : EXIT.INTERRUPTED;
    }
    if (error instanceof AnswerRequired || error instanceof BadFlagValue) {
        line(env.stderr, error.message);
        line(env.stderr, 'Run with --help for the flags.');
        return EXIT.BAD_FLAGS;
    }
    line(env.stderr, `Unexpected error: ${error instanceof Error ? error.message : String(error)}`);
    return EXIT.INTERNAL;
}

function bracketed(host: string): string {
    return host.includes(':') && !host.startsWith('[') ? `[${host}]` : host;
}
