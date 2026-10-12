/**
 * FOR INTEGRATORS: README.md section 10. Use it as a model for your own tests: it fakes the companion behind the
 * SDK's two public seams (`fetchImpl`, `webSocketImpl`), so the SDK's real code runs and no Bluetooth or
 * companion is needed. Its options (in `FakeOptions`) cover the failures worth testing.
 *
 * A fake companion for the integration test: a `fetch` and a `WebSocket` handed to
 * the SDK through `CompanionClientOptions.fetchImpl` / `webSocketImpl`, so the SDK's REAL discovery,
 * version gate, claim, poll pump and command layer run against it.
 *
 * It answers the routes of the SDK's `COMMANDS` table with the SDK's types (`Health`, `PollResponse`,
 * `DeviceSnapshot`, `ActivityState`, `FrequencySettingsSnapshot`). It needs nothing but the SDK: no Bluetooth
 * and no companion.
 *
 * Every value is synthetic. Nothing here was recorded from a person or a device.
 *
 * A pair type (PLATES, HEXAS, DELTAS_3D) is planned as LEFT + RIGHT, as the companion's host does,
 * or LEFT alone when the plan says `isMonopodal: true`. The plan (`activityState.plan.deviceTypes`) is in
 * every envelope after the prepare. Each device has its own socket and its own frames; ONE
 * `measure/start` starts every device, `measure/stop` stops the one named.
 *
 * Option `jump`: what the companion's start sequence does on a jump analysis. At the
 * first `measure/start` each device takes its new configuration (`GET /devices` and `GET /streams` answer it
 * from then on), a `stream.layout` event is queued for the next poll for each device that changed, and the
 * frames follow the new layout AT ONCE (the first one before the HTTP answer, so a frame reaches the client
 * before the event, as on the real wire, where the event travels on the poll):
 *  - `'v3'`: a K-Deltas changes to ONE value (`forceTotal`) at its ballistic family's current rate
 *    (`deltasMiniBallistic` for a `MINI`, `deltasXlBallistic` for a `CLASSIC`), IF that family is in the
 *    `jumpProtocol` mode; otherwise it keeps its four values at the family's rate (the event says only the rate).
 *    A plate (V3) keeps its four values and NO event is sent: nothing changed.
 *  - `'v2'`: a K-Deltas or a plate (V2) reports `forceTotal`; its samples' `channels` keep four entries, the
 *    total first and zeros after, at {@link V2_JUMP_RATE}.
 * The frequency routes honour `mode` as the companion does (refused on a family without one, and a (rate, mode)
 * pair that is not an option is refused). The fake refuses a plan that carries an `exerciseType` when it was not
 * built with `jump`, and one without `JUMP_ANALYSIS` when it was: so every run of every test file that is not a
 * jump test proves it sent no exercise type (`prepareBodies` keeps every plan as sent).
 */
import {
    BluetoothDeviceType,
    COMMANDS,
    DeltasVariantType,
    DeviceState,
    DeviceType,
    encodeSampleFrame,
    ExerciseType,
    platformSideOf,
    RawDataProtocolType,
    SERVICE_NAME,
    SESSION_HEADER,
    SOURCE_COMMIT,
    STREAM_PATH,
    streamLayoutOf,
    VERSION,
    type ActivityState,
    type ContractEvent,
    type DeviceConfiguration,
    type DeviceSnapshot,
    type ForceSample,
    type FrequencySettingRequest,
    type FrequencySettingsSnapshot,
    type PollResponse,
    type StreamDescriptor,
} from '@kinvent/companion-sdk';

export type Scenario =
    /** The device connects, initialises and becomes READY; the activity becomes ready. */
    | 'ready'
    /** The host reports the preparation failed (`activityState.state === 'failed'`). */
    | 'fail'
    /** Nothing of the requested type ever connects; a sensor of another type is seen by the scan. */
    | 'never'
    /** The activity becomes ready with a device of another type than requested. */
    | 'wrongType'
    /** A pair is planned; the LEFT sensor connects, the RIGHT one never does (the host's barrier waits). */
    | 'onePlateMissing'
    /** Only a RIGHT sensor of the type is nearby; nothing connects (with `--single` only LEFT can be used). */
    | 'rightOnly'
    /** `POST /activity/prepare` is refused with `400`. */
    | 'prepareRefused';

