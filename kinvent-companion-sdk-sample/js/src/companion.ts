/**
 * FOR INTEGRATORS: THIS IS THE SDK INTEGRATION; copy from here. Where each README.md snippet lives in full:
 *   5.2 connect ............ `CompanionLink.connect`
 *   5.3 keep-alive ......... `startKeepAlive`
 *   5.4 prepare one ........ `prepareAndWait` (also used for every pair, with `registered`)
 *   5.5 pairs .............. `prepareMatching`, `assignSlots`, `readyDevicesOfPlan` (and `registry.ts`)
 *   5.9 sampling rate ...... `offeredRatesOf`, `decideRate`, `applyRate`
 *   5.10 zero .............. `calibrateFloorDevices`, `waitUntilStill`, `zeroOnce`
 *   5.11 jump test ......... `offeredJumpRatesOf`, `decideJumpRates`, `applyJumpRates`, `restartActivity`
 * The top half ("pure rules") makes no call and is unit-tested on its own; the class `CompanionLink` makes the
 * calls. Every failure becomes a `CliExit`: an exit code and the sentence the user sees (`exit.ts`). Every wait
 * is `interruptible`, so Ctrl-C ends it at once and the teardown still runs.
 *
 * A thin wrapper over `CompanionClient` for the connect flow (steps 1 to 11):
 * find the companion, check the version, claim the session, optionally set the sampling rate, keep the
 * devices alive, prepare the activity for one device type and wait for that device to be ready.
 *
 * Every resource it acquires is registered with the {@link Teardown} BEFORE the call that acquires it
 * is sent, so that an error, a timeout or Ctrl-C at any point gives it back exactly once:
 *   release the session  <- registered before `claim()`
 *   stop the keep-alive  <- registered with the interval
 *   stop the activity    <- registered before `prepareActivity()`
 * The teardown runs them in reverse: activity, keep-alive, session.
 *
 * It uses only the public SDK. It sends NO `exerciseType` (absent means `UNKNOWN`),
 * EXCEPT for a jump test: then `prepareAndWait` sends `exerciseType: 'JUMP_ANALYSIS'`,
 * the only value that changes what the device does (`isBallisticExercise`). That line in `prepareAndWait` is
 * the ONLY place this sample ever sends an exercise type; every other run sends no `exerciseType` key at all.
 * Before a jump test, `applyJumpRates` sets the two ballistic K-Deltas rate families to the jump protocol.
 */
import type {Subscription} from 'rxjs';
import {
    BluetoothDeviceType,
    CompanionError,
    type BaselineErrorCode,
    DeltasVariantType,
    DeviceState,
    DeviceType,
    ExerciseType,
    getBluetoothDeviceName,
    getDeviceType,
    isDeviceCompatibleWith,
    platformSideOf,
    VERSION,
    type ActivityConfiguration,
    type CompanionClient,
    type DeviceSnapshot,
    type FrequencyFamily,
    type FrequencyFamilySettings,
    type FrequencySettingRequest,
    type FrequencySettingsSnapshot,
    type RegisteredDevice,
} from '@kinvent/companion-sdk';
import {CliExit, EXIT, Interrupted, interruptible, type Interrupts, type Teardown} from './exit.js';
import {isPairType, labelOf} from './prompts.js';
import {defaultRegistryPath, forgetDevices, readRegistered, rememberDevices} from './registry.js';

/** The fixed correlation id. It identifies no person and no computer. */
export const ACTIVITY_CODE = 'cli-sample';
/** The keep-alive cadence the SDK leaves to the caller (`CompanionClient.ping`, README section 5.3). */
export const KEEP_ALIVE_MS = 10_000;
/** E3b: how long to wait for a session while the companion answers 503 (previous session releasing). */
export const CLAIM_RETRY_MS = 2_000;
/** A remembered sensor the companion could not connect (`registered.failed`): the caller tries without it. */
class RegisteredFailed extends Error {
    constructor(readonly deviceId: string) {
        super(`registered device ${deviceId} failed to connect`);
    }
}
/** Floor devices: the wait between two calibrations while a load is detected. */
export const ZERO_RETRY_MS = 2_000;
/** Floor devices: how long to wait for the load to go before giving up. */
export const ZERO_EMPTY_TIMEOUT_MS = 120_000;
/** Floor devices: how long the total force must have stayed within {@link STILL_KG} before a zero is taken. */
export const STILL_WINDOW_MS = 1000;
/** Floor devices: the change of the total force that still counts as "nothing moving". */
export const STILL_KG = 1;
/** Floor devices: how long one calibration (its `device.baseline` result, then READY again) may take. */
export const ZERO_STEP_TIMEOUT_MS = 15_000;

export interface Ui {
    /** One line of progress for the user. */
    info(line: string): void;
}

export interface Where {
    host: string;
    /** `undefined`: the SDK walks the companion's port ladder. */
    port: number | undefined;
}

// ---------------------------------------------------------------------------
// pure rules
// ---------------------------------------------------------------------------

/** E1's sentence. */
export function noCompanionMessage(where: Where): string {
    const place = where.port === undefined ? `${where.host}:8477–8481` : `${where.host}:${where.port}`;
    return `No Kinvent Companion app found on ${place}. Start the Kinvent Companion app, or pass \`--port\`.`;
}

/** E2's sentence. */
export function versionMismatchMessage(installed: string, expected: string): string {
    return `Companion is ${installed === '' ? 'of an unknown version' : installed}, this sample is built for ${expected}. Use matching versions.`;
}

/**
 * The companion's radio is gone for good: the adapter state is `unsupported`, for example after Windows
 * re-initialises its Bluetooth stack, and only a restart of the companion brings the radio back. Waiting for a sensor would waste the whole connect timeout.
 */
export const RADIO_UNSUPPORTED_MESSAGE =
    "The Kinvent Companion app's Bluetooth radio is not usable (adapter state: unsupported). Restart the Kinvent Companion app and run again.";

/** E3's sentence. The SDK reports only that the session was refused, not which client holds it. */
export const SESSION_HELD_MESSAGE =
    'Another app is using the sensors (for example the Kinvent web app in a browser tab). Close it, wait 5 seconds, and run again.';

/** The rate family of each offered type (the SDK's `FrequencyFamily`). */
const FAMILY: Partial<Record<DeviceType, FrequencyFamily>> = {
    GRIP: 'gripMuscleLink',
    MUSCLE_TESTER: 'gripMuscleLink',
    LINK: 'gripMuscleLink',
    PLATES: 'plates',
    HEXAS: 'deltas',
    DELTAS_3D: 'deltas3d',
    BUBBLE: 'bubble',
    EMG: 'emg',
};

export function familyOf(type: DeviceType): FrequencyFamily | undefined {
    return FAMILY[type];
}

/**
 * The BALLISTIC rate family of a device (the families a jump analysis uses), or
 * `undefined` when it has none or its variant is not known. Only K-Deltas have one; which one depends on
 * the variant the device reported (`DeviceConfiguration.deltasVariant`): the companion gives the XL
 * ballistic rate to a `CLASSIC` and the mini ballistic rate to every other K-Deltas variant; the sample names only the
 * two variants it can be sure of, `CLASSIC` (K-Deltas XL) and `MINI` (K-Deltas). A 3D-Deltas has no
 * ballistic family (`deltas3d` only). Used for the jump test's rates.
 */
