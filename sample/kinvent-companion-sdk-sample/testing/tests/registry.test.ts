/**
 * The sensors used last time (`src/registry.ts`): what is remembered, in which order it is handed back, and that a
 * file that is missing, foreign or unwritable never stops a run.
 */
import {strict as assert} from 'node:assert';
import {mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, describe, it} from 'node:test';
import {BluetoothDeviceType, DeviceState, DeviceType, type DeviceSnapshot} from '@kinvent/companion-sdk';
import {forgetDevices, readRegistered, rememberDevices} from '../../src/registry.js';

const SCRATCH = mkdtempSync(join(tmpdir(), 'cli-sample-registry-'));
after(() => rmSync(SCRATCH, {recursive: true, force: true}));
let files = 0;
const fresh = (): string => join(SCRATCH, `registry-${++files}.json`);

const snapshot = (id: string, name: string, side: 'LEFT' | 'RIGHT'): DeviceSnapshot => ({
    id,
    name,
    deviceType: DeviceType.HEXAS,
    bluetoothDeviceType: side === 'LEFT' ? BluetoothDeviceType.HEXAS_LEFT : BluetoothDeviceType.HEXAS_RIGHT,
    side,
    state: DeviceState.READY,
    inUse: true,
    measuring: false,
});

describe('registry: the sensors used last time', () => {
    it('nothing remembered: an empty plan, and no file is created by reading', () => {
        const path = fresh();
        assert.deepEqual(readRegistered(path, DeviceType.HEXAS), []);
        assert.throws(() => readFileSync(path));
    });

    it('a pair is handed back LEFT first with ascending connectionOrder, as the plan wants it', () => {
        const path = fresh();
        rememberDevices(path, DeviceType.HEXAS, [snapshot('r1', 'Example Deltas R', 'RIGHT'), snapshot('l1', 'Example Deltas L', 'LEFT')]);
        assert.deepEqual(readRegistered(path, DeviceType.HEXAS), [
            {deviceId: 'l1', deviceName: 'Example Deltas L', deviceType: DeviceType.HEXAS, connectionOrder: 1},
            {deviceId: 'r1', deviceName: 'Example Deltas R', deviceType: DeviceType.HEXAS, connectionOrder: 2},
        ]);
        assert.deepEqual(readRegistered(path, DeviceType.PLATES), [], 'per type');
        assert.deepEqual(
            readRegistered(path, DeviceType.HEXAS, true).map((entry) => entry.deviceId),
            ['l1'],
            'a single (monopodal) run wants the LEFT one only',
        );
    });

    it('a single sensor replaces its own side only; a sensor without a name is not stored; forget empties the type', () => {
        const path = fresh();
        rememberDevices(path, DeviceType.HEXAS, [snapshot('l1', 'Example Deltas L', 'LEFT'), snapshot('r1', 'Example Deltas R', 'RIGHT')]);
        rememberDevices(path, DeviceType.HEXAS, [snapshot('l2', 'Example Deltas L-2', 'LEFT')]);
        assert.deepEqual(
            readRegistered(path, DeviceType.HEXAS).map((entry) => entry.deviceId),
            ['l2', 'r1'],
        );
        rememberDevices(path, DeviceType.HEXAS, [snapshot('l3', '', 'LEFT'), snapshot('r3', 'Example Deltas R-3', 'RIGHT')]);
        assert.deepEqual(readRegistered(path, DeviceType.HEXAS).map((entry) => entry.deviceId), ['r3'], 'the unnamed LEFT is dropped, not kept from before either');
        forgetDevices(path, DeviceType.HEXAS);
        assert.deepEqual(readRegistered(path, DeviceType.HEXAS), []);
    });

    it('a foreign or broken file reads as empty and is replaced on the next write', () => {
        const path = fresh();
        writeFileSync(path, '{not json');
        assert.deepEqual(readRegistered(path, DeviceType.HEXAS), []);
        rememberDevices(path, DeviceType.HEXAS, [snapshot('l1', 'Example Deltas L', 'LEFT')]);
        assert.equal(readRegistered(path, DeviceType.HEXAS).length, 1);
        assert.equal((JSON.parse(readFileSync(path, 'utf8')) as {version: number}).version, 1);
    });
});