export interface FakeOptions {
    scenario?: Scenario;
    /** Every request fails as a refused connection does (`fetch` rejects with a TypeError). */
    down?: boolean;
    /** The version `/health` reports. Defaults to the SDK's `VERSION`. */
    version?: string;
    /** Another client holds the session: every poll is answered `409 claimed-by-another`. */
    heldByAnother?: boolean;
    /** The first N polls are answered `503` (the previous session is still being released). */
    busyPolls?: number;
    /** `GET /devices` answers a body that is not JSON. */
    devicesBroken?: boolean;
    /** How long `POST /session/release` takes to answer. */
    releaseDelayMs?: number;
    frequencies?: FrequencySettingsSnapshot;
    /** `GET /streams`: `'normal'` answers the READY devices' layouts, `'empty'` answers `[]`, `'error'` a 500. */
    streams?: 'normal' | 'empty' | 'error';
    /** Frames: one every `frameMs`, `samplesPerFrame` samples each (defaults 20 ms and 2: 100 Hz). */
    frameMs?: number;
    samplesPerFrame?: number;
    /** The frame `seq` the fake skips once (the SDK then reports `stream.gap {missed: 1}`). */
    skipSeqAt?: number;
    /** After this many frames, the companion reports `device.samplesLost` for frames 100..104. */
    samplesLostAfterFrames?: number;
    /** After this many frames, the device disconnects (E6). */
    disconnectAfterFrames?: number;
    /** After this many frames, another client takes the session (E7). */
    loseSessionAfterFrames?: number;
    /** `numOfChannels` the fake's force devices report (default 1, as the K-Grip and K-Push fixtures). */
    numOfChannels?: number;
    /** The ready device reports no `protocolType`, so neither `GET /streams` nor `streamLayoutOf` describes it (E11). */
    layoutMissing?: boolean;
    /** The `serialCode` the ready device's configuration reports (synthetic). */
    serialCode?: string;
    /** The set rate the ready device reports (default 75 Hz). Only the size estimate reads it. */
    samplingFrequency?: number;
    /** Ticks the LEFT / RIGHT device stays silent after `measure/start` (unequal frame counts). */
    leftFrameDelay?: number;
    rightFrameDelay?: number;
    /** Which device `disconnectAfterFrames` disconnects (default LEFT, the only one of a single sensor). */
    disconnectSide?: 'LEFT' | 'RIGHT';
    /** The RIGHT device's `timeSynced` (default `true`; the LEFT one reports `null`). */
    rightTimeSynced?: boolean | null;
    /** The RIGHT device's set rate, when it should differ from the LEFT's. */
    rightSamplingFrequency?: number;
    /** The start sequence of a jump analysis (see the file header). Absent: not a jump test. */
    jump?: 'v3' | 'v2';
    /** The variant a K-Deltas reports at READY (default `MINI` when `jump` is given; absent otherwise). */
    deltasVariant?: DeltasVariantType;
    /** Plates: the devices report `capabilities.baselineErrorCheck` (firmware 2.14 or newer). Default false. */
    baselineErrorCheck?: boolean;
    /** Plates: how many `rezero`s of each side report `CHANNEL_ABOVE_15` (someone on the plate) before one succeeds. */
    zeroErrors?: {LEFT?: number; RIGHT?: number};
    /** Plates: `rezero` is answered but no `device.baseline` event ever follows. */
    zeroSilent?: boolean;
    /**
     * K-Deltas: the RIGHT slot is filled by a 3D Delta (the companion's compatibility allows it; the other way
     * round it does not), until its id is in the plan's `exclude`. `'always'`: a new
     * one every time, so excluding never helps.
     */
    oddRight?: boolean | 'always';
    /** Remembered sensors (the plan's `registered`) with these ids never answer: the fake emits `registered.failed`. */
    registeredAbsent?: string[];
    /** Floor devices: the LEFT device's first N frames carry a load that changes by 40 kg from frame to frame. */
    unsteadyFrames?: number;
    /** What `/health` and every poll report as the adapter state. Default `poweredOn`. */
    adapterState?: 'poweredOn' | 'poweredOff' | 'unauthorized' | 'unsupported' | 'unknown' | 'resetting';
}

/** The synthetic rate of a V2 jump test in the fake (not a rate family's). */
export const V2_JUMP_RATE = 1000;

export interface Recorded {
    method: string;
    path: string;
    session: string | undefined;
    body: unknown;
}

export const FAKE_DEVICE_ID = 'fake-device-0001';
const OTHER_DEVICE_ID = 'fake-device-0002';
/** The RIGHT sensor of a pair. The LEFT one is {@link FAKE_DEVICE_ID}. */
export const FAKE_RIGHT_ID = 'fake-device-0003';
const SESSION_ID = 'fake-session-1';

/** The RIGHT Bluetooth type of a pair type (the LEFT one is in {@link BT_TYPE}). */
/** An example Bluetooth name (synthetic; the sample stores and shows it, it never reads meaning from it). */
function fakeName(type: DeviceType, side: string | null): string {
    const alias = type === DeviceType.PLATES ? 'Plate' : type === DeviceType.DELTAS_3D ? 'Deltas3D' : 'Deltas';
    return `Example ${alias} ${side === 'RIGHT' ? 'R' : 'L'}`;
}

/** The id of the RIGHT sensor of another type that `oddRight` puts in a pair. */
export const ODD_RIGHT_ID = 'fake-odd-right';

const RIGHT_BT_TYPE: Record<string, BluetoothDeviceType> = {
    [DeviceType.PLATES]: BluetoothDeviceType.PLATES_RIGHT,
    [DeviceType.HEXAS]: BluetoothDeviceType.HEXAS_RIGHT,
    [DeviceType.DELTAS_3D]: BluetoothDeviceType.DELTAS_3D_RIGHT,
};

const BT_TYPE: Record<string, BluetoothDeviceType> = {
    [DeviceType.GRIP]: BluetoothDeviceType.KFORCE_GRIP,
    [DeviceType.MUSCLE_TESTER]: BluetoothDeviceType.MUSCLE_CONTROLLER,
    [DeviceType.LINK]: BluetoothDeviceType.LINK,
    [DeviceType.PLATES]: BluetoothDeviceType.PLATES_LEFT,
    [DeviceType.HEXAS]: BluetoothDeviceType.HEXAS_LEFT,
    [DeviceType.DELTAS_3D]: BluetoothDeviceType.DELTAS_3D_LEFT,
    [DeviceType.BUBBLE]: BluetoothDeviceType.BUBBLE,
    [DeviceType.EMG]: BluetoothDeviceType.EMG,
};

/** The ballistic K-Deltas options, as the companion lists them. */
const BALLISTIC_OPTIONS = [
    {rate: 250, mode: 'default'},
    {rate: 300, mode: 'default'},
    {rate: 500, mode: 'default'},
    {rate: 500, mode: 'jumpProtocol'},
    {rate: 1000, mode: 'default'},
    {rate: 1000, mode: 'jumpProtocol'},
    {rate: 2000, mode: 'jumpProtocol'},
] as const;

export const DEFAULT_FREQUENCIES: FrequencySettingsSnapshot = {
    ble5Available: false,
    families: [
        {family: 'gripMuscleLink', options: [{rate: 75}, {rate: 150}], ble5OnlyOptions: [{rate: 1000}], current: {rate: 75}},
        {family: 'plates', options: [{rate: 100}, {rate: 500}], ble5OnlyOptions: [], current: {rate: 100}},
        // The session's defaults, 1000 Hz in the default mode.
        {family: 'deltasMiniBallistic', options: [...BALLISTIC_OPTIONS], ble5OnlyOptions: [], current: {rate: 1000, mode: 'default'}},
        {
            family: 'deltasXlBallistic',
            options: [...BALLISTIC_OPTIONS, {rate: 4000, mode: 'jumpProtocol'}],
            ble5OnlyOptions: [],
            current: {rate: 1000, mode: 'default'},
        },
    ],
};

