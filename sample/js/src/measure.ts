/**
 * FOR INTEGRATORS: README.md sections 5.7 (record) and 5.8 (losses). The ORDER below is the part to copy: subscribe to
 * every device, then start once, then stop each device, and treat a lost session before a lost device. The
 * countdown, the live view and the file are this program's own.
 *
 * The recording: subscribe, count down, start,
 * show the live values, stop at the requested time.
 *
 * ORDER, and why:
 *   1. subscribe to `sampleBatches$(id)`, `events$` and `sessionLost$` BEFORE the countdown, so that no
 *      frame is missed once the sensor starts;
 *   2. the countdown, 3-2-1 (Ctrl-C, the device lost or the session lost end it: nothing was started);
 *   3. register "stop the measurement" with the teardown, then send `measureStart(id)`. The teardown runs
 *      in reverse, so this step runs BEFORE "stop the activity" registered by `companion.ts`;
 *   4. record until the run timer fires, then `measureStop(id)`;
 *   5. stop accepting samples once `measureStop` has answered: the samples the sensor sent before it was
 *      told to stop belong to the recording.
 *
 * E6 (the device disconnected) and E7 (the session was lost) end the recording early with the samples
 * counted so far. On a lost session the SDK closes the sockets and reports every device disconnected
 * BEFORE `sessionLost$` emits, in the same synchronous call; so a device-side end is decided one microtask later, and a session loss
 * reported in the same call wins.
 *
 * The recording file. `deps.recording` is OPENED after the countdown and BEFORE `measureStart` is
 * sent, so the first batch (which the companion may send before its HTTP answer) is written; Ctrl-C
 * during the countdown creates no file. Every accepted batch is appended. A failed write (E8) ends the
 * recording like E6, but the measurement is still running, so it is stopped here. Ending the file is the
 * caller's (`run.ts`), after `measureStop`; on Ctrl-C the teardown step registered here ends it, after
 * the teardown's own `measureStop` (the teardown runs in reverse order).
 *
 * A pair: every step above runs for EVERY device of the activity —
 * `sampleBatches$` subscribed per device before the countdown, losses and disconnects watched per device,
 * a `measureStop` per device at time end — except `measureStart`, sent ONCE: it starts every device of the
 * activity. E6 when ANY device is lost: the others are stopped, the outcome names the lost one. A
 * `stream.layout` event re-labels that device's live values (`units/source.ts` `watchLayouts`).
 *
 * A jump test: the layout becomes final at the start sequence, AFTER `measureStart`.
 * The `stream.layout` watcher is subscribed before `measureStart` (step 1), and the
 * file's head waits (`RecordingSink.settleLayout`) until EVERY device's layout is final: its `stream.layout`
 * event arrived, or, once every device has sent its first batch, the companion's own answer (`GET /devices`)
 * for the devices that sent no event. The second path covers a V3 plate on a jump analysis (it keeps its
 * four values and the companion sends no event) and the race between the two channels: the event travels on
 * the poll, the first frame on the sample socket, so the frame can arrive first; the companion emitted the
 * event before that frame, so its `GET /devices` already answers the new configuration. The live view takes
 * each device's new fields and set rate as soon as either path gives them.
 */
import type {Subscription} from 'rxjs';
import {
    CompanionError,
    DeviceState,
    RawDataProtocolType,
    type CompanionClient,
    type DeviceConfiguration,
    type DeviceSnapshot,
    type ForceSample,
    type StreamField,
} from '@kinvent/companion-sdk';
import {countdown} from './countdown.js';
import {familyOf} from './companion.js';
import {CliExit, EXIT, Interrupted, type Interrupts, type Teardown} from './exit.js';
import {RecorderWriteError, type FinalLayout, type Losses} from './recorder.js';
import {countdownText, LiveView, type DeviceLiveState, type LiveState, type MultiLiveState, type SetRate, type Writer} from './render.js';
import {every, RateWindow, RunTimer, type Clock} from './timer.js';
import {layoutFromConfiguration, watchLayouts} from './units/source.js';

export type EndReason = 'completed' | 'interrupted' | 'disconnected' | 'sessionLost' | 'writeError';