export function ballisticFamilyOf(device: Pick<DeviceSnapshot, 'deviceType' | 'configuration'>): FrequencyFamily | undefined {
    if (device.deviceType !== DeviceType.HEXAS) return undefined;
    switch (device.configuration?.deltasVariant) {
        case DeltasVariantType.CLASSIC:
            return 'deltasXlBallistic';
        case DeltasVariantType.MINI:
            return 'deltasMiniBallistic';
        default:
            return undefined;
    }
}

/**
 * The Bluetooth types the companion's host plans for a request, LEFT first. Only a FALLBACK: the companion's own plan, `activityState.plan.deviceTypes`, is read
 * first (`ActivityPlanSummary.deviceTypes`).
 */
const SLOTS: Partial<Record<DeviceType, readonly BluetoothDeviceType[]>> = {
    GRIP: [BluetoothDeviceType.KFORCE_GRIP],
    MUSCLE_TESTER: [BluetoothDeviceType.MUSCLE_CONTROLLER],
    LINK: [BluetoothDeviceType.LINK],
    PLATES: [BluetoothDeviceType.PLATES_LEFT, BluetoothDeviceType.PLATES_RIGHT],
    HEXAS: [BluetoothDeviceType.HEXAS_LEFT, BluetoothDeviceType.HEXAS_RIGHT],
    DELTAS_3D: [BluetoothDeviceType.DELTAS_3D_LEFT, BluetoothDeviceType.DELTAS_3D_RIGHT],
    BUBBLE: [BluetoothDeviceType.BUBBLE],
    EMG: [BluetoothDeviceType.EMG],
};

/** The planned slots when the companion did not say: the pair, or its LEFT sensor alone with `--single`. */
export function expectedSlots(type: DeviceType, single: boolean): BluetoothDeviceType[] {
    const slots = [...(SLOTS[type] ?? [])];
    return single && slots.length === 2 ? [slots[0]!] : slots;
}

/**
 * Whether `device` fills the planned `slot`: the same Bluetooth type, or a compatible type on the same side
 * (a 3D-Deltas fills a K-Deltas slot).
 */
export function fillsSlot(slot: BluetoothDeviceType, device: Pick<DeviceSnapshot, 'bluetoothDeviceType' | 'deviceType' | 'side'>): boolean {
    if (device.bluetoothDeviceType === slot) return true;
    return (device.side ?? null) === platformSideOf(slot) && isDeviceCompatibleWith(getDeviceType(slot), device.deviceType);
}

/** Each slot's device among `devices` that passes `accept`, in slot order; a device fills one slot at most. */
export function assignSlots(
    slots: readonly BluetoothDeviceType[],
    devices: readonly DeviceSnapshot[],
    accept: (device: DeviceSnapshot) => boolean,
): Array<DeviceSnapshot | undefined> {
    const used = new Set<string>();
    return slots.map((slot) => {
        const device = devices.find((candidate) => !used.has(candidate.id) && accept(candidate) && fillsSlot(slot, candidate));
        if (device !== undefined) used.add(device.id);
        return device;
    });
}

const isReadyInUse = (device: DeviceSnapshot): boolean => device.inUse && device.state === DeviceState.READY;
const CONNECTED_STATES: ReadonlySet<string> = new Set([DeviceState.CONNECTED, DeviceState.INITIALIZING, DeviceState.READY]);
const isConnectedInUse = (device: DeviceSnapshot): boolean => device.inUse && CONNECTED_STATES.has(device.state);

/** Every planned device, READY and in use, in plan order (LEFT then RIGHT); `undefined` while one is missing. */
export function readyDevicesOfPlan(slots: readonly BluetoothDeviceType[], devices: readonly DeviceSnapshot[]): DeviceSnapshot[] | undefined {
    if (slots.length === 0) return undefined;
    const assigned = assignSlots(slots, devices, isReadyInUse);
    return assigned.every((device) => device !== undefined) ? (assigned as DeviceSnapshot[]) : undefined;
}

/** The name of one sensor on screen: its Bluetooth name when it has a side ("K-Plate Left"), else the product label. */
export function deviceName(device: Pick<DeviceSnapshot, 'bluetoothDeviceType' | 'deviceType' | 'side'>): string {
    return device.side === null || device.side === undefined ? labelOf(device.deviceType) : getBluetoothDeviceName(device.bluetoothDeviceType);
}

/** "A", "A and B", "A, B and C". */
function joinNames(names: readonly string[]): string {
    return names.length <= 1 ? (names[0] ?? '') : `${names.slice(0, -1).join(', ')} and ${names.at(-1)!}`;
}

/** What the user is asked to switch on: the label for one sensor, the slot names for a pair or `--single`. */
export function switchOnText(type: DeviceType, slots: readonly BluetoothDeviceType[]): string {
    return isPairType(type) ? joinNames(slots.map((slot) => getBluetoothDeviceName(slot))) : labelOf(type);
}

/**
 * E5's sentence: for a pair it names what connected and what is missing
 * ("K-Plate Left connected; waiting for K-Plate Right."). One sensor: the one-sensor sentence.
 */
export function timeoutMessage(input: {
    type: DeviceType;
    slots: readonly BluetoothDeviceType[];
    devices: readonly DeviceSnapshot[];
    seconds: number;
    seen: ReadonlyMap<string, BluetoothDeviceType>;
    single: boolean;
}): string {
    const {type, slots, devices, seconds, seen, single} = input;
    const label = labelOf(type);
    const lines: string[] = [];
    if (!isPairType(type)) {
        lines.push(`No ${label} connected in ${seconds} s. Is it switched on and charged? Is it a ${label}? Is another app connected to it?`);
    } else {
        const connected = assignSlots(slots, devices, isConnectedInUse);
        const have = slots.filter((_, i) => connected[i] !== undefined).map((slot) => getBluetoothDeviceName(slot));
        const missingSlots = slots.filter((_, i) => connected[i] === undefined);
        const missing = joinNames(missingSlots.map((slot) => getBluetoothDeviceName(slot)));
        if (have.length === 0) {
            lines.push(
                `No ${label} connected in ${seconds} s (waiting for ${missing}). Is it switched on and charged? Is it a ${label}? Is another app connected to it?`,
            );
        } else {
            lines.push(`${joinNames(have)} connected; waiting for ${missing}.`);
            lines.push(`No ${missing} connected in ${seconds} s. Is it switched on and charged? Is another app connected to it?`);
            // `--single` keeps the LEFT sensor only (`isMonopodal`), so it helps only when the left one is there.
            if (!single && missingSlots.every((slot) => platformSideOf(slot) === 'RIGHT')) {
                lines.push(`To record the ${have.join(', ')} alone, run again with --single.`);
            }
        }
    }
    if (seen.size > 0) lines.push(`Seen nearby: ${seenSummary(seen)}.`);
    if (single && isPairType(type) && [...seen.values()].some((bt) => platformSideOf(bt) === 'RIGHT' && isDeviceCompatibleWith(type, getDeviceType(bt)))) {
        lines.push(`With --single only the left sensor (${joinNames(slots.map((slot) => getBluetoothDeviceName(slot)))}) can be used.`);
    }
    return lines.join('\n');
}