/**
 * The configuration the fake's READY device reports, as the companion's: the protocol and channel count
 * the layout is computed from, the set rate, and `stream` (the layout, as the snapshot carries it).
 * Synthetic: chosen to exercise each layout rule, not taken from a device.
 */
export function fakeConfiguration(type: DeviceType, numOfChannels: number): DeviceConfiguration {
    const protocolType =
        type === DeviceType.DELTAS_3D
            ? RawDataProtocolType.BYTES_32_TRI
            : type === DeviceType.EMG
              ? RawDataProtocolType.V3_VOLT
              : RawDataProtocolType.V3_FORCE;
    const configuration: DeviceConfiguration = {
        capabilities: {baselineErrorCheck: false},
        timeSynced: null,
        protocolType,
        // A 3D-Deltas reports 9 channels, as the real sensor does; its frame has 10 slots.
        numOfChannels: type === DeviceType.DELTAS_3D ? 9 : numOfChannels,
        samplingFrequency: 75,
    };
    const stream = streamLayoutOf(type, configuration);
    return stream === undefined ? configuration : {...configuration, stream};
}

/** The channel count of a frame for a device type: four always for force (the frame carries f1..f4), ten for 3D. */
export function frameChannels(type: DeviceType): number {
    return type === DeviceType.DELTAS_3D ? 10 : 4;
}

/** A synthetic sample: channel `c` of sample `n` is `c + 1 + n / 100`, so every field has its own value. */
export function syntheticSample(n: number, channels: number, timeStamp: number): ForceSample {
    // A slow ramp (0.001 per sample): a stillness window of a second holds up to 4000 samples of one channel, or
    // 1000 of nine, and must stay within 1 kg (`STILL_KG`), as a sensor at rest does.
    return {timeStamp, isTimeStampFromEpoch: false, channels: Array.from({length: channels}, (_, c) => c + 1 + n / 1000)};
}

const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {status, headers: {'content-type': 'application/json'}});
const noContent = (): Response => new Response(null, {status: 204});

export class FakeCompanion {
    readonly requests: Recorded[] = [];
    readonly sockets: FakeSocket[] = [];
    /** Every sample the fake sent on a socket, and the frames that carried them. */
    emittedSamples = 0;
    emittedFrames = 0;
    /** The last sample sent, to compare with what the live view shows. */
    lastSample: ForceSample | undefined;
    /** Every sample sent, in order, to compare with the file's rows. */
    readonly sentSamples: ForceSample[] = [];
    readonly WebSocket: typeof WebSocket;

    private session: string | undefined;
    private cursor = 0;
    private polls = 0;
    private activity: ActivityState = {state: 'idle'};
    /** Stages of the scripted preparation; one stage is released per poll. */
    private stages: Array<() => ContractEvent[]> = [];
    private devices: DeviceSnapshot[] = [];
    private requestedType: DeviceType = DeviceType.GRIP;
    private readonly options: Required<Omit<FakeOptions, 'frequencies' | OptionalFrameOptions>> &
        Pick<FakeOptions, OptionalFrameOptions> & {frequencies: FrequencySettingsSnapshot};
    private emitter: ReturnType<typeof setInterval> | undefined;
    /** The plan's Bluetooth types, as `activityState.plan.deviceTypes` reports them. */
    private planSlots: BluetoothDeviceType[] | undefined;
    /** The frame state of each device, by id; `channels` and `stepMs`, the frame layout after the start. */
    private readonly streams = new Map<
        string,
        {seq: number; sampleIndex: number; measuring: boolean; delay: number; frames: number; channels?: number; totalOnly?: boolean; stepMs?: number}
    >();
    /** The start sequence ran (once per activity). */
    private jumpApplied = false;
    /** The last prepare asked for JUMP_ANALYSIS, so the start sequence may switch the layout. */
    private jumpArmed = false;
    /** How many times frames were started (`measure/start` with nothing yet running). */
    measureStarts = 0;
    /** Plates: every `POST /devices/:id/rezero`, by device id, in order. */
    readonly rezeroes: string[] = [];
    /** The `exclude` of the last `POST /activity/prepare`. */
    private lastExclude: string[] = [];
    /** The `registered` ids of the last `POST /activity/prepare`, and of every one. */
    private lastRegistered: string[] = [];
    readonly registeredSent: string[][] = [];
    /** How many odd RIGHT sensors `oddRight: 'always'` has handed out. */
    private oddCount = 0;
    /** Every `POST /activity/prepare` body, as sent. */
    readonly prepareBodies: Array<Record<string, unknown>> = [];
    /** Every `PUT /settings/frequencies` the fake accepted, in order. */
    readonly acceptedFrequencyPuts: FrequencySettingRequest[] = [];
    /** Every sample each device sent, by device id. */
    readonly sentByDevice = new Map<string, ForceSample[]>();
    /** The request body of the last `POST /activity/prepare`. */
    lastPlan: {deviceTypes: DeviceType[]; isMonopodal?: boolean; exerciseType?: string} | undefined;