/** Where the samples go: `run.ts` wraps the {@link import('./recorder.js').Recorder}. */
export interface RecordingSink {
    /** Creates the file. Rejects with a `RecorderWriteError` when it cannot. */
    open(): Promise<void>;
    /** Appends one batch of device `deviceIndex` (0 for a one-device recording). Rejects once a write failed. */
    append(batch: readonly ForceSample[], deviceIndex: number): Promise<void>;
    /** The teardown's step: ends the file if nothing ended it before (Ctrl-C, an unexpected error). */
    close(losses: Losses): Promise<void>;
    /**
     * A jump test: every device's layout is final (an entry per device, in the plan's order); the file's
     * head and the batches that waited are written. Rejects with a `RecorderWriteError` when a write fails.
     */
    settleLayout?(final: ReadonlyArray<FinalLayout | undefined>): Promise<void>;
}

/** The counters of one device, or of the whole recording (their sums). */
export interface Counters {
    samples: number;
    frames: number;
    gapEvents: number;
    missedFrames: number;
    lossEvents: number;
    lostFrames: number;
}

export interface MeasureOutcome extends Counters {
    end: EndReason;
    /** What the companion or the SDK said, for E6 and E7. */
    detail: string | undefined;
    durationMs: number;
    /** Each device's counters, in the plan's order (one entry for a one-device recording). */
    devices: Array<Counters & {title: string}>;
    /** E6: the index of the device that was lost. */
    lostDevice: number | undefined;
}

export interface MeasureDeps {
    client: CompanionClient;
    teardown: Teardown;
    interrupts: Interrupts;
    clock: Clock;
    out: Writer;
    tty: boolean;
    countdownStepMs?: number;
    /** The live view's refresh tick when no batch arrives (250 ms). */
    tickMs?: number;
    /** Where the samples are written. */
    recording: RecordingSink;
}

/** One device of the recording. */
export interface MeasureDevice {
    device: DeviceSnapshot;
    fields: readonly StreamField[];
    setRate: SetRate;
    /** How the device is named on screen and in messages: "K-Plate Left" in a pair, "K-Grip" alone. */
    title: string;
}

export interface MeasurePlan {
    /** Every device of the activity, in the plan's order (LEFT then RIGHT). One for a single sensor. */
    devices: readonly MeasureDevice[];
    /** The live view's title, for example "K-Plates (PLATES)". */
    title: string;
    seconds: number;
    /** A jump test. The file's head waits for every device's final layout (see the file header). */
    jump?: boolean;
}

/** The `protocolType` values the SDK reports for a jump layout (one total-force value). */
const JUMP_PROTOCOLS: ReadonlySet<string> = new Set<string>([RawDataProtocolType.JUMP_PROTOCOL, RawDataProtocolType.V3_JUMP_PROTOCOL]);

/**
 * A device's final layout from a configuration the companion reported after the start sequence (a
 * `stream.layout` event, or `GET /devices`). What the configuration does not say keeps `current`.
 */
export function finalLayoutOf(
    device: Pick<DeviceSnapshot, 'deviceType'>,
    configuration: DeviceConfiguration | undefined,
    current: {fields: readonly StreamField[]; setRateHz: number | undefined},
): FinalLayout {
    const layout = configuration === undefined ? undefined : layoutFromConfiguration(device.deviceType, configuration);
    const rate = configuration?.samplingFrequency;
    const protocol = configuration?.protocolType;
    return {
        fields: layout?.fields ?? current.fields,
        sampleRateHz: rate !== undefined && rate > 0 ? rate : current.setRateHz,
        mode: layout === undefined ? undefined : layout.mode,
        jumpProtocol: protocol === undefined ? undefined : JUMP_PROTOCOLS.has(protocol),
    };
}

export const LIVE_TICK_MS = 250;

/** A state the device does not come back from: its stream is over (`DeviceState`). */
const TERMINAL_STATES: ReadonlySet<string> = new Set([DeviceState.DISCONNECTING, DeviceState.DISCONNECTED, DeviceState.ERROR]);

type Failure = {end: 'disconnected' | 'sessionLost' | 'writeError'; detail: string | undefined; deviceIndex?: number | undefined};