/** The plain rates of `type`'s family, plus the Bluetooth-5-only ones when this machine has Bluetooth 5, sorted. */
export function offeredRatesOf(snapshot: FrequencySettingsSnapshot, type: DeviceType): {rates: number[]; current: number} | undefined {
    const family = familyOf(type);
    const settings = family === undefined ? undefined : snapshot.families.find((entry) => entry.family === family);
    if (settings === undefined) return undefined;
    const rates = [
        ...new Set([...settings.options, ...(snapshot.ble5Available ? settings.ble5OnlyOptions : [])].map((option) => option.rate)),
    ].sort((a, b) => a - b);
    return {rates, current: settings.current.rate};
}

export interface OfferedJumpRates {
    rates: number[];
    /** The rate every ballistic family already jumps at, when they agree; otherwise there is no one rate to keep. */
    current: number | undefined;
    /** For a rate only some families offer: which ones. */
    notes: Map<number, string>;
}

/** See `CompanionLink.offeredJumpRates`. */
export function offeredJumpRatesOf(snapshot: FrequencySettingsSnapshot): OfferedJumpRates {
    const families = BALLISTIC_FAMILIES.map((family) => snapshot.families.find((entry) => entry.family === family)).filter(
        (entry): entry is FrequencyFamilySettings => entry !== undefined,
    );
    const perFamily = families.map((settings) => ({settings, rates: jumpRatesOf(settings, snapshot.ble5Available)}));
    const rates = [...new Set(perFamily.flatMap((entry) => entry.rates))].sort((a, b) => a - b);
    const notes = new Map<number, string>();
    for (const rate of rates) {
        const offering = perFamily.filter((entry) => entry.rates.includes(rate));
        if (offering.length < perFamily.length) {
            notes.set(rate, `${offering.map((entry) => ballisticFamilyLabel(entry.settings.family)).join(', ')} only`);
        }
    }
    const currents = new Set(perFamily.map((entry) => (entry.settings.current.mode === JUMP_PROTOCOL_MODE ? entry.settings.current.rate : undefined)));
    const only = currents.size === 1 ? [...currents][0] : undefined;
    return {rates, current: only !== undefined && rates.includes(only) ? only : undefined, notes};
}

export type RateDecision =
    | {kind: 'keep'; rate: number}
    | {kind: 'set'; request: FrequencySettingRequest}
    | {kind: 'refuse'; message: string};

/**
 * Change the rate ONLY when it differs from `current`, because every
 * accepted change disconnects every sensor; refuse, before any call, a rate that is not offered or that
 * needs Bluetooth 5 on a machine without it.
 */
export function decideRate(snapshot: FrequencySettingsSnapshot, type: DeviceType, wanted: number): RateDecision {
    const label = labelOf(type);
    const family = familyOf(type);
    const settings = family === undefined ? undefined : snapshot.families.find((entry) => entry.family === family);
    if (settings === undefined) {
        return {kind: 'refuse', message: `--rate: the companion offers no sampling-rate setting for the ${label}.`};
    }
    if (settings.current.rate === wanted) return {kind: 'keep', rate: wanted};

    const plain = settings.options.map((option) => option.rate);
    const ble5Only = settings.ble5OnlyOptions.map((option) => option.rate);
    const valid = [...new Set([...plain, ...(snapshot.ble5Available ? ble5Only : [])])]
        .filter((rate) => !(ble5Only.includes(rate) && !snapshot.ble5Available))
        .sort((a, b) => a - b);
    const list = `Valid rates for the ${label}: ${valid.join(', ')} Hz.`;

    if (ble5Only.includes(wanted) && !snapshot.ble5Available) {
        return {kind: 'refuse', message: `--rate: ${wanted} Hz needs Bluetooth 5, which this computer does not have. ${list}`};
    }
    if (!plain.includes(wanted) && !ble5Only.includes(wanted)) {
        return {kind: 'refuse', message: `--rate: ${wanted} Hz is not offered. ${list}`};
    }
    return {kind: 'set', request: {family: settings.family, rate: wanted}};
}

// ---------------------------------------------------------------------------
// The jump rates
// ---------------------------------------------------------------------------

/**
 * The two ballistic K-Deltas rate families, in the order they are set. A jump test sets BOTH, because:
 *  - which one a K-Deltas uses depends on its variant (`DeviceConfiguration.deltasVariant`: `CLASSIC` = K-Deltas
 *    XL → `deltasXlBallistic`, `MINI` → `deltasMiniBallistic`; `ballisticFamilyOf`), and the variant is known
 *    only after the device is READY, i.e. after `prepareActivity`;
 *  - but every accepted `PUT /settings/frequencies` disconnects EVERY sensor and ends the activity, so nothing
 *    may be set after `prepareActivity`. Setting both before it covers either variant, and a pair of two
 *    different variants. The setting lasts for the session; nothing is restored.
 */
export const BALLISTIC_FAMILIES: readonly FrequencyFamily[] = ['deltasMiniBallistic', 'deltasXlBallistic'];

/** The jump-protocol mode of the ballistic families (`FrequencyMode`). */
const JUMP_PROTOCOL_MODE = 'jumpProtocol' as const;

/** How a ballistic family is named to the user. */
export function ballisticFamilyLabel(family: FrequencyFamily): string {
    return family === 'deltasXlBallistic' ? 'K-Deltas XL' : family === 'deltasMiniBallistic' ? 'K-Deltas' : family;
}

/** The rates a family offers in the jump-protocol mode on this machine (Bluetooth-5-only ones only with BLE 5). */
export function jumpRatesOf(settings: FrequencyFamilySettings, ble5Available: boolean): number[] {
    const options = [...settings.options, ...(ble5Available ? settings.ble5OnlyOptions : [])];
    return [...new Set(options.filter((option) => option.mode === JUMP_PROTOCOL_MODE).map((option) => option.rate))].sort((a, b) => a - b);
}

/** One ballistic family's jump setting: the request, and whether it must be sent (only when it differs). */
export interface JumpRatePlan {
    family: FrequencyFamily;
    rate: number;
    /** `true`: send the PUT. `false`: the family already has this rate in the jump-protocol mode. */
    send: boolean;
    /** Where the rate came from: `--rate`, or the family's current rate. */
    from: '--rate' | 'current';
}

export type JumpRateDecision = {kind: 'ok'; plans: JumpRatePlan[]; notes: string[]} | {kind: 'refuse'; message: string};

/**
 * The jump setting of BOTH ballistic families (see {@link BALLISTIC_FAMILIES}). Per family: `wanted`
 * (`--rate`) when that family offers it in the jump-protocol mode (4000 Hz only the K-Deltas XL), else the
 * family's current rate. Refused, before any call, when `wanted` is a jump rate of neither family, or when a
 * family's rate is not one of its jump rates. The PUT is skipped when the family already has that rate in the
 * jump-protocol mode (every accepted PUT disconnects every sensor).
 */
