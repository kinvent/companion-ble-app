/**
 * FOR INTEGRATORS: README.md section 5.6. Copy the rule, not a table: the name and unit of every value come from
 * the companion (the stream descriptor), never from a list kept in your code.
 *
 * Where the name and the unit of every live field come from.
 *
 * THE ONLY SOURCE IS THE STREAM DESCRIPTOR. There is no table of units per device type in this package:
 *   1. `client.streamDescriptors()` (`GET /streams`), the entry whose `deviceId` is the device's id;
 *   2. if the companion has no entry for it, the SDK's pure `streamLayoutOf(deviceType,
 *      configuration)`, re-exported by the SDK (the same layout, with no round trip);
 *   3. if that is `undefined` too, the device has no layout and the run is refused (E11, exit 4).
 *
 * Every other module reads a sample as `channels[field.index]`, by the field's name. No other module
 * knows an index.
 *
 * The one mapping allowed here is {@link unitSymbol}: how a `StreamUnit` member is written on screen.
 */
import type {Subscription} from 'rxjs';
import {
    CompanionError,
    DeviceType,
    isDescribedDeviceType,
    StreamUnit,
    streamLayoutOf,
    type CompanionClient,
    type DeviceConfiguration,
    type DeviceSnapshot,
    type StreamField,
    type StreamLayout,
} from '@kinvent/companion-sdk';
import {CliExit, EXIT} from '../exit.js';
import {labelOf} from '../prompts.js';

/** `descriptor`: the companion's `GET /streams`; `sdk`: the SDK's `streamLayoutOf` over the device's configuration. */
export type FieldSource = 'descriptor' | 'sdk';

export interface FieldTable {
    fields: StreamField[];
    source: FieldSource;
}

/**
 * The screen symbol of each `StreamUnit` member. A `Record` over the enum, so the compiler refuses a
 * missing member; the units test refuses an extra one.
 */
const SYMBOLS: Readonly<Record<StreamUnit, string>> = {
    [StreamUnit.KILOGRAM]: 'kg',
    [StreamUnit.MILLIBAR]: 'mbar',
    [StreamUnit.MICROVOLT]: 'µV',
    [StreamUnit.DEGREE]: '°',
    [StreamUnit.METER]: 'm',
    [StreamUnit.METER_PER_SECOND]: 'm/s',
    [StreamUnit.METER_PER_SECOND_SQUARED]: 'm/s²',
};

/** How a unit is written on screen. A value off the wire that names no member is shown as `?`. */
export function unitSymbol(unit: StreamUnit): string {
    return (SYMBOLS as Record<string, string | undefined>)[unit] ?? '?';
}

/** The members {@link unitSymbol} knows, for the test that pins it to the enum. */
export function symbolTable(): Readonly<Record<string, string>> {
    return SYMBOLS;
}

/** The device types the SDK describes, as "K-Grip (GRIP), …", in the order of `DeviceType`. */
export function describedTypesText(): string {
    return (Object.values(DeviceType) as DeviceType[])
        .filter((type) => isDescribedDeviceType(type))
        .map((type) => `${labelOf(type)} (${type})`)
        .join(', ');
}

/** E11's sentence. */
export function undescribedMessage(device: Pick<DeviceSnapshot, 'deviceType' | 'configuration'>): string {
    const type = device.deviceType;
    const label = labelOf(type);
    if (!isDescribedDeviceType(type)) {
        return (
            `This Kinvent Companion version does not describe the live values of a ${label} (${type}) yet, ` +
            `so this sample cannot label them. Described types: ${describedTypesText()}. Choose one of those.`
        );
    }
    const protocol = device.configuration?.protocolType ?? 'not reported';
    return (
        `The companion gave no field layout for this ${label} (${type}, protocol ${protocol}), ` +
        `so this sample cannot label its values. Nothing was recorded.`
    );
}