const zero = (): Counters => ({samples: 0, frames: 0, gapEvents: 0, missedFrames: 0, lossEvents: 0, lostFrames: 0});

function sum(list: readonly Counters[]): Counters {
    const total = zero();
    for (const counters of list) {
        for (const key of Object.keys(total) as Array<keyof Counters>) total[key] += counters[key];
    }
    return total;
}

export async function measure(deps: MeasureDeps, plan: MeasurePlan): Promise<MeasureOutcome> {
    const {client, teardown, interrupts, clock, out} = deps;
    const multi = plan.devices.length > 1;

    // One controller ends the countdown or the recording early: Ctrl-C, or a failure below.
    const stop = new AbortController();
    let failure: Failure | undefined;
    let finished = false;
    const fail = (end: Failure['end'], detail: string | undefined, deviceIndex?: number): void => {
        if (finished || failure !== undefined || stop.signal.aborted) return;
        failure = {end, detail, deviceIndex};
        stop.abort(failure);
    };
    // A microtask for an event that says why the device went, a macrotask for a bare state or the end of
    // the stream: both run after a session loss reported in the same call, and the event's own reason
    // ("link lost") wins over "disconnected" or "the sample stream ended".
    const failLater = (k: number, detail: string | undefined): void => queueMicrotask(() => fail('disconnected', detail, k));
    const failAfterEvents = (k: number, detail: string): void => void setTimeout(() => fail('disconnected', detail, k), 0);
    const onInterrupt = (): void => {
        if (!finished && !stop.signal.aborted) stop.abort(interrupts.abortSignal.reason);
    };

    let accepting = false;
    // One state per device. `measuring`: a `measureStop` may still be owed to it.
    const per = plan.devices.map((entry) => ({
        entry,
        fields: entry.fields,
        /** Replaced by the set rate of a new configuration (`stream.layout`). */
        setRate: entry.setRate,
        stats: zero(),
        latest: undefined as ForceSample | undefined,
        rate: new RateWindow(clock),
        measuring: false,
        /** The final layout, once known; and whether a first batch arrived. */
        final: undefined as FinalLayout | undefined,
        sawBatch: false,
    }));
    const indexOf = (deviceId: string): number => plan.devices.findIndex((entry) => entry.device.id === deviceId);
    const timer = new RunTimer(clock, plan.seconds * 1000);
    const view = new LiveView(out, deps.tty, clock);
    const state = (): LiveState | MultiLiveState => {
        if (!multi) {
            const one = per[0]!;
            return {
                title: plan.title,
                fields: one.fields,
                setRate: one.setRate,
                measuredHz: one.rate.rate(),
                elapsedMs: timer.elapsedMs,
                totalMs: timer.durationMs,
                channels: one.latest?.channels,
                ...one.stats,
            };
        }
        return {
            title: plan.title,
            elapsedMs: timer.elapsedMs,
            totalMs: timer.durationMs,
            devices: per.map(
                (device): DeviceLiveState => ({
                    title: device.entry.title,
                    fields: device.fields,
                    setRate: device.setRate,
                    measuredHz: device.rate.rate(),
                    channels: device.latest?.channels,
                    ...device.stats,
                }),
            ),
        };
    };
    const outcome = (end: EndReason): MeasureOutcome => ({
        end,
        detail: failure?.detail,
        durationMs: timer.elapsedMs,
        ...sum(per.map((device) => device.stats)),
        devices: per.map((device) => ({title: device.entry.title, ...device.stats})),
        lostDevice: failure?.end === 'disconnected' ? failure.deviceIndex : undefined,
    });

    /** `measureStop` for every device still owed one (one per device; it stops ONE device). */
    const stopMeasuring = async (onRefused: (error: CompanionError, k: number) => void): Promise<void> => {
        for (const [k, device] of per.entries()) {
            if (!device.measuring) continue;
            device.measuring = false;
            try {
                await client.measureStop(device.entry.device.id);
            } catch (error) {
                if (!(error instanceof CompanionError)) throw error;
                onRefused(error, k);
            }
        }
    };

    // The file's head waits for every device's final layout (see the file header).
    const deferring = plan.jump === true && deps.recording.settleLayout !== undefined;
    let settled = !deferring;
    let askedCompanion = false;
    /** The live view takes a device's new layout at once: its fields and its set rate. */
    const showLayout = (k: number, layout: FinalLayout): void => {
        per[k]!.fields = layout.fields;
        if (layout.sampleRateHz !== undefined) per[k]!.setRate = {hz: layout.sampleRateHz, source: 'device configuration'};
        if (timer.started) view.update(state());
    };
    const settle = (): void => {
        if (settled || finished) return;
        settled = true;
        deps.recording.settleLayout!(per.map((device) => device.final)).catch((error: unknown) => {
            fail('writeError', error instanceof RecorderWriteError ? error.message : String(error));
        });
    };
    const checkLayouts = (): void => {
        if (settled) return;
        if (per.every((device) => device.final !== undefined)) {
            settle();
            return;
        }
        if (askedCompanion || !per.every((device) => device.final !== undefined || device.sawBatch)) return;
        // Every device sent its first batch, and some sent no `stream.layout`: the companion's own answer.
        askedCompanion = true;
        const current = (k: number): {fields: readonly StreamField[]; setRateHz: number | undefined} => ({
            fields: per[k]!.fields,
            setRateHz: per[k]!.setRate.hz,
        });
        client
            .devices()
            .then(
                (answered) => {
                    for (const [k, device] of per.entries()) {
                        if (device.final !== undefined) continue;
                        const snapshot = answered.find((entry) => entry.id === device.entry.device.id);
                        device.final = finalLayoutOf(device.entry.device, snapshot?.configuration, current(k));
                        showLayout(k, device.final);
                    }
                },
                () => {
                    // No answer: the layout known at ready (the companion's event, if any, was taken already).
                    for (const [k, device] of per.entries()) {
                        device.final ??= finalLayoutOf(device.entry.device, device.entry.device.configuration, current(k));
                    }
                },
            )
            .then(settle, () => undefined);
    };

    const subscriptions: Subscription[] = [];
    let stopTick: (() => void) | undefined;
    try {
        // 1. Subscribed BEFORE the countdown, for EVERY device of the activity: the one
        //    `measureStart` below starts them all, so each device's first frame must find its subscriber.
        for (const [k, device] of per.entries()) {
            subscriptions.push(
                client.sampleBatches$(device.entry.device.id).subscribe({
                    next: (batch) => {
                        if (!accepting || batch.length === 0) return;
                        device.stats.samples += batch.length;
                        device.stats.frames += 1;
                        device.latest = batch[batch.length - 1];
                        device.rate.add(batch.length);
                        deps.recording.append(batch, k).catch((error: unknown) => {
                            fail('writeError', error instanceof RecorderWriteError ? error.message : String(error));
                        });
                        if (!settled) {
                            device.sawBatch = true;
                            checkLayouts();
                        }
                        if (timer.started) view.update(state());
                    },
                    // The SDK completes a device's streams when its socket ends for good.
                    complete: () => failAfterEvents(k, 'the sample stream ended'),
                }),
            );
        }
        subscriptions.push(
            client.events$.subscribe((event) => {
                switch (event.type) {
                    case 'stream.gap': {
                        const k = indexOf(event.deviceId);
                        if (k < 0) return;
                        per[k]!.stats.gapEvents += 1;
                        per[k]!.stats.missedFrames += event.missed;
                        return;
                    }
                    case 'device.samplesLost': {
                        const k = indexOf(event.deviceId);
                        if (k < 0) return;
                        per[k]!.stats.lossEvents += 1;
                        per[k]!.stats.lostFrames += event.toSeq - event.fromSeq + 1;
                        return;
                    }
                    case 'device.disconnected': {
                        const k = indexOf(event.deviceId);
                        if (k >= 0) failLater(k, event.reason);
                        return;
                    }
                    case 'device.samplingInterrupted': {
                        const k = indexOf(event.deviceId);
                        if (k >= 0) failLater(k, `no data for ${event.gapMs} ms`);
                        return;
                    }
                    case 'device.state': {
                        const k = indexOf(event.deviceId);
                        if (k >= 0 && TERMINAL_STATES.has(event.state)) failAfterEvents(k, event.state.toLowerCase());
                        return;
                    }
                    default:
                        return;
                }
            }),
        );
        // A `stream.layout` event re-labels that device's values.
        subscriptions.push(
            watchLayouts(
                client,
                plan.devices.map((entry) => entry.device),
                (k, fields, configuration) => {
                    if (!deferring) {
                        // Every run that is not a jump test: the live view only.
                        per[k]!.fields = fields;
                        if (timer.started) view.update(state());
                        return;
                    }
                    const layout = finalLayoutOf(per[k]!.entry.device, configuration, {fields, setRateHz: per[k]!.setRate.hz});
                    showLayout(k, layout);
                    if (!settled) {
                        per[k]!.final = layout;
                        checkLayouts();
                    }
                },
            ),
        );
        subscriptions.push(client.sessionLost$.subscribe((reason) => fail('sessionLost', reason)));
        if (interrupts.abortSignal.aborted) onInterrupt();
        interrupts.abortSignal.addEventListener('abort', onInterrupt);

        // 2. The countdown. Nothing has been started on the sensor yet.
        try {
            await countdown({
                clock,
                signal: stop.signal,
                show: (n) => out.write(deps.tty ? `\r\u001b[2K${countdownText(n)}` : `${countdownText(n)}\n`),
                ...(deps.countdownStepMs === undefined ? {} : {stepMs: deps.countdownStepMs}),
            });
        } finally {
            if (deps.tty) out.write('\n');
        }

        // 3. The file, then start. The file is opened BEFORE `measureStart` so the first batch is kept.
        // Its teardown step is registered before "stop the measurement", so on Ctrl-C it runs AFTER it.
        try {
            await deps.recording.open();
        } catch (error) {
            if (error instanceof RecorderWriteError) throw new CliExit(EXIT.WRITE, `${error.message} Nothing was recorded.`);
            throw error;
        }
        teardown.add({
            name: 'close the recording file',
            run: () =>
                deps.recording.close({
                    ...sumLosses(per.map((device) => device.stats)),
                    perDevice: per.map((device) => ({samplesLost: device.stats.lostFrames, gaps: device.stats.gapEvents})),
                }),
        });
        // "Stop the measurement" is registered before the request leaves, and only acts while a
        // measurement may be running: one `measureStop` per device still measuring.
        for (const device of per) device.measuring = true;
        teardown.add({name: 'stop the measurement', run: () => stopMeasuring(() => undefined)});
        accepting = true;
        try {
            // ONE `measureStart` starts EVERY device of the activity: the companion's start sequence
            // starts them all, and a second call for another device is accepted and does nothing.
            // So it is sent once, for the first device; `measureStop` is per device.
            await abortable(client.measureStart(plan.devices[0]!.device.id), stop.signal);
        } catch (error) {
            if (error instanceof CompanionError) {
                for (const device of per) device.measuring = false;
                throw new CliExit(EXIT.DEVICE, `Could not start the ${multi ? plan.title : per[0]!.entry.title}: ${error.reason ?? error.message}.`);
            }
            if (!stop.signal.aborted) throw error;
        }

        // 4. Record until the timer fires or something ends the run early.
        if (!stop.signal.aborted) {
            out.write(`Recording for ${plan.seconds} s… (Ctrl-C to stop early)\n`);
            const done = timer.start();
            stopTick = every(clock, deps.tickMs ?? LIVE_TICK_MS, () => view.update(state()));
            view.update(state());
            await abortable(done, stop.signal).catch(() => undefined);
        }
        timer.stop();
        stopTick?.();

        let end: EndReason;
        const failed = failure as Failure | undefined;
        if (failed?.end === 'writeError') {
            // E8: the file cannot take more rows, but the sensors are still measuring: stop them first.
            await stopMeasuring(() => undefined);
            end = 'writeError';
        } else if (failed?.end === 'disconnected') {
            // E6: the lost device has no measurement left to stop; the others of a pair still measure.
            if (failed.deviceIndex !== undefined) per[failed.deviceIndex]!.measuring = false;
            await stopMeasuring(() => undefined);
            end = 'disconnected';
        } else if (failed !== undefined) {
            // E7: the session is gone: no command can be sent.
            for (const device of per) device.measuring = false;
            end = failed.end;
        } else if (stop.signal.aborted) {
            // Ctrl-C: the teardown sends `measureStop` (it runs before "stop the activity").
            end = 'interrupted';
        } else {
            // 5. Time end: stop every sensor, then stop accepting.
            await stopMeasuring((error, k) => {
                const who = multi ? ` for the ${per[k]!.entry.title}` : '';
                out.write(`The companion did not confirm the stop${who}: ${error.reason ?? error.message}.\n`);
            });
            end = 'completed';
        }
        accepting = false;
        finished = true;
        view.finish(state());
        return outcome(end);
    } catch (error) {
        // Ended during the countdown: nothing was started, nothing recorded.
        if (error instanceof Interrupted) throw error;
        if (error === failure && failure !== undefined) {
            const f = failure as Failure;
            const label = f.deviceIndex === undefined ? per[0]!.entry.title : per[f.deviceIndex]!.entry.title;
            throw new CliExit(EXIT.DISCONNECTED, failureMessage(f, label, undefined));
        }
        throw error;
    } finally {
        finished = true;
        accepting = false;
        stopTick?.();
        timer.stop();
        interrupts.abortSignal.removeEventListener('abort', onInterrupt);
        for (const subscription of subscriptions) subscription.unsubscribe();
    }
}