export function decideJumpRates(snapshot: FrequencySettingsSnapshot, wanted: number | undefined): JumpRateDecision {
    const families = BALLISTIC_FAMILIES.map((family) => ({family, settings: snapshot.families.find((entry) => entry.family === family)}));
    const missing = families.filter((entry) => entry.settings === undefined).map((entry) => entry.family);
    if (missing.length > 0) {
        return {kind: 'refuse', message: `--jump: the companion offers no jump-protocol rate setting (${missing.join(', ')}).`};
    }
    const offered = families.map(({family, settings}) => ({family, settings: settings!, rates: jumpRatesOf(settings!, snapshot.ble5Available)}));
    const list = offered.map((entry) => `${ballisticFamilyLabel(entry.family)} ${entry.rates.join(', ')} Hz`).join('; ');
    if (wanted !== undefined && !offered.some((entry) => entry.rates.includes(wanted))) {
        return {kind: 'refuse', message: `--rate: ${wanted} Hz is not a jump rate. Jump rates: ${list}.`};
    }
    const plans: JumpRatePlan[] = [];
    const notes: string[] = [];
    for (const {family, settings, rates} of offered) {
        const label = ballisticFamilyLabel(family);
        const useWanted = wanted !== undefined && rates.includes(wanted);
        const rate = useWanted ? wanted : settings.current.rate;
        if (!rates.includes(rate)) {
            return {
                kind: 'refuse',
                message: `--jump: the ${label} rate is ${rate} Hz, which is not a jump rate (${rates.join(', ')} Hz). Pass --rate with a jump rate.`,
            };
        }
        if (wanted !== undefined && !useWanted) {
            notes.push(`--rate ${wanted} Hz is offered on the ${offered.filter((entry) => entry.rates.includes(wanted)).map((entry) => ballisticFamilyLabel(entry.family)).join(', ')} only; a ${label} jumps at ${rate} Hz.`);
        }
        const send = !(settings.current.rate === rate && settings.current.mode === JUMP_PROTOCOL_MODE);
        plans.push({family, rate, send, from: useWanted ? '--rate' : 'current'});
    }
    return {kind: 'ok', plans, notes};
}

/** The device the host made ready for this plan, or `undefined`. */
export function readyDevice(devices: readonly DeviceSnapshot[]): DeviceSnapshot | undefined {
    return devices.find((device) => device.inUse && device.state === DeviceState.READY);
}

/** "1 × K-Push, 2 × K-Grip": the Kinvent sensors seen by the companion's scan, by product name. */
export function seenSummary(seen: ReadonlyMap<string, BluetoothDeviceType>): string {
    const counts = new Map<string, number>();
    for (const type of seen.values()) {
        const name = getBluetoothDeviceName(type);
        counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()].map(([name, count]) => `${count} × ${name}`).join(', ');
}

// ---------------------------------------------------------------------------
// the flow
// ---------------------------------------------------------------------------

export interface LinkOptions {
    where: Where;
    keepAliveMs?: number;
    /** Where the sensors used last time are remembered (see `registry.ts`). Default: the user's home folder. */
    registryPath?: string;
    /** Test seams for the plates' zero (defaults {@link ZERO_RETRY_MS}, {@link ZERO_EMPTY_TIMEOUT_MS}, {@link ZERO_STEP_TIMEOUT_MS}). */
    zeroRetryMs?: number;
    zeroEmptyTimeoutMs?: number;
    zeroStepTimeoutMs?: number;
    stillWindowMs?: number;
}

export class CompanionLink {
    private lostReason: string | undefined;
    /** "Stop the activity" is registered once, however many times the activity is prepared. */
    private activityTeardownAdded = false;
    /** The outcome of the zero each device took while it connected (`device.baseline`), by device id. */
    private readonly initZero = new Map<string, BaselineErrorCode | undefined>();
    private readonly keepAliveMs: number;

    constructor(
        private readonly client: CompanionClient,
        private readonly teardown: Teardown,
        private readonly interrupts: Interrupts,
        private readonly ui: Ui,
        private readonly options: LinkOptions,
    ) {
        this.keepAliveMs = options.keepAliveMs ?? KEEP_ALIVE_MS;
    }

    /** Steps 1 to 3: discover (E1), version (E2), claim (E3, E3b). Returns the companion's version. */
    async connect(): Promise<string> {
        const e1 = (): CliExit => new CliExit(EXIT.ENVIRONMENT, noCompanionMessage(this.options.where));

        let found: string | undefined;
        try {
            found = await interruptible(this.client.discover(), this.interrupts);
        } catch (error) {
            throw rethrowInterrupt(error) ?? e1();
        }
        if (found === undefined) throw e1();

        let installed: string;
        try {
            const compatibility = await interruptible(this.client.compatibility(), this.interrupts);
            if (compatibility.state !== 'match') {
                throw new CliExit(EXIT.ENVIRONMENT, versionMismatchMessage(compatibility.installed, compatibility.expected));
            }
            installed = compatibility.installed;
        } catch (error) {
            if (error instanceof CliExit) throw error;
            // `health()` throws a CompanionError with status 0 or the HTTP status, or the platform's own
            // TypeError when `fetch` could not connect (pinned `--port`, nothing listening).
            throw rethrowInterrupt(error) ?? e1();
        }
        this.ui.info(`Companion ${installed} found at ${this.client.endpoint}.`);

        // Subscribed BEFORE the claim: a refused first poll is reported only through this stream
        // (`session.claim()` resolves; the session is simply not running).
        this.client.sessionLost$.subscribe((reason) => {
            this.lostReason = reason;
        });
        this.teardown.add({name: 'release the session', run: () => this.client.session.release()});

        try {
            await interruptible(this.client.session.claim(), this.interrupts);
        } catch (error) {
            const interrupt = rethrowInterrupt(error);
            if (interrupt) throw interrupt;
            if (error instanceof CompanionError) {
                if (error.code === 'VERSION_MISMATCH') {
                    throw new CliExit(EXIT.ENVIRONMENT, versionMismatchMessage(installed, VERSION));
                }
                if (error.status === 409) throw new CliExit(EXIT.SESSION, SESSION_HELD_MESSAGE);
                if (error.status === 0) throw e1();
            }
            throw error;
        }
        if (this.lostReason !== undefined) throw new CliExit(EXIT.SESSION, SESSION_HELD_MESSAGE);

        // E3b: a 503 (the previous session is still being released) leaves the pump running without a
        // session; the SDK asks again on every tick. Wait a short while for it, then give up.
        const deadline = Date.now() + CLAIM_RETRY_MS;
        while (this.client.session.id === undefined) {
            if (this.lostReason !== undefined || !this.client.session.isRunning || Date.now() >= deadline) {
                throw new CliExit(EXIT.SESSION, SESSION_HELD_MESSAGE);
            }
            await interruptible(sleep(50), this.interrupts);
        }
        this.ui.info('Session claimed.');
        return installed;
    }

    /**
     * The rates the companion offers for `type`'s family on this machine, and the one in force; `undefined` when
     * the companion has no rate setting for it. The list is the same as the mobile app's.
     */
    async offeredRates(type: DeviceType): Promise<{rates: number[]; current: number} | undefined> {
        const snapshot = await interruptible(this.client.frequencySettings(), this.interrupts);
        return offeredRatesOf(snapshot, type);
    }

    /**
     * The jump rates a K-Deltas jump test can use on this machine: the union of both ballistic families' jump-protocol
     * rates (4000 Hz is the K-Deltas XL's alone), and the rate in force when it already is a jump rate.
     */
    async offeredJumpRates(): Promise<OfferedJumpRates> {
        const snapshot = await interruptible(this.client.frequencySettings(), this.interrupts);
        return offeredJumpRatesOf(snapshot);
    }