/**
 * The fields of `device`'s live stream, with the source they came from. Throws `CliExit` E11 (exit 4)
 * when neither source describes the device.
 *
 * A companion that answers `GET /streams` with an error is treated as "no entry": the SDK's layout
 * is the documented fallback, and it needs no round trip.
 */
export async function fieldsFor(
    client: Pick<CompanionClient, 'streamDescriptors'>,
    device: Pick<DeviceSnapshot, 'id' | 'deviceType' | 'configuration'>,
): Promise<FieldTable> {
    const [table] = await fieldsForEach(client, [device]);
    return table!;
}

/**
 * The fields of EVERY device of the recording (one per device, in the order given), from ONE
 * `GET /streams` round trip. Each device follows the rule of {@link fieldsFor}: its own descriptor entry,
 * else the SDK's layout for its own configuration, else E11.
 */
export async function fieldsForEach(
    client: Pick<CompanionClient, 'streamDescriptors'>,
    devices: ReadonlyArray<Pick<DeviceSnapshot, 'id' | 'deviceType' | 'configuration'>>,
): Promise<FieldTable[]> {
    let descriptors: Awaited<ReturnType<CompanionClient['streamDescriptors']>> = [];
    try {
        descriptors = await client.streamDescriptors();
    } catch (error) {
        if (!(error instanceof CompanionError)) throw error;
    }
    return devices.map((device) => {
        const described = descriptors.find((entry) => entry.deviceId === device.id)?.fields;
        if (described !== undefined && described.length > 0) {
            return {fields: described.map((field) => ({...field})), source: 'descriptor'};
        }
        const layout = streamLayoutOf(device.deviceType, device.configuration ?? {});
        if (layout !== undefined && layout.fields.length > 0) {
            return {fields: layout.fields.map((field) => ({...field})), source: 'sdk'};
        }
        throw new CliExit(EXIT.DEVICE, undescribedMessage(device));
    });
}

/**
 * The fields a `stream.layout` event announces for a device: the layout the
 * event's configuration carries (`configuration.stream`), else the SDK's `streamLayoutOf` over that
 * configuration. `undefined` when neither describes it: the caller keeps the fields it had.
 */
export function fieldsFromConfiguration(deviceType: DeviceType, configuration: DeviceConfiguration): StreamField[] | undefined {
    return layoutFromConfiguration(deviceType, configuration)?.fields;
}

/**
 * The whole layout a configuration describes (its fields AND its `mode`, `'jump'` on a jump protocol):
 * `configuration.stream`, else the SDK's `streamLayoutOf` over the configuration; `undefined` when
 * neither describes it or it has no field. The fields are copies.
 */
export function layoutFromConfiguration(deviceType: DeviceType, configuration: DeviceConfiguration): StreamLayout | undefined {
    const layout = configuration.stream ?? streamLayoutOf(deviceType, configuration);
    if (layout === undefined || layout.fields.length === 0) return undefined;
    return {deviceType: layout.deviceType, mode: layout.mode, fields: layout.fields.map((field) => ({...field}))};
}

/**
 * Watch (also for the jump layout) `stream.layout` events for the recording's devices and hand
 * each device's NEW fields to `onChange(deviceIndex, fields)`. The companion sends the event once per
 * device whose protocol, rate, channel count or layout changed, before that device's first frame in the
 * new layout. Subscribe BEFORE `measureStart`.
 */
export function watchLayouts(
    client: Pick<CompanionClient, 'events$'>,
    devices: ReadonlyArray<Pick<DeviceSnapshot, 'id' | 'deviceType'>>,
    onChange: (deviceIndex: number, fields: StreamField[], configuration: DeviceConfiguration) => void,
): Subscription {
    return client.events$.subscribe((event) => {
        if (event.type !== 'stream.layout') return;
        const index = devices.findIndex((device) => device.id === event.deviceId);
        if (index < 0) return;
        const fields = fieldsFromConfiguration(devices[index]!.deviceType, event.configuration);
        // The configuration too, for the new rate, the protocol and the layout's mode.
        if (fields !== undefined) onChange(index, fields, event.configuration);
    });
}