/** The Summary's totals: `device.samplesLost` frames and `stream.gap` events, over every device. */
function sumLosses(list: readonly Counters[]): {samplesLost: number; gaps: number} {
    const total = sum(list);
    return {samplesLost: total.lostFrames, gaps: total.gapEvents};
}

/**
 * The rate the sensor was set to: the device's own `configuration.samplingFrequency` when the snapshot
 * has it, else the companion's current setting for the device's rate family (`frequencySettings()`).
 */
export async function setRateOf(client: Pick<CompanionClient, 'frequencySettings'>, device: DeviceSnapshot): Promise<SetRate> {
    const configured = device.configuration?.samplingFrequency;
    if (configured !== undefined && configured > 0) return {hz: configured, source: 'device configuration'};
    const family = familyOf(device.deviceType);
    if (family === undefined) return {hz: undefined, source: undefined};
    try {
        const settings = await client.frequencySettings();
        const current = settings.families.find((entry) => entry.family === family)?.current.rate;
        return current === undefined ? {hz: undefined, source: undefined} : {hz: current, source: 'companion setting'};
    } catch (error) {
        if (error instanceof CompanionError) return {hz: undefined, source: undefined};
        throw error;
    }
}

/** E6 / E7's sentence. `outcome` undefined: it happened before the recording started. */
export function failureMessage(failure: Failure, label: string, outcome: Pick<MeasureOutcome, 'durationMs' | 'samples'> | undefined): string {
    const when = outcome === undefined ? 'before the recording started' : `after ${(outcome.durationMs / 1000).toFixed(1)} s`;
    const kept = outcome === undefined ? 'Nothing was recorded.' : `${outcome.samples} samples were received.`;
    if (failure.end === 'sessionLost') {
        const why = failure.detail === 'refused' ? 'another app took the sensors' : failure.detail === 'replaced' ? 'the session was replaced' : failure.detail;
        return `Lost the companion session ${when} (${why ?? 'no reason given'}). ${kept}`;
    }
    return `The ${label} disconnected ${when}${failure.detail ? ` (${failure.detail})` : ''}. ${kept}`;
}

/** Waits for `promise`, or rejects with `signal.reason` when `signal` aborts first. */
function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
    promise.catch(() => undefined);
    if (signal.aborted) return Promise.reject(signal.reason);
    return new Promise<T>((resolve, reject) => {
        const onAbort = (): void => reject(signal.reason);
        signal.addEventListener('abort', onAbort, {once: true});
        promise.then(
            (value) => {
                signal.removeEventListener('abort', onAbort);
                resolve(value);
            },
            (error: unknown) => {
                signal.removeEventListener('abort', onAbort);
                reject(error);
            },
        );
    });
}
