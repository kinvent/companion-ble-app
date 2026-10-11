/**
 * QUICKSTART: the smallest complete program that records from one Kinvent sensor through the companion app.
 *
 * Read this file first. It is the whole SDK flow in about one screen, with no prompts, no CSV file and no
 * pair handling. The sample under `src/` does the same thing with every detail a real tool needs; the
 * README maps each step here to the file and function there.
 *
 *   build:  npm run build:examples
 *   run:    node dist-examples/quickstart.js GRIP 5   (from the folder of this project)
 *           (argument 1: a DeviceType such as GRIP, MUSCLE_TESTER, LINK, BUBBLE; argument 2: seconds)
 *
 * It prints the live values to the terminal and writes NOTHING to disk. Sensor values of a person are health
 * data: if you change it to save them, keep the files on this computer and treat them as such.
 *
 * Developer example. Not for clinical use.
 */
import {firstValueFrom, filter, timeout, TimeoutError} from 'rxjs';
import {
    CompanionClient,
    CompanionError,
    DeviceState,
    DeviceType,
    streamLayoutOf,
    type ActivityConfiguration,
    type DeviceSnapshot,
    type StreamField,
} from '@kinvent/companion-sdk';

const type = (process.argv[2] ?? 'GRIP') as DeviceType;
const seconds = Number(process.argv[3] ?? '5');
if (!(Object.values(DeviceType) as string[]).includes(type)) throw new Error(`Unknown device type: ${type}`);
if (!Number.isFinite(seconds) || seconds <= 0) {
    console.error(`Seconds must be a positive number (got "${process.argv[3]}"). Example: node dist-examples/quickstart.js GRIP 5`);
    process.exit(1);
}

// ONE client per program. Without options it looks for the companion on 127.0.0.1, ports 8477 to 8481.
const client = new CompanionClient();

// 1. FIND THE COMPANION. `discover()` returns `undefined` when nothing answered; it does not throw.
if ((await client.discover()) === undefined) {
    console.error('No companion found. Start the Kinvent Companion app and run again.');
    process.exit(2);
}

// 2. CHECK THE VERSION. The SDK and the companion must have the same major.minor.patch.
//    `session.claim()` checks it again and refuses a mismatch, but here the user gets a clear message.
const compatibility = await client.compatibility();
if (compatibility.state !== 'match') {
    console.error(`Companion ${compatibility.installed}, SDK built for ${compatibility.expected}: use matching versions.`);
    process.exit(2);
}

// 3. CLAIM THE SESSION. Only one client may hold the sensors. Subscribe to `sessionLost$` BEFORE the claim:
//    a refused claim (another app holds the sensors) is reported there, `claim()` itself resolves.
let lost: string | undefined;
client.sessionLost$.subscribe((reason) => (lost = reason));
await client.session.claim();
if (lost !== undefined) {
    console.error('Another app holds the sensors (for example a Kinvent web app tab). Close it and run again.');
    process.exit(3);
}

// From here on, ALWAYS give back what was taken, in reverse order: stop the activity, then release the session.
// The SDK's poll loop keeps the session alive; if the program dies, the companion frees it after 5 seconds.
const keepAlive = setInterval(() => void client.ping().catch(() => undefined), 10_000);
try {
    // 4. PREPARE THE ACTIVITY: the whole plan at once. The companion scans, connects, configures and zeroes.
    //    `exerciseType` is left out (it means UNKNOWN); only JUMP_ANALYSIS changes what a device does.
    const plan: ActivityConfiguration = {activityCode: 'quickstart', deviceTypes: [type], registered: [], exclude: []};
    await client.prepareActivity(plan);
    console.log(`Switch on your ${type}. Waiting for it to be ready…`);

    // 5. WAIT UNTIL READY. Read readiness from the LEVEL `activityReady$`, not from the `activity.ready` event:
    //    events can be dropped, the level arrives with every poll. Then ask the companion which device it is.
    await firstValueFrom(client.activityReady$.pipe(filter(Boolean), timeout(60_000)));
    const device = (await client.devices()).find((d) => d.inUse && d.state === DeviceState.READY);
    if (device === undefined) throw new Error('The companion reports no ready device.');
    console.log(`Ready: ${device.name || device.deviceType}, ${device.configuration?.samplingFrequency ?? '?'} Hz.`);

    // 6. NAME AND UNIT OF EACH VALUE. Never hard-code channel meanings: read the stream descriptor.
    const fields = await fieldsOf(device);
    console.log(`Fields: ${fields.map((f) => `${f.name} (${f.unit})`).join(', ')}`);

    // 7. SUBSCRIBE BEFORE YOU START, or the first frames are lost. One batch = every sample of one frame.
    let samples = 0;
    let lastPrint = 0;
    const subscription = client.sampleBatches$(device.id).subscribe((batch) => {
        samples += batch.length;
        const latest = batch[batch.length - 1];
        if (latest === undefined || Date.now() - lastPrint < 500) return;
        lastPrint = Date.now();
        console.log(fields.map((f) => `${f.name} ${latest.channels[f.index]?.toFixed(2)}`).join('  '));
    });

    // 8. START, WAIT, STOP. One `measureStart` starts every device of the activity; `measureStop` is per device.
    await client.measureStart(device.id);
    await new Promise((resolve) => setTimeout(resolve, seconds * 1000));
    await client.measureStop(device.id);
    subscription.unsubscribe();
    console.log(`Done: ${samples} samples in ${seconds} s.`);
} catch (error) {
    // Every failed command is a CompanionError: `status` (0 = no answer at all), `code`, `reason`.
    if (error instanceof CompanionError) console.error(`Companion refused ${error.path}: ${error.reason ?? error.message}`);
    else if (error instanceof TimeoutError) console.error(`No ${type} was ready in 60 s. Is it switched on, charged, and free of other apps?`);
    else console.error(error);
    process.exitCode = 4;
} finally {
    // 9. CLEAN UP, in reverse order. `release()` never throws.
    clearInterval(keepAlive);
    if (client.session.id !== undefined) await client.stopActivity().catch(() => undefined);
    await client.session.release();
}

/** The descriptor's fields for `device` (`GET /streams`), else the SDK's own layout for its configuration. */
async function fieldsOf(device: DeviceSnapshot): Promise<StreamField[]> {
    const described = (await client.streamDescriptors()).find((entry) => entry.deviceId === device.id)?.fields;
    if (described !== undefined && described.length > 0) return described;
    const layout = streamLayoutOf(device.deviceType, device.configuration ?? {});
    if (layout === undefined) throw new Error(`The companion does not describe the values of a ${device.deviceType}.`);
    return layout.fields;
}