    constructor(options: FakeOptions = {}) {
        this.options = {
            scenario: options.scenario ?? 'ready',
            down: options.down ?? false,
            version: options.version ?? VERSION,
            heldByAnother: options.heldByAnother ?? false,
            busyPolls: options.busyPolls ?? 0,
            devicesBroken: options.devicesBroken ?? false,
            releaseDelayMs: options.releaseDelayMs ?? 0,
            frequencies: structuredClone(options.frequencies ?? DEFAULT_FREQUENCIES),
            streams: options.streams ?? 'normal',
            frameMs: options.frameMs ?? 20,
            samplesPerFrame: options.samplesPerFrame ?? 2,
            numOfChannels: options.numOfChannels ?? 1,
            layoutMissing: options.layoutMissing ?? false,
            serialCode: options.serialCode,
            samplingFrequency: options.samplingFrequency,
            skipSeqAt: options.skipSeqAt,
            samplesLostAfterFrames: options.samplesLostAfterFrames,
            disconnectAfterFrames: options.disconnectAfterFrames,
            loseSessionAfterFrames: options.loseSessionAfterFrames,
            leftFrameDelay: options.leftFrameDelay ?? 0,
            rightFrameDelay: options.rightFrameDelay ?? 0,
            disconnectSide: options.disconnectSide ?? 'LEFT',
            rightTimeSynced: options.rightTimeSynced === undefined ? true : options.rightTimeSynced,
            rightSamplingFrequency: options.rightSamplingFrequency,
            jump: options.jump,
            deltasVariant: options.deltasVariant ?? (options.jump !== undefined ? DeltasVariantType.MINI : undefined),
            baselineErrorCheck: options.baselineErrorCheck ?? false,
            zeroErrors: {...(options.zeroErrors ?? {})},
            zeroSilent: options.zeroSilent ?? false,
            oddRight: options.oddRight ?? false,
            registeredAbsent: options.registeredAbsent ?? [],
            unsteadyFrames: options.unsteadyFrames ?? 0,
            adapterState: options.adapterState ?? 'poweredOn',
        };
        const fake = this;
        this.WebSocket = class extends FakeSocket {
            constructor(url: string, protocols?: string[]) {
                super(url, protocols);
                fake.sockets.push(this);
            }
        } as unknown as typeof WebSocket;
    }

