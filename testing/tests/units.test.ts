/**
 * Units come only from the stream descriptor: `fieldsFor` takes the
 * companion's entry for the device, falls back to the SDK's `streamLayoutOf`, and refuses (E11,
 * exit 4) a device neither describes. The only mapping in the package is the unit's screen symbol.
 */
import {strict as assert} from 'node:assert';
import {describe, it} from 'node:test';
import {
    CompanionError,
    DeviceType,
    StreamUnit,
    streamLayoutOf,
    type DeviceSnapshot,
    type StreamDescriptor,
} from '@kinvent/companion-sdk';
import {CliExit, EXIT} from '../../src/exit.js';
import {offeredTypes} from '../../src/prompts.js';
import {fieldsFor, symbolTable, unitSymbol} from '../../src/units/source.js';
import {fakeConfiguration} from '../doubles/fakeCompanion.js';

function device(type: DeviceType, id = 'dev-1'): Pick<DeviceSnapshot, 'id' | 'deviceType' | 'configuration'> {
    return {id, deviceType: type, configuration: fakeConfiguration(type, 1)};
}

function companion(answer: StreamDescriptor[] | Error): {streamDescriptors(): Promise<StreamDescriptor[]>; calls: number} {
    const stub = {
        calls: 0,
        streamDescriptors: async (): Promise<StreamDescriptor[]> => {
            stub.calls += 1;
            if (answer instanceof Error) throw answer;
            return answer;
        },
    };
    return stub;
}

describe('fieldsFor: the descriptor first', () => {
    it("takes the companion's entry for THIS device's id, as given", async () => {
        const fields = [
            {index: 0, name: 'force1', unit: StreamUnit.KILOGRAM},
            {index: 1, name: 'force2', unit: StreamUnit.KILOGRAM},
        ];
        const client = companion([
            {deviceId: 'other', deviceType: DeviceType.BUBBLE, mode: null, fields: [{index: 0, name: 'force1', unit: StreamUnit.KILOGRAM}]},
            {deviceId: 'dev-1', deviceType: DeviceType.PLATES, mode: null, fields},
        ]);
        const table = await fieldsFor(client, device(DeviceType.PLATES));
        assert.equal(client.calls, 1);
        assert.equal(table.source, 'descriptor');
        assert.deepEqual(table.fields, fields);
    });

    it('a descriptor that differs from the SDK layout wins: the companion is the source, not a local table', async () => {
        // A synthetic layout no SDK rule produces; the sample must show it as given.
        const fields = [{index: 3, name: 'oddName', unit: StreamUnit.DEGREE}];
        const table = await fieldsFor(companion([{deviceId: 'dev-1', deviceType: DeviceType.GRIP, mode: null, fields}]), device(DeviceType.GRIP));
        assert.deepEqual(table, {fields, source: 'descriptor'});
    });
});

describe('fieldsFor: the SDK fallback', () => {
    it('no entry for the device → streamLayoutOf over its configuration', async () => {
        const dev = device(DeviceType.BUBBLE);
        const table = await fieldsFor(companion([]), dev);
        assert.equal(table.source, 'sdk');
        // K-Bubble: `force1` in kg, the mobile app's raw CSV unit.
        assert.deepEqual(table.fields, [{index: 0, name: 'force1', unit: StreamUnit.KILOGRAM}]);
    });

    it('a companion error on GET /streams → the same fallback', async () => {
        const table = await fieldsFor(companion(new CompanionError('boom', 500, '/streams')), device(DeviceType.GRIP));
        assert.equal(table.source, 'sdk');
        assert.deepEqual(table.fields, [{index: 0, name: 'force1', unit: StreamUnit.KILOGRAM}]);
    });

    it('any other error is not swallowed', async () => {
        await assert.rejects(fieldsFor(companion(new TypeError('fetch failed')), device(DeviceType.GRIP)), TypeError);
    });

    it("for every offered force type, the fallback's names and units equal streamLayoutOf's", async () => {
        for (const {type} of offeredTypes()) {
            const dev = device(type);
            const table = await fieldsFor(companion([]), dev);
            assert.deepEqual(table.fields, streamLayoutOf(type, dev.configuration!)!.fields, type);
            assert.ok(table.fields.length > 0, type);
        }
        const deltas3d = await fieldsFor(companion([]), device(DeviceType.DELTAS_3D));
        assert.deepEqual(
            deltas3d.fields.map((field) => field.name),
            // Nine fields; frame position 3 (always 0) is not listed.
            ['force1', 'force2', 'force3', 'forceX1', 'forceY1', 'forceX2', 'forceY2', 'forceX3', 'forceY3'],
        );
        assert.ok(deltas3d.fields.every((field) => field.unit === StreamUnit.KILOGRAM));
    });
});

describe('fieldsFor: E11', () => {
    it('a deferred type (EMG) → CliExit exit 4, naming the type and the described types', async () => {
        const error = await fieldsFor(companion([]), device(DeviceType.EMG)).then(
            () => assert.fail('must refuse'),
            (e: unknown) => e,
        );
        assert.ok(error instanceof CliExit);
        assert.equal(error.code, EXIT.DEVICE);
        assert.equal(error.code, 4);
        assert.match(error.message, /does not describe the live values of a K-Myo \(EMG\) yet/);
        assert.match(error.message, /Described types: K-Grip \(GRIP\), .*K-Bubble \(BUBBLE\)/);
        for (const {type} of offeredTypes()) assert.ok(error.message.includes(`(${type})`), type);
        assert.ok(!/\((EMG|SENS|KPOWER|UNKNOWN)\),/.test(error.message.split('Described types:')[1]!), 'no deferred type is listed');
    });

    it('a described type whose protocol has no layout → E11 with the protocol named', async () => {
        const dev = {id: 'dev-1', deviceType: DeviceType.GRIP, configuration: {capabilities: {baselineErrorCheck: false}, timeSynced: null}};
        await assert.rejects(
            fieldsFor(companion([]), dev),
            (error: unknown) => error instanceof CliExit && error.code === 4 && /no field layout for this K-Grip \(GRIP, protocol not reported\)/.test(error.message),
        );
    });

    it('an empty descriptor entry is not a layout: falls back, then E11', async () => {
        await assert.rejects(
            fieldsFor(companion([{deviceId: 'dev-1', deviceType: DeviceType.EMG, mode: null, fields: []}]), device(DeviceType.EMG)),
            CliExit,
        );
    });
});

describe('unitSymbol: the one allowed mapping', () => {
    it('covers every StreamUnit member and nothing else', () => {
        assert.deepEqual(Object.keys(symbolTable()).sort(), Object.values(StreamUnit).sort());
    });

    it('the symbols', () => {
        assert.deepEqual(
            Object.values(StreamUnit).map((unit) => unitSymbol(unit)),
            ['kg', 'mbar', 'µV', '°', 'm', 'm/s', 'm/s²'],
        );
    });

    it('a unit off the wire this build does not know is shown as ?', () => {
        assert.equal(unitSymbol('FURLONG' as StreamUnit), '?');
    });
});