    /** Step 4, only with `--rate`. */
    async applyRate(type: DeviceType, rate: number): Promise<void> {
        const snapshot = await interruptible(this.client.frequencySettings(), this.interrupts);
        const decision = decideRate(snapshot, type, rate);
        if (decision.kind === 'refuse') throw new CliExit(EXIT.BAD_FLAGS, decision.message);
        if (decision.kind === 'keep') {
            this.ui.info(`Sampling rate is already ${rate} Hz; not changed.`);
            return;
        }
        try {
            await interruptible(this.client.setFrequencySetting(decision.request), this.interrupts);
        } catch (error) {
            const interrupt = rethrowInterrupt(error);
            if (interrupt) throw interrupt;
            if (error instanceof CompanionError) {
                throw new CliExit(
                    error.status === 400 ? EXIT.BAD_FLAGS : EXIT.DEVICE,
                    `The companion refused --rate ${rate}: ${error.reason ?? error.message}.`,
                );
            }
            throw error;
        }
        this.ui.info(`Sampling rate set to ${rate} Hz (the companion reconnects the sensors).`);
    }

    /**
     * Before `prepareActivity` of a jump test: put BOTH ballistic K-Deltas families in the jump-protocol
     * mode ({@link decideJumpRates}; why both: {@link BALLISTIC_FAMILIES}). Returns the jump rate of each family.
     */
    async applyJumpRates(rate: number | undefined): Promise<JumpRatePlan[]> {
        const snapshot = await interruptible(this.client.frequencySettings(), this.interrupts);
        const decision = decideJumpRates(snapshot, rate);
        if (decision.kind === 'refuse') throw new CliExit(EXIT.BAD_FLAGS, decision.message);
        for (const note of decision.notes) this.ui.info(note);
        for (const plan of decision.plans) {
            const label = ballisticFamilyLabel(plan.family);
            if (!plan.send) {
                this.ui.info(`Jump rate of the ${label} is already ${plan.rate} Hz (jump protocol); not changed.`);
                continue;
            }
            const request: FrequencySettingRequest = {family: plan.family, rate: plan.rate, mode: JUMP_PROTOCOL_MODE};
            try {
                await interruptible(this.client.setFrequencySetting(request), this.interrupts);
            } catch (error) {
                const interrupt = rethrowInterrupt(error);
                if (interrupt) throw interrupt;
                if (error instanceof CompanionError) {
                    throw new CliExit(
                        error.status === 400 ? EXIT.BAD_FLAGS : EXIT.DEVICE,
                        `The companion refused the jump rate ${plan.rate} Hz for the ${label}: ${error.reason ?? error.message}.`,
                    );
                }
                throw error;
            }
            this.ui.info(`Jump rate of the ${label} set to ${plan.rate} Hz, jump protocol (the companion reconnects the sensors).`);
        }
        return decision.plans;
    }

    /** Step 5: one `ping()` now and one every 10 s until the teardown. Errors are ignored: it is a tick. */
    startKeepAlive(): void {
        const tick = (): void => {
            this.client.ping().catch(() => undefined);
        };
        tick();
        const timer = setInterval(tick, this.keepAliveMs);
        this.teardown.add({name: 'stop the keep-alive', run: () => clearInterval(timer)});
    }

