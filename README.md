# Kinvent Companion CLI sample

**Start here if you want to read Kinvent sensors from your own program.**

This package is a working Node.js program that records raw force data from Kinvent sensors (K-Grip, K-Push,
K-Pull, K-Bubble, K-Plates, K-Deltas, K-Deltas 3D) through the **Kinvent Companion app**, using only the public
**`@kinvent/companion-sdk`**. It is written to be read and reused: every step a real integration needs is here,
with the reasons in the code comments.

> **Developer sample. Not for clinical use.** Recordings are sensor data of a person: health data under GDPR.
> Anything you build on this that changes sampling rates, calibration or the measurement path of a medical device
> must be checked by your own device software, quality and regulatory (EU MDR) people before release.

> **Licence.** See [`LICENSE`](./LICENSE). Kinvent provides the licence terms before delivery.

| You want to… | Read |
|---|---|
| Understand how the pieces fit, and see the SDK in short snippets | this file, sections 1 to 5 |
| Run the smallest complete program | [`examples/quickstart.ts`](./examples/quickstart.ts) (section 3) |
| Find where the sample does something, and why | this file, sections 6 to 8, then the code comments |
| Install the SDK from Kinvent's private npm registry | this file, section 2 |
| Run the sample: flags, devices, the CSV format, error messages, exit codes | [`GUIDE.md`](./GUIDE.md) |
| Test without sensors | this file, section 10 |
| Look up an SDK method | this file, section 5, and the SDK's type declarations (`node_modules/@kinvent/companion-sdk/dist/index.d.ts`) |

---

## Contents