    /** The `fetch` the SDK is given. */
    readonly fetch = (async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
        const url = new URL(String(input));
        const headers = (init?.headers ?? {}) as Record<string, string>;
        const session = Object.entries(headers).find(([key]) => key.toLowerCase() === SESSION_HEADER)?.[1];
        const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
        const method = init?.method ?? 'GET';
        this.requests.push({method, path: url.pathname, session, body});
        if (this.options.down) {
            throw new TypeError('fetch failed');
        }
        return await this.answer(method, url.pathname, session, body);
    }) as typeof fetch;

    /** How many requests matched. */
    count(method: string, path: string): number {
        return this.requests.filter((request) => request.method === method && request.path === path).length;
    }

    /** Push one event (`ContractEvent`) into the next poll (for example a `stream.layout`). */
    emitEvent(partial: Record<string, unknown>): void {
        this.stages.push(() => [event(partial)]);
    }

    /** The frames one device sent. */
    framesOf(deviceId: string): number {
        return this.streams.get(deviceId)?.frames ?? 0;
    }

    /** The requests other than the poll, as `METHOD /path`, in order. */
    commands(): string[] {
        return this.requests.filter((request) => request.path !== '/poll').map((request) => `${request.method} ${request.path}`);
    }

    private async answer(method: string, path: string, session: string | undefined, body: unknown): Promise<Response> {
        if (method === 'GET' && path === COMMANDS.health.path) {
            return json({
                ok: true,
                service: SERVICE_NAME,
                version: this.options.version,
                sourceCommit: SOURCE_COMMIT,
                instanceId: 'fake-instance',
                adapterState: this.options.adapterState,
                sessionActive: this.session !== undefined || this.options.heldByAnother,
            });
        }
        if (method === 'GET' && path === COMMANDS.poll.path) return this.poll(session);
        if (method === 'POST' && path === COMMANDS.releaseSession.path) {
            if (this.options.releaseDelayMs > 0) await new Promise((resolve) => setTimeout(resolve, this.options.releaseDelayMs));
            if (session !== undefined && session === this.session) {
                this.stopFrames();
                this.session = undefined;
                this.activity = {state: 'idle'};
                this.stages = [];
            }
            return json({ok: true});
        }

        // Every other route is session-owned, as on the companion.
        if (session === undefined || session !== this.session) {
            return json({error: 'No active session, or this is not your session. Poll first.', reason: 'no-session'}, 409);
        }
        if (method === COMMANDS.prepareActivity.method && path === COMMANDS.prepareActivity.path) return this.prepare(body);
        if (method === COMMANDS.stopActivity.method && path === COMMANDS.stopActivity.path) {
            this.stopFrames();
            this.activity = {state: 'idle'};
            this.stages = [];
            // The companion releases the activity's devices: none is in use any more.
            this.devices = this.devices.map((device) => ({...device, inUse: false}));
            return noContent();
        }
        if (method === COMMANDS.ping.method && path === COMMANDS.ping.path) return json({pinged: 0, skipped: 0});
        if (method === COMMANDS.devices.method && path === COMMANDS.devices.path) {
            return this.options.devicesBroken ? new Response('<html>not json</html>', {status: 200}) : json(this.devices);
        }
        if (method === COMMANDS.streamDescriptors.method && path === COMMANDS.streamDescriptors.path) {
            if (this.options.streams === 'error') return json({error: 'fake companion: streams broken'}, 500);
            if (this.options.streams === 'empty') return json([]);
            const descriptors: StreamDescriptor[] = this.devices.flatMap((device) => {
                const layout = device.state === DeviceState.READY ? streamLayoutOf(device.deviceType, device.configuration ?? {}) : undefined;
                return layout === undefined ? [] : [{deviceId: device.id, ...layout}];
            });
            return json(descriptors);
        }
        const startId = deviceIdOf(COMMANDS.measureStart.path, path);
        if (method === COMMANDS.measureStart.method && startId !== undefined && this.devices.some((device) => device.id === startId)) {
            // ONE start starts every device of the activity.
            this.startFrames();
            return noContent();
        }
        const rezeroId = deviceIdOf(COMMANDS.rezero.path, path);
        const rezeroed = this.devices.find((device) => device.id === rezeroId);
        if (method === COMMANDS.rezero.method && rezeroed !== undefined) {
            this.rezeroes.push(rezeroed.id);
            if (this.options.zeroSilent) return noContent();
            const side = rezeroed.side ?? 'LEFT';
            const left = this.options.zeroErrors[side] ?? 0;
            if (left > 0) this.options.zeroErrors[side] = left - 1;
            this.emitEvent({type: 'device.baseline', deviceId: rezeroed.id, ...(left > 0 ? {error: 'CHANNEL_ABOVE_15'} : {})});
            return noContent();
        }
        const stopId = deviceIdOf(COMMANDS.measureStop.path, path);
        if (method === COMMANDS.measureStop.method && stopId !== undefined && this.devices.some((device) => device.id === stopId)) {
            // A stop stops the device named only.
            this.stopFrames(stopId);
            return noContent();
        }
        if (method === COMMANDS.frequencySettings.method && path === COMMANDS.frequencySettings.path) {
            return json(this.options.frequencies);
        }
        if (method === COMMANDS.setFrequencySetting.method && path === COMMANDS.setFrequencySetting.path) {
            return this.setFrequency(body as FrequencySettingRequest);
        }
        return json({error: `fake companion: no route ${method} ${path}`}, 404);
    }

    /**
     * `PUT /settings/frequencies`, as the companion decides it:
     * an unknown family, a rate that is not an option, a `mode` on a family without one or a (rate, mode) pair that
     * is not an option → `400 {code: 'INVALID_CONFIGURATION', reason}`, nothing changed. Accepted: `current` is set
     * (a family with a mode gets `default` when none is sent).
     */
    private setFrequency(request: FrequencySettingRequest): Response {
        const refuse = (reason: string): Response => json({error: 'invalid frequency setting', code: 'INVALID_CONFIGURATION', reason}, 400);
        const family = this.options.frequencies.families.find((entry) => entry.family === request.family);
        if (family === undefined) return refuse('family');
        const hasMode = family.options.some((option) => option.mode !== undefined);
        if (request.mode !== undefined && !hasMode) return refuse('mode');
        const wanted = hasMode ? (request.mode ?? 'default') : undefined;
        const pool = [...family.options, ...(this.options.frequencies.ble5Available ? family.ble5OnlyOptions : [])];
        const sameRate = pool.filter((option) => option.rate === request.rate);
        if (sameRate.length === 0) return refuse('rate');
        if (!sameRate.some((option) => wanted === undefined || option.mode === wanted)) return refuse('mode');
        family.current = wanted === undefined ? {rate: request.rate} : {rate: request.rate, mode: wanted};
        this.acceptedFrequencyPuts.push({...request});
        return noContent();
    }

    /**
     * The start sequence of a jump analysis (see the file header): each device's new configuration, a
     * `stream.layout` for each one that changed (queued for the next poll), and its frame layout.
     */
    private applyJumpStart(): void {
        if (this.options.jump === undefined || !this.jumpArmed || this.jumpApplied) return;
        this.jumpApplied = true;
        const events: ContractEvent[] = [];
        this.devices = this.devices.map((device) => {
            const configuration = device.configuration ?? fakeConfiguration(device.deviceType, this.options.numOfChannels);
            let next: DeviceConfiguration | undefined;
            let frame: {channels: number; totalOnly: boolean; rate: number} | undefined;
            if (this.options.jump === 'v2' && (device.deviceType === DeviceType.HEXAS || device.deviceType === DeviceType.PLATES)) {
                next = {...configuration, protocolType: RawDataProtocolType.JUMP_PROTOCOL, numOfChannels: 4, samplingFrequency: V2_JUMP_RATE};
                frame = {channels: 4, totalOnly: true, rate: V2_JUMP_RATE};
            } else if (this.options.jump === 'v3' && device.deviceType === DeviceType.HEXAS) {
                const familyName = configuration.deltasVariant === DeltasVariantType.CLASSIC ? 'deltasXlBallistic' : 'deltasMiniBallistic';
                const family = this.options.frequencies.families.find((entry) => entry.family === familyName);
                const rate = family?.current.rate ?? 1000;
                if (family?.current.mode === 'jumpProtocol') {
                    next = {...configuration, protocolType: RawDataProtocolType.V3_JUMP_PROTOCOL, numOfChannels: 1, samplingFrequency: rate};
                    frame = {channels: 1, totalOnly: false, rate};
                } else {
                    // Not in the jump mode: the ballistic rate, the four cells.
                    next = {...configuration, samplingFrequency: rate};
                    frame = {channels: frameChannels(device.deviceType), totalOnly: false, rate};
                }
            }
            if (next === undefined || frame === undefined) return device;
            const {stream: _old, ...rest} = next;
            const layout = streamLayoutOf(device.deviceType, rest);
            const changed: DeviceConfiguration = layout === undefined ? rest : {...rest, stream: layout};
            events.push(event({type: 'stream.layout', deviceId: device.id, configuration: changed}));
            const stream = this.streams.get(device.id);
            if (stream !== undefined) {
                stream.channels = frame.channels;
                stream.totalOnly = frame.totalOnly;
                stream.stepMs = 1000 / frame.rate;
            }
            return {...device, configuration: changed};
        });
        if (events.length > 0) this.stages.push(() => events);
    }

    private poll(session: string | undefined): Response {
        this.polls += 1;
        if (this.options.heldByAnother) return json({error: 'A session is already active', reason: 'claimed-by-another'}, 409);
        if (this.polls <= this.options.busyPolls) {
            return json({error: 'The previous session is still being released. Retry.'}, 503);
        }
        if (this.session === undefined) {
            this.session = SESSION_ID;
        } else if (session !== this.session) {
            return json({error: 'A session is already active', reason: 'claimed-by-another'}, 409);
        }
        const stage = this.stages.shift();
        const events = (stage?.() ?? []).map((event) => ({...event, seq: ++this.cursor}) as ContractEvent);
        const activityState: ActivityState =
            this.planSlots !== undefined && this.activity.state !== 'idle'
                ? {...this.activity, plan: {steps: [], deviceTypes: [...this.planSlots], startedAt: 0}}
                : this.activity;
        const envelope: PollResponse = {
            sessionId: this.session,
            cursor: this.cursor,
            adapterState: this.options.adapterState,
            activityState,
            events,
            dropped: 0,
        };
        return json(envelope);
    }

    /**
     * `measure/start`: the first frame goes out AT ONCE, before the HTTP answer (a client that subscribes
     * only after `measureStart` resolves misses it), then one frame every `frameMs`. For every device
     * of the activity, each on its own socket, with its own `seq` and sample numbering; a device with a
     * `*FrameDelay` stays silent for that many ticks first.
     */
    private startFrames(): void {
        if (this.emitter !== undefined) return;
        // What was SENT describes the measurement being started: a recording's rows are compared with it, and a
        // stillness check before the recording is a measurement of its own.
        this.sentSamples.length = 0;
        this.sentByDevice.clear();
        this.emittedSamples = 0;
        this.emittedFrames = 0;
        this.measureStarts += 1;
        for (const device of this.devices) {
            const delay = device.side === 'RIGHT' ? this.options.rightFrameDelay : this.options.leftFrameDelay;
            const stream = this.streams.get(device.id) ?? {seq: 0, sampleIndex: 0, measuring: false, delay, frames: 0};
            stream.measuring = true;
            this.streams.set(device.id, stream);
        }
        // The start sequence of a jump analysis changes the configuration before the first frame.
        this.applyJumpStart();
        const tick = (): void => {
            for (const device of this.devices) {
                const stream = this.streams.get(device.id);
                if (stream === undefined || !stream.measuring) continue;
                if (stream.delay > 0) {
                    stream.delay -= 1;
                    continue;
                }
                const socket = this.sockets.find((entry) => entry.readyState === 1 && entry.url.endsWith(`${STREAM_PATH}/${device.id}`));
                if (socket === undefined) continue;
                const left = device.id === FAKE_DEVICE_ID;
                if (left && this.options.skipSeqAt !== undefined && stream.seq === this.options.skipSeqAt) stream.seq += 1;
                const samples = Array.from({length: this.options.samplesPerFrame}, () => {
                    const n = stream.sampleIndex++;
                    const sample = syntheticSample(n, stream.channels ?? frameChannels(device.deviceType), n * (stream.stepMs ?? 10));
                    // V2 jump test: four channels, the total first and zeros after.
                    if (stream.totalOnly === true) sample.channels = sample.channels.map((value, c) => (c === 0 ? value : 0));
                    if (left && stream.frames < this.options.unsteadyFrames) sample.channels[0]! += stream.frames % 2 === 0 ? 20 : -20;
                    return sample;
                });
                socket.sendBinary(encodeSampleFrame({seq: stream.seq++, samples}));
                stream.frames += 1;
                this.emittedFrames += 1;
                this.emittedSamples += samples.length;
                this.lastSample = samples[samples.length - 1];
                const copies = samples.map((sample) => ({...sample, channels: [...sample.channels]}));
                this.sentSamples.push(...copies);
                this.sentByDevice.set(device.id, [...(this.sentByDevice.get(device.id) ?? []), ...copies]);
                this.afterFrame(device, stream.frames);
                if (this.emitter === undefined) return;
            }
        };
        this.emitter = setInterval(tick, this.options.frameMs);
        tick();
    }

    /** Stops one device's frames, or every device's; the timer ends when none is measuring. */
    private stopFrames(deviceId?: string): void {
        for (const [id, stream] of this.streams) if (deviceId === undefined || id === deviceId) stream.measuring = false;
        if ([...this.streams.values()].some((stream) => stream.measuring)) return;
        clearInterval(this.emitter);
        this.emitter = undefined;
    }

    /** The scripted trouble of E6, E7 and the loss events, by the frame count of the device concerned. */
    private afterFrame(device: DeviceSnapshot, frames: number): void {
        const left = device.id === FAKE_DEVICE_ID;
        if (left && frames === this.options.samplesLostAfterFrames) {
            this.stages.push(() => [event({type: 'device.samplesLost', deviceId: FAKE_DEVICE_ID, fromSeq: 100, toSeq: 104})]);
        }
        const disconnecting = (device.side ?? 'LEFT') === this.options.disconnectSide;
        if (disconnecting && frames === this.options.disconnectAfterFrames) {
            this.stopFrames(device.id);
            this.devices = this.devices.map((entry) => (entry.id === device.id ? {...entry, state: DeviceState.DISCONNECTED} : entry));
            this.stages.push(() => [
                event({type: 'device.state', deviceId: device.id, state: DeviceState.DISCONNECTED}),
                event({type: 'device.disconnected', deviceId: device.id, reason: 'link lost'}),
            ]);
        }
        if (left && frames === this.options.loseSessionAfterFrames) {
            this.stopFrames();
            // Another client holds the radio now: every poll and command of ours is refused with 409.
            this.session = 'fake-session-of-another-client';
        }
    }

    private prepare(body: unknown): Response {
        if (this.options.scenario === 'prepareRefused') {
            return json({error: 'invalid configuration', code: 'INVALID_CONFIGURATION', reason: 'deviceTypes'}, 400);
        }
        const plan = body as {
            deviceTypes: DeviceType[];
            isMonopodal?: boolean;
            exerciseType?: string;
            exclude?: string[];
            registered?: Array<{deviceId: string}>;
        };
        this.lastExclude = plan.exclude ?? [];
        this.lastRegistered = (plan.registered ?? []).map((entry) => entry.deviceId);
        this.registeredSent.push([...this.lastRegistered]);
        this.prepareBodies.push(structuredClone(body as Record<string, unknown>));
        // An exercise type only on a jump test, and then exactly JUMP_ANALYSIS (see the file header). A jump fake
        // also accepts a prepare WITHOUT one — the zeroing step of a K-Deltas jump test — and arms the jump layout only for a plan
        // that asks for it.
        if ('exerciseType' in (body as object) && plan.exerciseType !== ExerciseType.JUMP_ANALYSIS) {
            return json({error: `fake companion: unexpected exerciseType ${String(plan.exerciseType)}`, code: 'INVALID_CONFIGURATION', reason: 'exerciseType'}, 400);
        }
        if (this.options.jump === undefined && 'exerciseType' in (body as object)) {
            return json({error: 'fake companion: unexpected exerciseType on a non-jump fake', code: 'INVALID_CONFIGURATION', reason: 'exerciseType'}, 400);
        }
        this.jumpArmed = plan.exerciseType === ExerciseType.JUMP_ANALYSIS;
        this.lastPlan = plan;
        this.jumpApplied = false;
        this.requestedType = plan.deviceTypes[0]!;
        this.activity = {state: 'preparing'};
        const scenario = this.options.scenario;
        // The host's expansion — a pair type gives LEFT + RIGHT, LEFT alone when monopodal.
        const right = RIGHT_BT_TYPE[this.requestedType];
        this.planSlots =
            right === undefined || plan.isMonopodal === true ? [BT_TYPE[this.requestedType]!] : [BT_TYPE[this.requestedType]!, right];
        if (right !== undefined && (scenario === 'ready' || scenario === 'onePlateMissing' || scenario === 'rightOnly')) {
            return this.preparePair(right, scenario);
        }
        const actualType =
            scenario === 'wrongType' ? (this.requestedType === DeviceType.PLATES ? DeviceType.GRIP : DeviceType.PLATES) : this.requestedType;

        if (scenario === 'never') {
            const other = this.requestedType === DeviceType.MUSCLE_TESTER ? DeviceType.GRIP : DeviceType.MUSCLE_TESTER;
            this.stages = [
                () => [
                    discovery(OTHER_DEVICE_ID, BT_TYPE[other]!),
                    discovery('fake-not-kinvent', BluetoothDeviceType.UNKNOWN),
                    // The same sensor advertising again: counted once.
                    discovery(OTHER_DEVICE_ID, BT_TYPE[other]!),
                ],
            ];
            return noContent();
        }

        const found = (state: DeviceState): DeviceSnapshot => ({
            id: FAKE_DEVICE_ID,
            name: '',
            deviceType: actualType,
            bluetoothDeviceType: BT_TYPE[actualType]!,
            side: platformSideOf(BT_TYPE[actualType]!),
            state,
            inUse: true,
            measuring: false,
        });
        let configuration = fakeConfiguration(actualType, this.options.numOfChannels);
        if (this.options.baselineErrorCheck) configuration = {...configuration, capabilities: {baselineErrorCheck: true}};
        if (this.options.deltasVariant !== undefined && actualType === DeviceType.HEXAS) configuration = {...configuration, deltasVariant: this.options.deltasVariant};
        if (this.options.layoutMissing) {
            const {protocolType: _protocol, stream: _stream, ...rest} = configuration;
            configuration = rest;
        }
        if (this.options.serialCode !== undefined) configuration = {...configuration, serialCode: this.options.serialCode};
        if (this.options.samplingFrequency !== undefined) configuration = {...configuration, samplingFrequency: this.options.samplingFrequency};
        this.stages = [
            () => {
                this.devices = [found(DeviceState.CONNECTING)];
                return [discovery(FAKE_DEVICE_ID, BT_TYPE[actualType]!), event({type: 'device.found', device: found(DeviceState.CONNECTING)})];
            },
            () => {
                this.devices = [found(DeviceState.CONNECTED)];
                return [event({type: 'device.state', deviceId: FAKE_DEVICE_ID, state: DeviceState.CONNECTED})];
            },
        ];
        if (scenario === 'fail') {
            this.stages.push(() => {
                const failure = {step: 'init' as const, reason: 'the sensor did not answer', deviceId: FAKE_DEVICE_ID};
                this.activity = {state: 'failed', failure};
                return [event({type: 'activity.preparationFailed', ...failure})];
            });
            return noContent();
        }
        this.stages.push(
            () => {
                this.devices = [found(DeviceState.INITIALIZING)];
                return [event({type: 'device.state', deviceId: FAKE_DEVICE_ID, state: DeviceState.INITIALIZING})];
            },
            () => {
                const ready = {...found(DeviceState.READY), configuration};
                this.devices = [ready];
                this.activity = {state: 'ready'};
                return [
                    event({type: 'device.state', deviceId: FAKE_DEVICE_ID, state: DeviceState.READY}),
                    event({type: 'device.ready', deviceId: FAKE_DEVICE_ID, configuration}),
                    event({type: 'activity.ready', devices: [ready], steps: ['validate', 'devices', 'init', 'baseline', 'layout', 'ready']}),
                ];
            },
        );
        return noContent();
    }

    /**
     * A pair type. Each planned device goes CONNECTING → CONNECTED → INITIALIZING → READY; the activity
     * is ready when all are (the host's all-connected barrier). `onePlateMissing`: the RIGHT one never
     * connects, so the activity never becomes ready. `rightOnly`: the scan sees a RIGHT sensor only.
     */
    private preparePair(rightBt: BluetoothDeviceType, scenario: Scenario): Response {
        const type = this.requestedType;
        const leftBt = BT_TYPE[type]!;
        if (scenario === 'rightOnly') {
            this.stages = [() => [discovery(FAKE_RIGHT_ID, rightBt), discovery('fake-not-kinvent', BluetoothDeviceType.UNKNOWN)]];
            return noContent();
        }
        // Only this way round: a 3D Delta may fill a K-Deltas slot, a K-Delta never fills a 3D Deltas one.
        const oddType = type === DeviceType.HEXAS ? DeviceType.DELTAS_3D : undefined;
        const oddId = this.options.oddRight === 'always' ? `${ODD_RIGHT_ID}-${++this.oddCount}` : ODD_RIGHT_ID;
        const absent = this.lastRegistered.find((id) => this.options.registeredAbsent.includes(id));
        if (absent !== undefined) {
            // As the companion: the remembered sensor is tried first and does not answer; nothing else happens.
            this.stages = [() => [event({type: 'registered.failed', deviceId: absent})]];
            return noContent();
        }
        // A remembered RIGHT sensor is connected directly, before any scan: no odd sensor can take its slot.
        const odd =
            this.options.oddRight !== false && oddType !== undefined && !this.lastExclude.includes(oddId) && !this.lastRegistered.includes(FAKE_RIGHT_ID);
        const planned = this.planSlots!.map((bt) =>
            bt !== leftBt && odd
                ? {id: oddId, bt: RIGHT_BT_TYPE[oddType!]!, side: platformSideOf(bt), deviceType: oddType!}
                : {id: bt === leftBt ? FAKE_DEVICE_ID : FAKE_RIGHT_ID, bt, side: platformSideOf(bt), deviceType: type},
        );
        const connecting = scenario === 'onePlateMissing' ? planned.filter((entry) => entry.side === 'LEFT') : planned;
        const snapshot = (entry: (typeof planned)[number], state: DeviceState): DeviceSnapshot => ({
            id: entry.id,
            name: fakeName(entry.deviceType, entry.side),
            deviceType: entry.deviceType,
            bluetoothDeviceType: entry.bt,
            side: entry.side,
            state,
            inUse: true,
            measuring: false,
        });
        const configurationOf = (entry: (typeof planned)[number]): DeviceConfiguration => {
            let configuration = fakeConfiguration(entry.deviceType, this.options.numOfChannels);
            if (this.options.baselineErrorCheck) configuration = {...configuration, capabilities: {baselineErrorCheck: true}};
            if (this.options.deltasVariant !== undefined && type === DeviceType.HEXAS) configuration = {...configuration, deltasVariant: this.options.deltasVariant};
            if (this.options.serialCode !== undefined) configuration = {...configuration, serialCode: `${this.options.serialCode}-${entry.side}`};
            if (this.options.samplingFrequency !== undefined) configuration = {...configuration, samplingFrequency: this.options.samplingFrequency};
            if (entry.side === 'RIGHT') {
                configuration = {...configuration, timeSynced: this.options.rightTimeSynced};
                if (this.options.rightSamplingFrequency !== undefined) configuration = {...configuration, samplingFrequency: this.options.rightSamplingFrequency};
            }
            return configuration;
        };
        const states = (state: DeviceState): ContractEvent[] => {
            this.devices = connecting.map((entry) => snapshot(entry, state));
            return connecting.map((entry) => event({type: 'device.state', deviceId: entry.id, state}));
        };
        this.stages = [
            () => {
                // The RIGHT one first on the wire: the plan's order, not the arrival order, decides the columns.
                const found = [...connecting].reverse();
                this.devices = found.map((entry) => snapshot(entry, DeviceState.CONNECTING));
                return found.flatMap((entry) => [discovery(entry.id, entry.bt), event({type: 'device.found', device: snapshot(entry, DeviceState.CONNECTING)})]);
            },
            () => states(DeviceState.CONNECTED),
        ];
        if (scenario === 'onePlateMissing') return noContent();
        this.stages.push(
            () => states(DeviceState.INITIALIZING),
            () => {
                const ready = [...connecting].reverse().map((entry) => ({...snapshot(entry, DeviceState.READY), configuration: configurationOf(entry)}));
                this.devices = ready;
                this.activity = {state: 'ready'};
                const ordered = connecting.map((entry) => ready.find((device) => device.id === entry.id)!);
                return [
                    ...ready.flatMap((device) => [
                        event({type: 'device.state', deviceId: device.id, state: DeviceState.READY}),
                        event({type: 'device.ready', deviceId: device.id, configuration: device.configuration}),
                    ]),
                    event({type: 'activity.ready', devices: ordered, steps: ['validate', 'devices', 'init', 'baseline', 'layout', 'ready']}),
                ];
            },
        );
        return noContent();
    }
}