    /**
     * Steps 6 to 11: send the plan, then wait until the host reports the activity ready with EVERY planned
     * device READY (E4 otherwise), or until the timeout (E5).
     *
     * A pair type (K-Plates, K-Deltas, K-Deltas 3D) is planned by the host as LEFT + RIGHT; with
     * `single` the plan carries `isMonopodal: true` and the host keeps LEFT only. The answer is every planned device, in the plan's order (`activityState.plan.deviceTypes`:
     * LEFT then RIGHT), each with its `side`; a device the plan did not ask for is ignored. For any other
     * type it is the one device, as before.
     *
     * `jump` sends `exerciseType: 'JUMP_ANALYSIS'` (see the file header); the caller has set the ballistic
     * rates before (`applyJumpRates`).
     */
    async prepareAndWait(
        type: DeviceType,
        timeoutMs: number,
        single = false,
        jump = false,
        exclude: readonly string[] = [],
        registered: readonly RegisteredDevice[] = [],
    ): Promise<DeviceSnapshot[]> {
        const label = labelOf(type);
        const config: ActivityConfiguration = {
            activityCode: ACTIVITY_CODE,
            // THE ONLY PLACE THIS SAMPLE SENDS AN EXERCISE TYPE, and only for a jump test. `JUMP_ANALYSIS` is the
            // one value that changes the device setup (`isBallisticExercise`); any other run sends no key at all
            // (absent means `UNKNOWN`).
            ...(jump ? {exerciseType: ExerciseType.JUMP_ANALYSIS} : {}),
            deviceTypes: [type],
            // Sent only for `--single`: a request for one sensor of any other type stays as it was.
            ...(single && isPairType(type) ? {isMonopodal: true} : {}),
            // The sensors used last time, connected directly before any scan (`registry.ts`).
            registered: [...registered],
            exclude: [...exclude],
        };

        // Registered before the request leaves: a prepare that reached the companion must be stopped
        // even if its answer never reaches us.
        // With no session left (E7: another client took it) there is nothing to stop: the companion ended
        // the activity with the session, and the SDK refuses a command without one.
        if (!this.activityTeardownAdded) {
            this.activityTeardownAdded = true;
            this.teardown.add({
                name: 'stop the activity',
                run: () => (this.client.session.id === undefined ? undefined : this.client.stopActivity()),
            });
        }
        try {
            await interruptible(this.client.prepareActivity(config), this.interrupts);
        } catch (error) {
            const interrupt = rethrowInterrupt(error);
            if (interrupt) throw interrupt;
            if (error instanceof CompanionError) {
                throw new CliExit(EXIT.DEVICE, `Could not prepare the ${label}: ${error.reason ?? error.message}.`);
            }
            throw new CliExit(EXIT.ENVIRONMENT, `Lost contact with the companion at ${this.client.endpoint}.`);
        }

        const fallbackSlots = expectedSlots(type, single && isPairType(type));
        let planSlots: readonly BluetoothDeviceType[] | undefined;
        const slots = (): readonly BluetoothDeviceType[] => (planSlots !== undefined && planSlots.length > 0 ? planSlots : fallbackSlots);

        const seconds = Math.round(timeoutMs / 1000);
        const plural = isPairType(type) && fallbackSlots.length > 1;
        this.ui.info(
            `Switch on your ${switchOnText(type, fallbackSlots)}. Waiting for ${plural ? 'them' : 'it'} to connect… (Ctrl-C to cancel, timeout ${seconds} s)`,
        );

        const subscriptions: Subscription[] = [];
        let timer: ReturnType<typeof setTimeout> | undefined;
        let onAbort: (() => void) | undefined;
        const seen = new Map<string, BluetoothDeviceType>();
        const shownStates = new Map<string, string>();
        let latest: DeviceSnapshot[] = [];
        let picking = false;

        try {
            return await new Promise<DeviceSnapshot[]>((resolve, reject) => {
                const fail = (code: (typeof EXIT)[keyof typeof EXIT], message: string): void => reject(new CliExit(code, message));

                timer = setTimeout(() => {
                    fail(EXIT.DEVICE, timeoutMessage({type, slots: slots(), devices: latest, seconds, seen, single: single && isPairType(type)}));
                }, timeoutMs);

                onAbort = (): void => reject(this.interrupts.abortSignal.reason);
                if (this.interrupts.abortSignal.aborted) onAbort();
                this.interrupts.abortSignal.addEventListener('abort', onAbort, {once: true});

                subscriptions.push(
                    this.client.sessionLost$.subscribe((reason) =>
                        fail(EXIT.SESSION, reason === 'refused' ? SESSION_HELD_MESSAGE : 'The companion ended this session. Run again.'),
                    ),
                );

                // The devices the host is preparing, one line per state change.
                subscriptions.push(
                    this.client.devices$.subscribe((devices) => {
                        latest = devices;
                        for (const device of devices) {
                            if (!device.inUse || shownStates.get(device.id) === device.state) continue;
                            shownStates.set(device.id, device.state);
                            this.ui.info(`  ${deviceName(device)}: ${device.state.toLowerCase()}`);
                        }
                    }),
                );

                // Scan hits arrive while preparing: show each Kinvent sensor once.
                subscriptions.push(
                    this.client.events$.subscribe((event) => {
                        // A remembered sensor did not answer. The companion stops there, as the mobile app does (its
                        // dialog then offers the next device); this sample goes on without it, see `prepareMatching`.
                        if (event.type === 'registered.failed') {
                            reject(new RegisteredFailed(event.deviceId));
                            return;
                        }
                        if (event.type === 'device.baseline') {
                            this.initZero.set(event.deviceId, event.error);
                            return;
                        }
                        if (event.type !== 'scan.discovery') return;
                        const bt = event.bluetoothDeviceType;
                        if (bt === BluetoothDeviceType.UNKNOWN || bt === BluetoothDeviceType.ANY || seen.has(event.device.id)) return;
                        seen.set(event.device.id, bt);
                        this.ui.info(`  scanning… found ${getBluetoothDeviceName(bt)}`);
                    }),
                );

                subscriptions.push(
                    this.client.adapterState$.subscribe((state) => {
                        if (state === 'poweredOff') this.ui.info('  Bluetooth is off on the computer running the companion.');
                        if (state === 'unauthorized') this.ui.info('  The companion is not allowed to use Bluetooth on this computer.');
                        if (state === 'unsupported') fail(EXIT.ENVIRONMENT, RADIO_UNSUPPORTED_MESSAGE);
                    }),
                );

                // Subscribed BEFORE `activityReady$`: the plan of the same level is known when readiness is read.
                subscriptions.push(
                    this.client.activityState$.subscribe((state) => {
                        if (state.plan?.deviceTypes !== undefined) planSlots = state.plan.deviceTypes;
                        if (state.state !== 'failed') return;
                        const failure = state.failure;
                        fail(
                            EXIT.DEVICE,
                            failure === undefined
                                ? `Could not prepare the ${label}.`
                                : `Could not prepare the ${label}: ${failure.step} – ${failure.reason}.`,
                        );
                    }),
                );

                // Ready is the LEVEL (`activityReady$`), never the `activity.ready` event.
                subscriptions.push(
                    this.client.activityReady$.subscribe((ready) => {
                        if (!ready || picking) return;
                        picking = true;
                        void this.pickDevices(slots(), latest)
                            .then((picked) => {
                                if (picked.devices !== undefined) {
                                    resolve(picked.devices);
                                    return;
                                }
                                // Not every planned device is ready. A ready device of another type says why.
                                const other = picked.seen.find((device) => isReadyInUse(device) && !isDeviceCompatibleWith(type, device.deviceType));
                                if (other !== undefined) {
                                    fail(EXIT.DEVICE, `The companion connected a ${labelOf(other.deviceType)} (${other.deviceType}), not a ${label}.`);
                                    return;
                                }
                                const assigned = assignSlots(slots(), picked.seen, isReadyInUse);
                                const ready = assigned.filter((device): device is DeviceSnapshot => device !== undefined);
                                if (ready.length === 0) {
                                    fail(EXIT.DEVICE, `Could not prepare the ${label}: the companion reports no ready device.`);
                                    return;
                                }
                                const missing = slots().filter((_, i) => assigned[i] === undefined).map((slot) => getBluetoothDeviceName(slot));
                                fail(
                                    EXIT.DEVICE,
                                    `Could not prepare the ${label}: the companion reports ${joinNames(ready.map(deviceName))} ready but not ${joinNames(missing)}.`,
                                );
                            })
                            .catch(reject);
                    }),
                );
            });
        } finally {
            clearTimeout(timer);
            if (onAbort) this.interrupts.abortSignal.removeEventListener('abort', onAbort);
            for (const subscription of subscriptions) subscription.unsubscribe();
        }
    }

    /**
     * Floor devices (K-Plates, K-Deltas, K-Deltas 3D): calibrate (zero) them again while nothing loads them, and
     * repeat until the zero passes. The mobile app runs ONE flow for all three:
     * "Don't step on…, calibrating" while they initialise, and on a failed zero "Calibration of the {device} has
     * failed. Please {step off the plates | release the device} and retry the calibration." with the reason.
     *
     * WHY AGAIN. The devices are zeroed while they connect, and the companion may reuse a sensor's earlier zero
     * on a later connection without zeroing again, so the zero in force may be old or may have been taken under
     * load. `rezero(id)` takes a new one (the app's "Recalibrate"). Its result is a `device.baseline` event; an
     * error means the device was loaded (`CHANNEL_ABOVE_15`, `SUM_CHANNELS_ABOVE_THRESHOLD`) or moving
     * (`STD_ABOVE_1`). Where the app asks Recalibrate or Abort, this sample re-zeroes by itself every few seconds
     * until the load is gone, and gives up after a while.
     *
     * Only a device whose firmware checks its zero (`baselineErrorCheck`) can report load. The 3D Deltas never
     * report it, so they are zeroed once, with a
     * warning. The companion does not stream before `measureStart`, so this is the only load signal available.
     */
    async calibrateFloorDevices(type: DeviceType, devices: readonly DeviceSnapshot[]): Promise<void> {
        const noun = floorNounOf(type);
        const release = releaseTextOf(type);
        const deadline = Date.now() + (this.options.zeroEmptyTimeoutMs ?? ZERO_EMPTY_TIMEOUT_MS);
        const checks = (device: DeviceSnapshot): boolean =>
            type !== DeviceType.DELTAS_3D && device.configuration?.capabilities.baselineErrorCheck === true;
        const unchecked = devices.filter((device) => !checks(device));
        if (unchecked.length > 0) {
            this.ui.info(
                type === DeviceType.DELTAS_3D
                    ? `  The 3D Deltas do not check their calibration (as in the mobile app). Make sure nothing presses on them.`
                    : `  ${joinNames(unchecked.map(deviceName))}: this firmware cannot report load while calibrating. Make sure nothing presses on the ${noun}.`,
            );
        }
        this.ui.info(`${capitalised(release)}. Waiting until nothing moves on the ${noun}…`);
        let pending = [...devices];
        for (;;) {
            await this.waitUntilStill(pending, devices, noun, release, deadline);
            this.ui.info(`Calibrating the ${noun}. Keep them free of load…`);
            const results = await interruptible(this.zeroOnce(pending), this.interrupts);
            const failed = pending.filter((device) => checks(device) && results.get(device.id) !== undefined);
            if (failed.length === 0) break;
            const why = failed.map((device) => `${deviceName(device)}: ${zeroErrorText(results.get(device.id)!)}`).join('; ');
            if (Date.now() >= deadline) {
                throw new CliExit(EXIT.DEVICE, `Calibration of the ${noun} has failed (${why}). Please ${release} and run again.`);
            }
            this.ui.info(`  Calibration has failed (${why}). Please ${release}. Waiting until nothing moves…`);
            pending = failed;
        }
        this.ui.info(`${capitalised(noun)} calibrated.`);
    }

