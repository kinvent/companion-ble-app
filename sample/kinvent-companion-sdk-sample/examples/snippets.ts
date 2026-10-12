/**
 * THE README'S SNIPPETS, compiled. Each function below is one snippet of README.md section 5, word for word, so
 * `npm run typecheck` proves the snippets still match the SDK. Nothing calls them: this file is a reference, not
 * a program. For a program that runs, see `quickstart.ts`.
 *
 * Developer example. Not for clinical use.
 */
import {filter, firstValueFrom, timeout} from 'rxjs';
import {
    CompanionClient,
    CompanionError,
    DeviceState,
    DeviceType,
    ExerciseType,
    streamLayoutOf,
    type ActivityConfiguration,
    type BaselineErrorCode,
    type DeviceSnapshot,
    type ForceSample,
    type FrequencyFamily,
    type RegisteredDevice,
    type StreamField,
} from '@kinvent/companion-sdk';

// --- 5.2 Connect -------------------------------------------------------------------------------------------------

export async function connect(): Promise<CompanionClient> {
    const client = new CompanionClient(); // or new CompanionClient({baseUrl: 'http://127.0.0.1:8478'}) to pin a port

    if ((await client.discover()) === undefined) throw new Error('No companion on 127.0.0.1:8477-8481.');

    const compatibility = await client.compatibility();
    if (compatibility.state !== 'match') {
        throw new Error(`Companion ${compatibility.installed}, SDK ${compatibility.expected}: versions differ.`);
    }

    let lost: 'refused' | 'replaced' | undefined;
    client.sessionLost$.subscribe((reason) => (lost = reason)); // subscribe BEFORE the claim
    await client.session.claim();
    if (lost !== undefined) throw new Error('Another app holds the sensors.');
    return client;
}

// --- 5.3 Keep-alive --------------------------------------------------------------------------------------------

export function startKeepAlive(client: CompanionClient): () => void {
    const timer = setInterval(() => void client.ping().catch(() => undefined), 10_000);
    return () => clearInterval(timer);
}

// --- 5.4 Prepare one sensor and wait until it is ready ----------------------------------------------------------

export async function prepareOne(client: CompanionClient, type: DeviceType): Promise<DeviceSnapshot> {
    const plan: ActivityConfiguration = {
        activityCode: 'my-app', // a correlation id, max 64 characters; never a patient name or id
        deviceTypes: [type],
        registered: [],
        exclude: [],
    };
    await client.prepareActivity(plan);

    await firstValueFrom(client.activityReady$.pipe(filter(Boolean), timeout(60_000)));
    const device = (await client.devices()).find((d) => d.inUse && d.state === DeviceState.READY);
    if (device === undefined) throw new Error('No ready device.');
    return device;
}

// --- 5.5 A pair (plates, K-Deltas, 3D Deltas) -------------------------------------------------------------------

export async function preparePair(client: CompanionClient, rememberedLastTime: RegisteredDevice[]): Promise<DeviceSnapshot[]> {
    // Watch for a remembered sensor that does not answer: the companion then stops preparing.
    const failed = client.events$.subscribe((event) => {
        if (event.type === 'registered.failed') console.warn(`Sensor ${event.deviceId} did not answer.`);
    });
    try {
        await client.prepareActivity({
            activityCode: 'my-app',
            deviceTypes: [DeviceType.PLATES], // the companion plans LEFT + RIGHT
            isMonopodal: false, // true: the LEFT plate alone
            registered: rememberedLastTime, // connected directly, before any scan
            exclude: [],
        });
        await firstValueFrom(client.activityReady$.pipe(filter(Boolean), timeout(60_000)));
        const ready = (await client.devices()).filter((d) => d.inUse && d.state === DeviceState.READY);
        // LEFT first. A 3D Delta may fill a K-Deltas slot (as in the mobile app): check `deviceType` per device.
        return ready.sort((a, b) => (a.side === 'LEFT' ? -1 : b.side === 'LEFT' ? 1 : 0));
    } finally {
        failed.unsubscribe();
    }
}

/** What to store after a good run, to hand back as `registered` next time. */
export function toRegistered(devices: readonly DeviceSnapshot[], type: DeviceType): RegisteredDevice[] {
    return devices
        .filter((d) => d.deviceType === type && d.name !== '')
        .map((d, k) => ({deviceId: d.id, deviceName: d.name, deviceType: type, connectionOrder: k + 1}));
}

// --- 5.6 Names and units of the values ---------------------------------------------------------------------------

export async function fieldsOf(client: CompanionClient, device: DeviceSnapshot): Promise<StreamField[]> {
    const described = (await client.streamDescriptors()).find((entry) => entry.deviceId === device.id)?.fields;
    if (described !== undefined && described.length > 0) return described;
    const layout = streamLayoutOf(device.deviceType, device.configuration ?? {});
    if (layout === undefined) throw new Error(`No layout for a ${device.deviceType}.`);
    return layout.fields; // each field: {index, name, unit}; read a value as sample.channels[field.index]
}

// --- 5.7 Record ----------------------------------------------------------------------------------------------------

export async function record(client: CompanionClient, devices: readonly DeviceSnapshot[], seconds: number): Promise<ForceSample[][]> {
    const rows: ForceSample[][] = devices.map(() => []);
    // 1. Subscribe for EVERY device BEFORE the start.
    const subscriptions = devices.map((device, k) =>
        client.sampleBatches$(device.id).subscribe((batch) => rows[k]!.push(...batch)),
    );
    try {
        // 2. ONE start for the whole activity (it starts every device).
        await client.measureStart(devices[0]!.id);
        await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
        // 3. One stop PER device. Keep the subscriptions until the stops have answered.
        for (const device of devices) await client.measureStop(device.id);
    } finally {
        for (const subscription of subscriptions) subscription.unsubscribe();
    }
    return rows;
}

