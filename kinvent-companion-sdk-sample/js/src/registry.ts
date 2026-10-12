/**
 * FOR INTEGRATORS: README.md section 5.5. What to store between runs so the same sensors connect first next time:
 * hand them to `prepareActivity` as `registered`.
 *
 * THE SENSORS USED LAST TIME, per device type — the mobile app's "registered devices", reduced to a file.
 *
 * WHY. The companion fills a slot with the FIRST compatible sensor its scan hears, and a 3D Delta is compatible
 * with a K-Deltas slot, so with both pairs switched on a
 * K-Deltas request can come back mixed. The mobile app avoids that with its registered devices: the sensors the
 * user registered are handed over as `registered` and connected DIRECTLY, by id, before any scan. The
 * app's registry is a screen and a database; this sample's is the pair it recorded last time, written here after
 * every successful preparation of a pair type and sent as `registered` on the next run.
 *
 * WHAT IS STORED: the companion's device id (stable on the same
 * computer, which is all this needs), the sensor's Bluetooth name (the companion
 * classifies a registered device by its name, so an empty one is useless and is not stored) and its side. Sensor
 * identifiers: they can become personal data once linked to a person or a session, so they are kept in the user's
 * home folder, readable by the user only, and never in a recording.
 */
import {chmodSync, mkdirSync, readFileSync, writeFileSync} from 'node:fs';
import {homedir} from 'node:os';
import {dirname, join} from 'node:path';
import type {DeviceSide, DeviceSnapshot, DeviceType, RegisteredDevice} from '@kinvent/companion-sdk';

/** Where the file lives unless the caller says otherwise. */
export function defaultRegistryPath(): string {
    return join(homedir(), '.kinvent-companion-sample', 'last-devices.json');
}

interface Remembered {
    deviceId: string;
    deviceName: string;
    side: DeviceSide | null;
}

interface RegistryFile {
    version: 1;
    byType: Partial<Record<string, Remembered[]>>;
}

function read(path: string): RegistryFile {
    try {
        const parsed = JSON.parse(readFileSync(path, 'utf8')) as unknown;
        if (typeof parsed === 'object' && parsed !== null && (parsed as RegistryFile).version === 1 && typeof (parsed as RegistryFile).byType === 'object') {
            return parsed as RegistryFile;
        }
    } catch {
        // Missing, unreadable or not ours: start empty. A registry is a convenience, never a reason to stop.
    }
    return {version: 1, byType: {}};
}

const SIDE_ORDER: Record<string, number> = {LEFT: 0, RIGHT: 1};

/**
 * The sensors remembered for `type`, as the plan's `registered`: LEFT before RIGHT, `connectionOrder` ascending.
 * `single`: the LEFT one only (the companion keeps LEFT for a monopodal plan; a remembered RIGHT would be skipped
 * anyway, since its type is not in the plan).
 */
export function readRegistered(path: string, type: DeviceType, single = false): RegisteredDevice[] {
    const entries = (read(path).byType[type] ?? [])
        .filter((entry) => typeof entry.deviceId === 'string' && entry.deviceId !== '' && typeof entry.deviceName === 'string' && entry.deviceName !== '')
        .filter((entry) => !single || entry.side !== 'RIGHT')
        .sort((a, b) => (SIDE_ORDER[a.side ?? ''] ?? 2) - (SIDE_ORDER[b.side ?? ''] ?? 2));
    return entries.map((entry, index) => ({deviceId: entry.deviceId, deviceName: entry.deviceName, deviceType: type, connectionOrder: index + 1}));
}

/**
 * Remember `devices` for `type`. A full pair replaces what was there; a single sensor replaces only its own side,
 * so the other side's sensor is kept for the next pair run. A sensor without a name is not stored.
 */
export function rememberDevices(path: string, type: DeviceType, devices: readonly DeviceSnapshot[]): void {
    const file = read(path);
    const named = devices.filter((device) => device.name !== '');
    // Every side this run used is replaced, named or not: an old entry must not outlive the sensor that took its place.
    const sides = new Set(devices.map((device) => device.side));
    const kept = (file.byType[type] ?? []).filter((entry) => !sides.has(entry.side));
    file.byType[type] = [...kept, ...named.map((device) => ({deviceId: device.id, deviceName: device.name, side: device.side}))];
    write(path, file);
}

/** Forget the sensors remembered for `type`. */
export function forgetDevices(path: string, type: DeviceType): void {
    const file = read(path);
    delete file.byType[type];
    write(path, file);
}

function write(path: string, file: RegistryFile): void {
    try {
        mkdirSync(dirname(path), {recursive: true, mode: 0o700});
        writeFileSync(path, `${JSON.stringify(file, null, 2)}\n`, {encoding: 'utf8', mode: 0o600});
        chmodSync(path, 0o600);
    } catch {
        // A registry that cannot be written costs the next run a scan, nothing more.
    }
}