    /**
     * Wait until nothing moves on `watch`: a short measurement of the activity, watched until every watched device's
     * total force has stayed within {@link STILL_KG} for {@link STILL_WINDOW_MS}, then stopped on every device of the
     * activity (`all`), so the zero that follows finds the host ready.
     *
     * "STILL", NOT "NEAR 0 KG". The streamed values are relative to the zero in force, and a zero taken under load reads 0 under that load, so no value here says whether a load is
     * present. What a person stepping off, or shifting their weight, DOES produce is change; stillness is what the
     * mobile app's own zero demands too (`STD_ABOVE_1`). A load that stands perfectly still passes this and is then
     * caught by the zero's firmware check on devices that have one.
     */
    private async waitUntilStill(
        watch: readonly DeviceSnapshot[],
        all: readonly DeviceSnapshot[],
        noun: string,
        release: string,
        deadline: number,
    ): Promise<void> {
        const windowMs = this.options.stillWindowMs ?? STILL_WINDOW_MS;
        const windows = new Map<string, Array<{t: number; total: number}>>(watch.map((device) => [device.id, []]));
        const still = new Set<string>();
        const subscriptions: Subscription[] = [];
        let timer: ReturnType<typeof setTimeout> | undefined;
        let remindAt = 0;
        try {
            const settled = new Promise<void>((resolve, reject) => {
                timer = setTimeout(
                    () => reject(new CliExit(EXIT.DEVICE, `Nothing stood still on the ${noun} in time. ${capitalised(release)} and run again.`)),
                    Math.max(0, deadline - Date.now()),
                );
                for (const device of watch) {
                    subscriptions.push(
                        this.client.sampleBatches$(device.id).subscribe((batch) => {
                            const window = windows.get(device.id)!;
                            for (const sample of batch) window.push({t: sample.timeStamp, total: totalOf(sample.channels)});
                            if (window.length === 0) return;
                            const latest = window[window.length - 1]!.t;
                            while (window.length > 1 && latest - window[0]!.t > windowMs) window.shift();
                            const covers = latest - window[0]!.t >= windowMs * 0.9;
                            let low = Number.POSITIVE_INFINITY;
                            let high = Number.NEGATIVE_INFINITY;
                            for (const entry of window) {
                                if (entry.total < low) low = entry.total;
                                if (entry.total > high) high = entry.total;
                            }
                            const stable = covers && high - low <= STILL_KG;
                            if (stable) still.add(device.id);
                            else still.delete(device.id);
                            if (still.size === watch.length) {
                                resolve();
                                return;
                            }
                            const now = Date.now();
                            if (covers && !stable && now >= remindAt) {
                                remindAt = now + 2000;
                                this.ui.info(`  Load changing on ${deviceName(device)}. ${capitalised(release)} and keep still…`);
                            }
                        }),
                    );
                }
                // ONE start starts every device of the activity (as in `measure.ts`); the stop below is per device.
                this.client.measureStart(all[0]!.id).catch((error: unknown) => reject(error));
            });
            await interruptible(settled, this.interrupts);
        } finally {
            clearTimeout(timer);
            for (const subscription of subscriptions) subscription.unsubscribe();
            for (const device of all) {
                await this.client.measureStop(device.id).catch(() => undefined);
            }
        }
    }

    /** One zero of each device: `rezero(id)`, its `device.baseline` result, then every device READY again. */
    private async zeroOnce(devices: readonly DeviceSnapshot[]): Promise<Map<string, BaselineErrorCode | undefined>> {
        const stepMs = this.options.zeroStepTimeoutMs ?? ZERO_STEP_TIMEOUT_MS;
        const ids = new Set(devices.map((device) => device.id));
        const results = new Map<string, BaselineErrorCode | undefined>();
        let subscription: Subscription | undefined;
        let timer: ReturnType<typeof setTimeout> | undefined;
        try {
            // Subscribed BEFORE the requests leave: the result can arrive in the next poll.
            const answered = new Promise<void>((resolve, reject) => {
                subscription = this.client.events$.subscribe((event) => {
                    if (event.type !== 'device.baseline' || !ids.has(event.deviceId)) return;
                    results.set(event.deviceId, event.error);
                    if (results.size === ids.size) resolve();
                });
                timer = setTimeout(
                    () => reject(new CliExit(EXIT.DEVICE, 'The companion did not report the calibration in time. Run again.')),
                    stepMs,
                );
            });
            for (const device of devices) {
                try {
                    await this.client.rezero(device.id);
                } catch (error) {
                    const reason = error instanceof CompanionError ? (error.reason ?? error.message) : String(error);
                    throw new CliExit(EXIT.DEVICE, `Could not calibrate ${deviceName(device)}: ${reason}.`);
                }
            }
            await answered;
            // A zero takes the device through INITIALIZING; the measurement may start only once it is READY again.
            const readyBy = Date.now() + stepMs;
            for (;;) {
                const now = await this.client.devices();
                if (devices.every((device) => now.some((current) => current.id === device.id && isReadyInUse(current)))) break;
                if (Date.now() >= readyBy) {
                    throw new CliExit(EXIT.DEVICE, 'The devices did not come back ready after calibrating. Run again.');
                }
                await sleep(250);
            }
            return results;
        } finally {
            clearTimeout(timer);
            subscription?.unsubscribe();
        }
    }

    /**
     * Pair types (K-Plates, K-Deltas, K-Deltas 3D): the sensors used last time first.
     *
     * THE SENSORS USED LAST TIME GO FIRST, as the mobile app's registered devices do (`registry.ts`): the companion
     * connects them directly, before any scan. A remembered sensor that does not answer is dropped and the rest
     * tried; with none left the companion scans. The sensors of the requested type that were recorded are
     * remembered for the next run.
     *
     * A 3D DELTA MAY FILL A K-DELTAS SLOT. The companion fills a slot with any compatible device, as the mobile app
     * does: a K-Deltas request can come back as a K-Delta and a 3D Delta, and that pair is
     * recorded as it is, as in the mobile app. Only sensors of the
     * requested type are remembered, so a remembered pair is of one type.
     */
    async prepareMatching(type: DeviceType, timeoutMs: number, single = false, jump = false): Promise<DeviceSnapshot[]> {
        const label = labelOf(type);
        const registryPath = this.options.registryPath ?? defaultRegistryPath();
        let registered = readRegistered(registryPath, type, single);
        if (registered.length > 0) {
            const names = registered.map((entry) => entry.deviceName).join(', ');
            this.ui.info(`Trying the ${registered.length === 1 ? 'sensor' : 'sensors'} used last time first (${names}).`);
        }
        for (;;) {
            try {
                const devices = await this.prepareAndWait(type, timeoutMs, single, jump, [], registered);
                rememberDevices(registryPath, type, devices.filter((device) => device.deviceType === type));
                return devices;
            } catch (error) {
                if (!(error instanceof RegisteredFailed)) throw error;
                const failed = registered.find((entry) => entry.deviceId === error.deviceId);
                registered = registered.filter((entry) => entry.deviceId !== error.deviceId);
                const next = registered.length > 0 ? 'Trying the next remembered sensor…' : 'Scanning for sensors instead…';
                this.ui.info(`${failed?.deviceName ?? 'A sensor used last time'} did not answer. ${next}`);
                await this.stopAndSettle(label);
            }
        }
    }