type OptionalFrameOptions =
    | 'skipSeqAt'
    | 'samplesLostAfterFrames'
    | 'disconnectAfterFrames'
    | 'loseSessionAfterFrames'
    | 'serialCode'
    | 'samplingFrequency'
    | 'rightSamplingFrequency'
    | 'jump'
    | 'deltasVariant';

/** The device id in `path` when it matches the route `template` (with `:id`), else `undefined`. */
function deviceIdOf(template: string, path: string): string | undefined {
    const [before, after] = template.split(':id');
    if (before === undefined || after === undefined || !path.startsWith(before) || !path.endsWith(after)) return undefined;
    return decodeURIComponent(path.slice(before.length, path.length - after.length));
}

/** An event before the fake numbers it (`seq` is set by `poll`). */
function event(partial: Record<string, unknown>): ContractEvent {
    return {seq: 0, ...partial} as unknown as ContractEvent;
}

function discovery(id: string, bluetoothDeviceType: BluetoothDeviceType): ContractEvent {
    return event({type: 'scan.discovery', device: {id, localName: null, rssi: -60, address: null}, bluetoothDeviceType});
}

type Listener = (event: unknown) => void;

/**
 * A sample socket that opens on the next tick. The SDK opens it when the device reaches CONNECTED and
 * closes it on release; the fake companion sends real binary frames on it after `measure/start`.
 */