// --- 5.8 Losses and disconnections ---------------------------------------------------------------------------------

export function watchHealth(client: CompanionClient, deviceIds: readonly string[], onEnd: (why: string) => void): () => void {
    const events = client.events$.subscribe((event) => {
        if (!('deviceId' in event) || event.deviceId === undefined || !deviceIds.includes(event.deviceId)) return;
        if (event.type === 'device.samplesLost') console.warn(`${event.toSeq - event.fromSeq + 1} frames lost`);
        if (event.type === 'stream.gap') console.warn(`${event.missed} frames missed on the socket`);
        if (event.type === 'device.disconnected') onEnd(`disconnected (${event.reason ?? 'no reason'})`);
    });
    const session = client.sessionLost$.subscribe((reason) => onEnd(`session lost (${reason})`));
    const radio = client.adapterState$.subscribe((state) => {
        if (state === 'unsupported') onEnd('the companion lost its Bluetooth radio; restart the companion');
    });
    return () => [events, session, radio].forEach((subscription) => subscription.unsubscribe());
}

// --- 5.9 Sampling rate ---------------------------------------------------------------------------------------------

export async function setRate(client: CompanionClient, family: FrequencyFamily, rate: number): Promise<void> {
    const settings = await client.frequencySettings();
    const entry = settings.families.find((f) => f.family === family);
    if (entry === undefined) throw new Error(`No rate setting for ${family}.`);
    const offered = [...entry.options, ...(settings.ble5Available ? entry.ble5OnlyOptions : [])].map((o) => o.rate);
    if (!offered.includes(rate)) throw new Error(`${rate} Hz is not offered: ${offered.join(', ')} Hz.`);
    if (entry.current.rate === rate) return; // ONLY when it differs: every accepted change disconnects every sensor
    await client.setFrequencySetting({family, rate});
}

// --- 5.10 Zero (calibrate) a floor device --------------------------------------------------------------------------

export async function rezero(client: CompanionClient, deviceId: string): Promise<void> {
    // Subscribe BEFORE the request: the result can arrive in the next poll.
    const result = firstValueFrom(
        client.events$.pipe(
            filter((event) => event.type === 'device.baseline' && event.deviceId === deviceId),
            timeout(15_000),
        ),
    );
    await client.rezero(deviceId);
    const event = await result;
    const error: BaselineErrorCode | undefined = event.type === 'device.baseline' ? event.error : undefined;
    if (error !== undefined) throw new Error(`Zero failed: ${error}. Step off / release the device and retry.`);

    // A zero takes the device through INITIALIZING: start measuring only once it is READY again.
    for (let tries = 0; tries < 60; tries += 1) {
        const now = (await client.devices()).find((d) => d.id === deviceId);
        if (now?.inUse && now.state === DeviceState.READY) return;
        await new Promise((resolve) => setTimeout(resolve, 250));
    }
    throw new Error('The device did not come back ready.');
}

// --- 5.11 Jump test ------------------------------------------------------------------------------------------------

export async function prepareJump(client: CompanionClient, rate: 500 | 1000 | 2000): Promise<void> {
    // K-Deltas only: both ballistic families in the jump protocol, BEFORE the prepare (each change disconnects).
    const settings = await client.frequencySettings();
    for (const family of ['deltasMiniBallistic', 'deltasXlBallistic'] as const) {
        const current = settings.families.find((f) => f.family === family)?.current;
        if (current?.rate !== rate || current.mode !== 'jumpProtocol') {
            await client.setFrequencySetting({family, rate, mode: 'jumpProtocol'});
        }
    }
    await client.prepareActivity({
        activityCode: 'my-app',
        exerciseType: ExerciseType.JUMP_ANALYSIS, // the only exercise type that changes what a device does
        deviceTypes: [DeviceType.HEXAS],
        registered: [],
        exclude: [],
    });
}

/** The layout changes when the measurement starts: subscribe BEFORE `measureStart`. */
export function watchLayout(client: CompanionClient, onFields: (deviceId: string, fields: StreamField[]) => void): () => void {
    const subscription = client.events$.subscribe((event) => {
        if (event.type !== 'stream.layout') return;
        const fields = event.configuration.stream?.fields;
        if (fields !== undefined) onFields(event.deviceId, fields); // a K-Deltas: one field, forceTotal
    });
    return () => subscription.unsubscribe();
}

// --- 5.12 Clean exit -----------------------------------------------------------------------------------------------

export async function shutdown(client: CompanionClient, stopKeepAlive: () => void): Promise<void> {
    stopKeepAlive();
    if (client.session.id !== undefined) await client.stopActivity().catch(() => undefined);
    await client.session.release(); // never throws; never POST /reset
}

// --- 5.13 Errors ---------------------------------------------------------------------------------------------------

export function explain(error: unknown): string {
    if (!(error instanceof CompanionError)) return String(error);
    if (error.status === 0) return 'No answer from the companion. Is it running?';
    if (error.code === 'VERSION_MISMATCH') return 'The companion and the SDK versions differ.';
    if (error.status === 409) return 'Another app holds the sensors, or the session ended.';
    if (error.code === 'STATE') return `Not now: the companion is ${error.state ?? 'busy'} (${error.command ?? error.path}).`;
    if (error.code === 'INVALID_CONFIGURATION') return `Invalid request field: ${error.reason ?? '?'}.`;
    return `${error.path}: ${error.reason ?? error.message}`;
}