    /**
     * The zero taken at connection, per floor device — SAID ONLY WHEN SOMETHING IS OFF: the zero failed, or one of
     * its values is above 15 kg (a plate) or 30 kg (a K-Deltas or 3D Deltas) while the sensor should be empty. A
     * normal empty sensor says nothing. Diagnostics, not data of a person.
     */
    describeZeros(type: DeviceType, devices: readonly DeviceSnapshot[]): string[] {
        const limit = type === DeviceType.PLATES ? 15 : 30;
        const lines: string[] = [];
        for (const device of devices) {
            const configuration = device.configuration;
            const zero = configuration?.baseline ?? [];
            const error = this.initZero.get(device.id);
            const high = zero.some((value) => Math.abs(value) > limit);
            if (error === undefined && !high) continue;
            const variant = configuration?.deltasVariant === undefined ? '' : `${configuration.deltasVariant} variant, `;
            const values = zero.length === 0 ? 'not reported' : `${zero.map((value) => value.toFixed(1)).join(' / ')} kg`;
            const why =
                error !== undefined
                    ? `failed: ${zeroErrorText(error)}`
                    : `a cell above ${limit} kg while it should be empty — check that nothing was on it`;
            lines.push(`  ${deviceName(device)}: ${variant}zero at connection ${values} (${why})`);
        }
        return lines;
    }

    /**
     * Stop the activity and prepare it again with the same sensors, as a jump test or not.
     *
     * FOR A K-DELTAS JUMP TEST, ZERO FIRST. The jump layout (one value, `forceTotal`) starts at the first
     * `measureStart` of a JUMP_ANALYSIS activity, and the stillness measurement is such a start. A zero asked for
     * after that point fails on an empty sensor. So the activity is first prepared as a normal one and zeroed,
     * then prepared again as the jump test; the companion keeps the connected sensors and their new zero. The
     * mobile app also zeroes before the jump test starts.
     */
    async restartActivity(type: DeviceType, timeoutMs: number, single: boolean, jump: boolean): Promise<DeviceSnapshot[]> {
        await this.stopAndSettle(labelOf(type));
        return this.prepareAndWait(type, timeoutMs, single, jump);
    }

    /** Forget the sensors remembered for `type` (`--forget-devices`). */
    forgetRemembered(type: DeviceType): void {
        forgetDevices(this.options.registryPath ?? defaultRegistryPath(), type);
    }

    /** Stop the activity and wait until the companion says so, before it is prepared again. */
    private async stopAndSettle(label: string): Promise<void> {
        try {
            await interruptible(this.client.stopActivity(), this.interrupts);
        } catch (error) {
            const interrupt = rethrowInterrupt(error);
            if (interrupt) throw interrupt;
            const reason = error instanceof CompanionError ? (error.reason ?? error.message) : String(error);
            throw new CliExit(EXIT.DEVICE, `Could not prepare the ${label} again: ${reason}.`);
        }
        // The readiness LEVEL still says "ready" until the next poll; preparing before it drops would pick
        // up the devices of the activity just stopped.
        await interruptible(this.waitUntilNotReady(), this.interrupts);
    }

    /** Resolves once `activityReady$` reports `false` (the activity is stopped); E5-style exit after 10 s. */
    private waitUntilNotReady(): Promise<void> {
        return new Promise<void>((resolve, reject) => {
            let done = false;
            let subscription: Subscription | undefined;
            const timer = setTimeout(() => {
                done = true;
                subscription?.unsubscribe();
                reject(new CliExit(EXIT.DEVICE, 'The companion did not stop the activity in time. Run again.'));
            }, 10_000);
            subscription = this.client.activityReady$.subscribe((ready) => {
                if (ready || done) return;
                done = true;
                clearTimeout(timer);
                queueMicrotask(() => subscription?.unsubscribe());
                resolve();
            });
            if (done) subscription.unsubscribe();
        });
    }

    /**
     * The level is applied before the events of the same poll envelope, so `devices$` can lag the
     * readiness by one envelope. `GET /devices` is the companion's own answer and settles it.
     */
    private async pickDevices(
        slots: readonly BluetoothDeviceType[],
        latest: readonly DeviceSnapshot[],
    ): Promise<{devices: DeviceSnapshot[] | undefined; seen: readonly DeviceSnapshot[]}> {
        const fromStream = readyDevicesOfPlan(slots, latest);
        if (fromStream !== undefined) return {devices: fromStream, seen: latest};
        const answered = await this.client.devices();
        return {devices: readyDevicesOfPlan(slots, answered), seen: answered};
    }
}

/** A zero error as the mobile app words it. */
function zeroErrorText(code: BaselineErrorCode): string {
    switch (code) {
        case 'CHANNEL_ABOVE_15':
        case 'SUM_CHANNELS_ABOVE_THRESHOLD':
            return 'forces were being applied';
        case 'STD_ABOVE_1':
            return 'movement has been detected';
        case 'NEGATIVE_VALUES':
            return 'negative values detected';
        default:
            return code;
    }
}

/** The devices calibrated before an activity, as in the mobile app: everything stood on or loaded from the floor. */
export function isFloorType(type: DeviceType): boolean {
    return type === DeviceType.PLATES || type === DeviceType.HEXAS || type === DeviceType.DELTAS_3D;
}

/** How the user is told to name a floor type: "plates", "Deltas", "3D Deltas". */
export function floorNounOf(type: DeviceType): string {
    return type === DeviceType.PLATES ? 'plates' : type === DeviceType.DELTAS_3D ? '3D Deltas' : 'Deltas';
}

/** What to do about a failed zero, as the mobile app words it. */
export function releaseTextOf(type: DeviceType): string {
    return type === DeviceType.PLATES ? 'step off the plates' : 'release the device';
}

/** The total force of one sample: every finite channel summed (a K-Deltas in a jump test sends the total alone). */
function totalOf(channels: readonly number[]): number {
    let total = 0;
    for (const value of channels) if (Number.isFinite(value)) total += value;
    return total;
}

function capitalised(text: string): string {
    return text.charAt(0).toUpperCase() + text.slice(1);
}

function sleep(ms: number): Promise<void> {
    return new Promise((resolve) => setTimeout(resolve, ms));
}

/** The {@link Interrupted} error itself when `error` is one, so callers can rethrow it unchanged. */
function rethrowInterrupt(error: unknown): Interrupted | undefined {
    return error instanceof Interrupted ? error : undefined;
}