1. [How it fits together](#1-how-it-fits-together)
2. [Requirements](#2-requirements)
3. [Try it in five minutes](#3-try-it-in-five-minutes)
4. [The flow in one picture](#4-the-flow-in-one-picture)
5. [SDK snippets](#5-sdk-snippets)
6. [Rules that save you a day](#6-rules-that-save-you-a-day)
7. [Map of the code](#7-map-of-the-code)
8. [How a run goes through the code](#8-how-a-run-goes-through-the-code)
9. [Words and codes used in the comments](#9-words-and-codes-used-in-the-comments)
10. [Testing your integration without sensors](#10-testing-your-integration-without-sensors)
11. [Data protection](#11-data-protection)

---

## 1. How it fits together

```
   THE USER'S COMPUTER
   ───────────────────────────────────────────────────────────────────────────
   ┌──────────────────────────┐   HTTP + WebSocket    ┌────────────────────────┐
   │ Your program             │  ───────────────────▶ │ Kinvent Companion app  │
   │ (this sample, a web app, │     127.0.0.1 only    │                        │
   │  a desktop tool…)        │  ◀─────────────────── │ owns the Bluetooth     │
   │                          │   events + samples    │ radio; connects,       │
   │ @kinvent/companion-sdk   │                       │ configures and zeroes  │
   └──────────────────────────┘                       │ the sensors            │
                                                      └───────────┬────────────┘
                                                                  │ Bluetooth LE
                                                      ┌───────────▼────────────┐
                                                      │ Kinvent sensors        │
                                                      └────────────────────────┘
```

- **Your program never talks to Bluetooth.** The companion does. Sensors behave as they do in the Kinvent
  mobile app (connection, rates, zero, jump protocol).
- **Everything is local.** The SDK only talks to `127.0.0.1`, ports 8477 to 8481. Nothing goes to the internet.
- **One client holds the sensors at a time** (the *session*). A Kinvent web app tab open in a browser counts as
  a client. The SDK keeps the session alive by polling; after 5 seconds without a poll the companion frees it.
- **The sample uses only the SDK's documented API.** Every file under `src/` and `testing/` imports nothing but
  `@kinvent/companion-sdk`, Node.js and `rxjs`. So what you see here is exactly what your own program can do.

## 2. Requirements

- **Node.js 22 or later** (the SDK uses the global `fetch` and `WebSocket`). In a browser, any current browser.
- **The Kinvent Companion app, the SAME version as the SDK** (`major.minor.patch`). This sample uses
  `@kinvent/companion-sdk` at the exact version written in `package.json`; install the Kinvent Companion app of
  that same version. A different version is refused (error E2, `compatibility().state !== 'match'`).
- **`rxjs` 7.** The SDK hands you RxJS observables.
- **A token issued by Kinvent.** You cannot install the SDK without it. `@kinvent/companion-sdk` is not on the
  public npm registry: it is published on GitHub Packages (`https://npm.pkg.github.com`), scope `@kinvent`, and
  only accounts Kinvent grants can read it. Kinvent gives your organisation read access and a GitHub token with
  the `read:packages` scope. The token is a secret: keep it out of files, tickets, chats and git. This project
  itself is public; the SDK is not.

### Install the SDK from the private registry

The project has an `.npmrc` file with two lines:

```
@kinvent:registry=https://npm.pkg.github.com
//npm.pkg.github.com/:_authToken=${NODE_AUTH_TOKEN}
```

The first line sends every `@kinvent/…` package to GitHub Packages. The second line reads the token from the
environment variable `NODE_AUTH_TOKEN` when npm runs: the file holds the NAME of the variable, never the token.
Set the variable in your shell, then install:

```bash
# macOS / Linux
export NODE_AUTH_TOKEN=<the token Kinvent gave you>
npm install
```

```powershell
# Windows PowerShell
$env:NODE_AUTH_TOKEN = "<the token Kinvent gave you>"
npm install
```

In CI, store the token as a secret of the CI system and expose it as `NODE_AUTH_TOKEN`. If `npm install` answers
`401` or `404` for `@kinvent/companion-sdk`, the token is missing, expired, or has no access to the package: ask
Kinvent.

The package is ESM only, and everything is imported from its root:

```ts
import {CompanionClient, CompanionError, DeviceState, DeviceType} from '@kinvent/companion-sdk';
```

## 3. Try it in five minutes

In the folder of this project. On Windows PowerShell, run each line as it is.

```bash
npm install          # needs NODE_AUTH_TOKEN, see section 2
npm run build
```

The first `npm install` creates `package-lock.json`. Commit it in your copy of this project, so every later install
gets the same versions (this public project ships without one, because creating it needs access to the SDK).

Start the installed Kinvent Companion app (the same version as the SDK).

**The quickstart** — about 100 lines, one sensor, live values on the screen, no file:

```bash
npm run build:examples
node dist-examples/quickstart.js GRIP 5
```

**The full sample** — asks for the device, records to a CSV file:

```bash
npm start
```

No sensor at hand? Run the tests: they drive the whole program against a fake companion (section 10).

## 4. The flow in one picture

Every integration follows the same steps. The right column names the SDK call; section 5 shows each one.

```
 1  find the companion            client.discover()
 2  check the version             client.compatibility()             → 'match' or stop
 3  claim the session             client.session.claim()             (subscribe to sessionLost$ first)
 4  keep the devices alive        client.ping() every 10 s
 5  (optional) set the rate       client.frequencySettings() / setFrequencySetting()   BEFORE step 6
 6  prepare the activity          client.prepareActivity({deviceTypes, …})
 7  wait until ready              client.activityReady$  then  client.devices()
 8  (floor devices) zero again    client.rezero(id)  →  'device.baseline' event
 9  read names and units          client.streamDescriptors()
10  subscribe to samples          client.sampleBatches$(id)          BEFORE step 11
11  start                         client.measureStart(firstId)       ONE call starts every device
12  stop                          client.measureStop(id)             ONE call PER device
13  clean up                      client.stopActivity(), then client.session.release()
```

## 5. SDK snippets

Every snippet here is also in [`examples/snippets.ts`](./examples/snippets.ts), and `npm run typecheck`
compiles it against the SDK, so they stay correct. They are short on purpose. The sample's own code (section 7)
adds what a real tool needs: messages, timeouts, Ctrl-C, retries.

### 5.1 Install and import

```ts
import {filter, firstValueFrom, timeout} from 'rxjs';
import {
    CompanionClient, CompanionError, DeviceState, DeviceType, ExerciseType, streamLayoutOf,
    type ActivityConfiguration, type BaselineErrorCode, type DeviceSnapshot, type ForceSample,
    type FrequencyFamily, type RegisteredDevice, type StreamField,
} from '@kinvent/companion-sdk';
```

Everything (enums, DTOs, helpers) is exported from the package root. Do not import any
`@kinvent/companion-sdk/...` sub-path: it does not resolve.

### 5.2 Connect: find, check the version, claim

```ts
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
```

- `discover()` returns `undefined` when nothing answers; it does not throw. `compatibility()` and `health()`
  **do** throw (`CompanionError`, `status: 0`) when nothing answers.
- **A refused claim does not throw.** It is reported on `sessionLost$` as `'refused'`. That is why the
  subscription comes first. In the sample: `CompanionLink.connect()` in `src/companion.ts`.
- If the previous session is still closing, the companion answers `503` and the SDK keeps asking; the sample
  waits up to 2 s for `client.session.id` to appear (same function).
- **Create one `CompanionClient` per program.** Two clients are two competitors for the same sensors.

### 5.3 Keep-alive

```ts
const timer = setInterval(() => void client.ping().catch(() => undefined), 10_000);
// … and clearInterval(timer) when you are done.
```

The SDK's poll keeps the **session** alive. `ping()` keeps the **sensors** awake while nothing is measured
(for example during your own setup screens). The cadence is yours; the sample uses 10 s
(`CompanionLink.startKeepAlive()`).

### 5.4 Prepare one sensor and wait until it is ready

```ts
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
```

- `prepareActivity` answers at once. The companion then scans, connects, configures and **zeroes** the sensor
  in the background. Progress arrives on `devices$` (`FOUND`, `CONNECTING`, `CONNECTED`, `INITIALIZING`,
  `READY`) and `events$` (`scan.discovery` for each Kinvent sensor heard).
- **Readiness is a level, not an event.** Use `activityReady$` (or `activityState$`), never the
  `activity.ready` event: the event can be dropped, the level comes with every poll.
- `activityState$` also says `'failed'`, with `failure.step` and `failure.reason`. Watch it while you wait.
- `adapterState$` says `'poweredOff'`, `'unauthorized'` or `'unsupported'` when the companion's radio is not
  usable. `'unsupported'` on Windows usually means the Bluetooth stack was reset: restart the companion.
- `exerciseType` is left out on purpose: absent means `UNKNOWN`. Only `JUMP_ANALYSIS` changes what a device does
  (section 5.11).
- In the sample: `CompanionLink.prepareAndWait()`, which also prints each state change, lists the sensors seen
  and builds a clear timeout message.

### 5.5 A pair: K-Plates, K-Deltas, K-Deltas 3D

```ts
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
```

And what to keep after a good run, to send as `registered` next time:

```ts
return devices
    .filter((d) => d.deviceType === type && d.name !== '')
    .map((d, k) => ({deviceId: d.id, deviceName: d.name, deviceType: type, connectionOrder: k + 1}));
```

- **One request type, two sensors.** `deviceTypes: ['PLATES']` is expanded by the companion to the left and the
  right plate. The plan it made is in `activityState$` → `plan.deviceTypes`.
- **Remembered sensors go first** (the mobile app's "registered devices"). Without them, the companion takes the
  first compatible sensors its scan hears, which is a problem when several pairs are switched on.
- **`registered.failed`**: a remembered sensor did not answer and the companion stops there. The sample then
  stops the activity, drops that sensor from the list and prepares again (`CompanionLink.prepareMatching()`;
  storage in `src/registry.ts`).
- **A 3D Delta may fill a K-Deltas slot.** This is the mobile app's behaviour and it is kept on purpose. Each
  device keeps its own channels and rate; read `deviceType` per device.

### 5.6 Names and units of the values

```ts
const described = (await client.streamDescriptors()).find((entry) => entry.deviceId === device.id)?.fields;
if (described !== undefined && described.length > 0) return described;
const layout = streamLayoutOf(device.deviceType, device.configuration ?? {});
if (layout === undefined) throw new Error(`No layout for a ${device.deviceType}.`);
return layout.fields; // each field: {index, name, unit}; read a value as sample.channels[field.index]
```

**Never hard-code what `channels[2]` means.** It depends on the device, its firmware and the protocol in force
(a K-Deltas on a jump test sends one value, `forceTotal`). The stream descriptor (`GET /streams`) says it; the
SDK's `streamLayoutOf()` gives the same answer without a round trip. Positions are not always contiguous:
a slot that carries no reading is not listed. In the sample: `src/units/source.ts`, the only file that knows
field positions.

### 5.7 Record

```ts
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
```

- **Subscribe before `measureStart`.** The first frame can arrive before the HTTP answer of the start.
- **`measureStart` once, `measureStop` per device.** One start starts
  every device of the activity; a second start is accepted and does nothing.
- `samples$(id)` gives one sample at a time; `sampleBatches$(id)` gives one frame (a batch) at a time, which is
  cheaper and keeps frame boundaries. The sample uses batches.
- A `ForceSample` is `{timeStamp, isTimeStampFromEpoch, channels}`. `timeStamp` is in milliseconds. It is a
  **mutable** object: if you keep samples from `samples$`, store `cloneForceSample(sample)`.
- The streams **complete** when a device's socket ends for good. No transport failure is ever an RxJS `error`.
- In the sample: `measure()` in `src/measure.ts` (with a countdown, a live view, early ends and the file).

### 5.8 Losses and disconnections

```ts
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
```

- `device.samplesLost` counts **frames** the companion knows were lost (by sequence number), not samples.
- `stream.gap` is the SDK's own count of frames missing on the socket.
- On a lost session the SDK closes every socket and reports every device disconnected **before**
  `sessionLost$` emits. Decide "device lost" a moment later, so a session loss wins (see the header of
  `src/measure.ts`).
- Also watched by the sample: `device.samplingInterrupted` (no data for a while) and a `device.state` of
  `DISCONNECTING`, `DISCONNECTED` or `ERROR`.

### 5.9 Sampling rate

```ts
const settings = await client.frequencySettings();
const entry = settings.families.find((f) => f.family === family);
if (entry === undefined) throw new Error(`No rate setting for ${family}.`);
const offered = [...entry.options, ...(settings.ble5Available ? entry.ble5OnlyOptions : [])].map((o) => o.rate);
if (!offered.includes(rate)) throw new Error(`${rate} Hz is not offered: ${offered.join(', ')} Hz.`);
if (entry.current.rate === rate) return; // ONLY when it differs: every accepted change disconnects every sensor
await client.setFrequencySetting({family, rate});
```

- Rates are set per **family**, not per device: `gripMuscleLink` (K-Grip, K-Push, K-Pull), `bubble`, `plates`,
  `deltas`, `deltas3d`, the two K-Deltas jump families `deltasMiniBallistic` and `deltasXlBallistic`, and others.
- **Set it before `prepareActivity`, and only when it differs.** Every accepted change disconnects every sensor
  and ends a prepared activity. The lists offered are the mobile app's.
- Some rates need Bluetooth 5 on the computer (`ble5OnlyOptions`, `ble5Available`).
- Nothing is saved: the defaults come back when the session ends.
- The rate the device really uses is in `device.configuration.samplingFrequency`. Some V2 firmware sends at a
  different rate than it reports; compare with the measured rate.
- In the sample: `decideRate()` and `CompanionLink.applyRate()` in `src/companion.ts`.

> Changing the sampling rate changes the measurement path of a medical device. It needs QA/regulatory sign-off
> before release.

### 5.10 Zero (calibrate) a floor device

```ts
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
```

- The companion zeroes K-Plates, K-Deltas and K-Deltas 3D **while they connect**. A load on them at that moment
  is zeroed away, and every value after is wrong by that load. Tell the user to keep off them.
- The companion may reuse a sensor's earlier zero on a later connection. `rezero(id)` takes a fresh one (the mobile
  app's "Recalibrate").
- The `device.baseline` event has no `error` on success. Errors: `CHANNEL_ABOVE_15` or
  `SUM_CHANNELS_ABOVE_THRESHOLD` (a load), `STD_ABOVE_1` (movement), `NEGATIVE_VALUES`. Only firmware with
  `configuration.capabilities.baselineErrorCheck` reports them. **3D Deltas never do.**
- Streamed values are relative to the zero, so "0 kg" does not prove that nothing is on the device. The sample
  waits until the total force is **still** (within 1 kg for 1 s) before it zeroes: see
  `CompanionLink.calibrateFloorDevices()` and `waitUntilStill()`.

### 5.11 Jump test

```ts
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
```

The layout changes when the measurement starts, so subscribe **before** `measureStart`:

```ts
const subscription = client.events$.subscribe((event) => {
    if (event.type !== 'stream.layout') return;
    const fields = event.configuration.stream?.fields;
    if (fields !== undefined) onFields(event.deviceId, fields); // a K-Deltas: one field, forceTotal
});
```

| Device | What `JUMP_ANALYSIS` does |
|---|---|
| K-Deltas (`HEXAS`) | From `measureStart`: **one** value, `forceTotal`, at the jump rate (500, 1000, 2000 Hz; 4000 Hz on the K-Deltas XL only). |
| K-Plates (`PLATES`) | A V3 plate keeps its four values and its rate. |
| K-Deltas 3D (`DELTAS_3D`) | Nothing changes: nine values, the 3D rate. This is the mobile app's behaviour. |

- **Which ballistic family a K-Deltas uses** depends on its variant (`configuration.deltasVariant`), known only
  once it is ready. That is after the prepare, when a rate change would disconnect it. So set **both** families
  before the prepare.
- **Zero a K-Deltas jump test first.** Zero while the activity is still a normal one: a zero asked for after
  the jump test has started fails on an empty sensor. The sample prepares a normal activity, zeroes, then prepares again as the jump test; the companion keeps the sensors and
  the zero (`CompanionLink.restartActivity()`, called from `src/run.ts`).
- Write a file's header only once the layout is final: the sample's `Recorder` waits for it
  (`settleLayout` in `src/recorder.ts`).

### 5.12 Clean exit

```ts
stopKeepAlive();
if (client.session.id !== undefined) await client.stopActivity().catch(() => undefined);
await client.session.release(); // never throws; never POST /reset
```

Give back what you took, in reverse order: stop the measurement, stop the activity, stop the keep-alive,
release the session. Do it on success, on error and on Ctrl-C. The sample registers each step with a
`Teardown` **before** the call that needs it, so every exit path runs it exactly once (`src/exit.ts`). In a
browser, call `release()` on `pagehide` without awaiting it.

### 5.13 Errors

```ts
if (!(error instanceof CompanionError)) return String(error);
if (error.status === 0) return 'No answer from the companion. Is it running?';
if (error.code === 'VERSION_MISMATCH') return 'The companion and the SDK versions differ.';
if (error.status === 409) return 'Another app holds the sensors, or the session ended.';
if (error.code === 'STATE') return `Not now: the companion is ${error.state ?? 'busy'} (${error.command ?? error.path}).`;
if (error.code === 'INVALID_CONFIGURATION') return `Invalid request field: ${error.reason ?? '?'}.`;
return `${error.path}: ${error.reason ?? error.message}`;
```

Every failed command throws one `CompanionError`: `status` (0 = no answer at all), `path`, and, when the
companion said it, `code`, `reason`, `state` and `command`. Nothing is swallowed. The messages the sample shows
for each case, and what the user should do, are in [`GUIDE.md`](./GUIDE.md) section 12.

## 6. Rules that save you a day

1. **Subscribe before you act.** To `sessionLost$` before `claim()`; to `sampleBatches$` before
   `measureStart`; to `events$` before `rezero()`; to `stream.layout` before a jump test starts. `events$` is
   hot: what happened before you subscribed is gone. `devices$`, `activityState$`, `activityReady$` and
   `adapterState$` replay their last value.
2. **Readiness is a level.** `activityReady$`, not the `activity.ready` event.
3. **`devices$` can lag `activityReady$` by one poll.** When they disagree, ask `client.devices()`
   (`CompanionLink.pickDevices()`).
4. **One `measureStart`, one `measureStop` per device.**
5. **Change the rate only when it differs, and before the prepare.** Each change reconnects every sensor.
6. **Keep floor devices free of load while they connect and while they zero.**
7. **Read field names and units from the descriptor.** No table of channel meanings in your code.
8. **After `stopActivity()`, wait until `activityReady$` is `false`** before you prepare again, or you pick up
   the devices of the stopped activity (`CompanionLink.stopAndSettle()`).
9. **Always release the session**, also on errors. Never call the companion's `POST /reset`: it is not
   scoped to your session.
10. **Windows: an `adapterState` of `'unsupported'`** means the companion lost its radio (often a Bluetooth
    stack reset). Only a restart of the companion brings it back. Fail fast and say so.
11. **One client holds the sensors.** A browser tab with the Kinvent web app open will block your program.

## 7. Map of the code

The sample is plain TypeScript compiled 1:1 by `tsc` (no bundler), so `dist/` mirrors `src/`.

| File | What it does | SDK calls | Copy it? |
|---|---|---|---|
| [`examples/quickstart.ts`](./examples/quickstart.ts) | The smallest complete program. | all the basic ones | **Yes, start here.** |
| [`examples/snippets.ts`](./examples/snippets.ts) | Section 5's snippets, compiled. | all | Yes |
| [`src/cli.ts`](./src/cli.ts) | Entry point: builds the environment from `process`, opens the log, runs `runCli`. | — | No (program plumbing) |
| [`src/run.ts`](./src/run.ts) | **The whole flow, top to bottom** (section 8). Read it as the table of contents. | `new CompanionClient` | The order, yes |
| [`src/companion.ts`](./src/companion.ts) | `CompanionLink`: connect, rates, keep-alive, prepare and wait, pairs, zero, restart. **The SDK integration.** | `discover`, `compatibility`, `session.claim`, `frequencySettings`, `setFrequencySetting`, `ping`, `prepareActivity`, `devices`, `devices$`, `events$`, `activityState$`, `activityReady$`, `adapterState$`, `rezero`, `measureStart/Stop`, `sampleBatches$`, `stopActivity` | **Yes** |
| [`src/measure.ts`](./src/measure.ts) | The recording: subscribe, countdown, start, live values, stop, early ends. | `sampleBatches$`, `events$`, `sessionLost$`, `measureStart`, `measureStop`, `devices` | **Yes** |
| [`src/units/source.ts`](./src/units/source.ts) | Field names and units: descriptor, else `streamLayoutOf`. Jump layout changes. | `streamDescriptors`, `streamLayoutOf`, `events$` (`stream.layout`) | **Yes** |
| [`src/recorder.ts`](./src/recorder.ts) | The CSV file (the mobile app's export layout), pairs joined by row index, the Summary. | — | If you write CSV |
| [`src/registry.ts`](./src/registry.ts) | Remembers the last pair per device type, for `registered`. | — (types only) | If you record pairs |
| [`src/exit.ts`](./src/exit.ts) | Exit codes, the one-shot `Teardown`, Ctrl-C and SIGTERM. | — | The `Teardown` idea, yes |
| [`src/timer.ts`](./src/timer.ts) | An injectable clock, the run timer, the measured rate. | — | Optional |
| [`src/render.ts`](./src/render.ts) | The live view on the terminal. | — | No (terminal UI) |
| [`src/countdown.ts`](./src/countdown.ts) | 3-2-1 before the start. | — | No |
| [`src/prompts.ts`](./src/prompts.ts) | The questions (device, single or pair, jump, seconds, rate). | — | No |
| [`src/args.ts`](./src/args.ts) | Command-line flags. | — | No |
| [`src/cliLog.ts`](./src/cliLog.ts) | A daily log of the messages (never the live values), for support. | — | No |
| [`testing/doubles/fakeCompanion.ts`](./testing/doubles/fakeCompanion.ts) | A fake companion behind the SDK's `fetchImpl`/`webSocketImpl`. | — | **Yes, for your tests** (section 10) |

## 8. How a run goes through the code

`runCli()` in [`src/run.ts`](./src/run.ts), in order. Each step names the function that does it.

| # | Step | Where |
|---|---|---|
| 1 | Banner, Node 22 check, flags | `runCli`, `parseCliArgs` (`args.ts`) |
| 2 | Questions: device, single or pair, jump, seconds | `askDeviceType`, `askSingle`, `askJump`, `askSeconds` (`prompts.ts`) |
| 3 | Create the client | `new CompanionClient(...)` in `runCli` |
| 4 | Find, check the version, claim | `CompanionLink.connect` |
| 5 | Floor devices: ask the rate from the offered list | `offeredRates` / `offeredJumpRates`, `askRate` |
| 6 | Set the rate (or both jump families) if it differs | `applyRate` / `applyJumpRates` |
| 7 | Keep-alive | `startKeepAlive` |
| 8 | Prepare and wait for every planned device | `prepareMatching` (pairs, remembered sensors) → `prepareAndWait` |
| 9 | Floor devices: report a bad zero, wait until still, zero again | `describeZeros`, `calibrateFloorDevices` |
| 10 | K-Deltas jump test: prepare again as the jump test | `restartActivity` |
| 11 | Field names and units, set rate per device | `fieldsForEach` (`units/source.ts`), `setRateOf` (`measure.ts`) |
| 12 | Size estimate, "you can step on now" | `confirmSize` |
| 13 | Subscribe, countdown, open the file, start, record, stop | `measure` (`measure.ts`), `Recorder` (`recorder.ts`) |
| 14 | Summary line, file path | `summaryLine`, `reportFile` |
| 15 | Clean up (always) | `Teardown.run` (`exit.ts`): stop measuring → close file → stop activity → stop keep-alive → release session |

## 9. Words and codes used in the comments

The comments use a few short codes. Here is what they mean.

| Code | Meaning |
|---|---|
| **E1 … E11** | The error cases and their messages (E1: no companion, E2: version, E3: session held, E4: prepare failed, E5: timeout, E6: device lost, E7: session lost, E8: write error, E9: Ctrl-C, E10: bad flag, E11: no field layout). Full table: [`GUIDE.md`](./GUIDE.md) section 12. |
| **"the mobile app"** | Kinvent's mobile app. Sensors behave through the companion as they do there, so the sample follows its rules (zero, pairs, jump, rates). |
| **"floor devices"** | K-Plates, K-Deltas and K-Deltas 3D: devices you stand on or load from the floor, zeroed before use. |
| **"the host"** | The part of the Kinvent Companion app that plans an activity and reports its state (`activityState$`). |
| **"README.md section N", "GUIDE.md section N"** | A section of this file or of the user guide. |

## 10. Testing your integration without sensors

**A fake companion inside your tests.** `CompanionClient` accepts `fetchImpl` and `webSocketImpl`. The sample's
[`testing/doubles/fakeCompanion.ts`](./testing/doubles/fakeCompanion.ts) answers the routes, emits events and
sends sample frames (`encodeSampleFrame` from the SDK), with options for failures: refused sessions, lost
devices, failed zeros, a dead radio, a missing remembered sensor. It needs no Bluetooth, no sensor and no
companion app. Every value it sends is synthetic.

```bash
npm test             # builds the tests, then runs them (about one minute)
```

The suite runs the whole program (`runCli`) against the fake: one sensor, a pair, a jump test, every error case,
and the CSV file byte for byte (`testing/tests/record.test.ts`, `pair.test.ts`, `jump.test.ts`, `connect.test.ts`).
Copy `fakeCompanion.ts` as a model for the tests of your own program.

On Windows, a few tests of the sample fail because they expect POSIX paths and file modes; they pass on macOS
and Linux.

## 11. Data protection

- A force recording of a person is **health data** (special-category personal data under GDPR).
- **Never send a name, a patient id or any personal detail to the companion.** `activityCode` is a correlation
  id; the sample uses the fixed value `cli-sample`.
- Keep recordings on the computer, readable by the user only (the sample creates files with mode `0600`), and
  out of tickets, chats, e-mails and git (`recordings/` and `*.csv` are in this project's `.gitignore`).
- Logs must not hold measurements: the sample's log (`src/cliLog.ts`) drops the live values.
- Sensor ids and Bluetooth names (`src/registry.ts`) identify hardware, but they can become personal data once
  linked to a person or a session. Treat them with care and never store them next to a person's details.
- For tests, use your own hand on a test sensor or the fake companion. Never real patient recordings.
- Any use with patients needs your data-protection officer's approval first.

More: [`GUIDE.md`](./GUIDE.md) section 13.