export class FakeSocket {
    readyState = 0;
    binaryType = 'arraybuffer';
    readonly protocols: string[];
    private readonly listeners = new Map<string, Array<{listener: Listener; once: boolean}>>();

    constructor(
        readonly url: string,
        protocols?: string[],
    ) {
        this.protocols = protocols ?? [];
        setTimeout(() => {
            if (this.readyState !== 0) return;
            this.readyState = 1;
            this.emit('open', {});
        }, 0);
    }

    addEventListener(type: string, listener: Listener, options?: {once?: boolean}): void {
        const list = this.listeners.get(type) ?? [];
        list.push({listener, once: options?.once === true});
        this.listeners.set(type, list);
    }

    removeEventListener(type: string, listener: Listener): void {
        this.listeners.set(
            type,
            (this.listeners.get(type) ?? []).filter((entry) => entry.listener !== listener),
        );
    }

    /** One binary message, as the companion sends a frame: an `ArrayBuffer` holding exactly the frame. */
    sendBinary(bytes: Uint8Array): void {
        if (this.readyState !== 1) return;
        const data = bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength);
        this.emit('message', {data});
    }

    close(): void {
        if (this.readyState === 3) return;
        this.readyState = 3;
        this.emit('close', {reason: ''});
    }

    private emit(type: string, event: unknown): void {
        const list = this.listeners.get(type) ?? [];
        this.listeners.set(
            type,
            list.filter((entry) => !entry.once),
        );
        for (const entry of list) entry.listener(event);
    }
}
