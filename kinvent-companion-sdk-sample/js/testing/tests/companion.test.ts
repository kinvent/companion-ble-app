import {strict as assert} from 'node:assert';
import {describe, it} from 'node:test';
import {
    BluetoothDeviceType,
    DeltasVariantType,
    DeviceState,
    DeviceType,
    platformSideOf,
    type DeviceSnapshot,
    type FrequencySettingsSnapshot,
} from '@kinvent/companion-sdk';
import {
    assignSlots,
    ballisticFamilyOf,
    decideRate,
    deviceName,
    expectedSlots,
    familyOf,
    fillsSlot,
    noCompanionMessage,
    readyDevice,
    readyDevicesOfPlan,
    seenSummary,
    switchOnText,
    timeoutMessage,
    versionMismatchMessage,
} from '../../src/companion.js';
import {offeredTypes} from '../../src/prompts.js';

const SETTINGS: FrequencySettingsSnapshot = {
    ble5Available: false,
    families: [
        {family: 'gripMuscleLink', options: [{rate: 75}, {rate: 150}], ble5OnlyOptions: [{rate: 1000}], current: {rate: 75}},
        {family: 'plates', options: [{rate: 100}, {rate: 500}], ble5OnlyOptions: [], current: {rate: 500}},
    ],
};

describe('decideRate', () => {
    it('keeps the rate when it equals current: no call, no disconnect', () => {
        assert.deepEqual(decideRate(SETTINGS, DeviceType.GRIP, 75), {kind: 'keep', rate: 75});
        assert.deepEqual(decideRate(SETTINGS, DeviceType.PLATES, 500), {kind: 'keep', rate: 500});
    });

    it('sets the rate only when it differs from current and is offered', () => {
        assert.deepEqual(decideRate(SETTINGS, DeviceType.LINK, 150), {kind: 'set', request: {family: 'gripMuscleLink', rate: 150}});
        assert.deepEqual(decideRate(SETTINGS, DeviceType.PLATES, 100), {kind: 'set', request: {family: 'plates', rate: 100}});
    });

    it('refuses a rate that is not offered, listing the valid ones', () => {
        const decision = decideRate(SETTINGS, DeviceType.GRIP, 80);
        assert.equal(decision.kind, 'refuse');
        if (decision.kind === 'refuse') assert.match(decision.message, /80 Hz is not offered\. Valid rates for the K-Grip: 75, 150 Hz\./);
    });

    it('refuses a Bluetooth 5 rate without Bluetooth 5, and allows it with', () => {
        const without = decideRate(SETTINGS, DeviceType.GRIP, 1000);
        assert.equal(without.kind, 'refuse');
        if (without.kind === 'refuse') assert.match(without.message, /needs Bluetooth 5/);
        const withBle5 = decideRate({...SETTINGS, ble5Available: true}, DeviceType.GRIP, 1000);
        assert.deepEqual(withBle5, {kind: 'set', request: {family: 'gripMuscleLink', rate: 1000}});
    });

    it('refuses a family the companion did not list', () => {
        const decision = decideRate(SETTINGS, DeviceType.BUBBLE, 100);
        assert.equal(decision.kind, 'refuse');
        if (decision.kind === 'refuse') assert.match(decision.message, /no sampling-rate setting for the K-Bubble/);
    });

    it('every offered type has a rate family', () => {
        for (const {type} of offeredTypes()) assert.ok(familyOf(type), type);
        assert.equal(familyOf(DeviceType.HEXAS), 'deltas');
        assert.equal(familyOf(DeviceType.DELTAS_3D), 'deltas3d');
    });
});

describe('readyDevice', () => {
    const device = (id: string, state: DeviceState, inUse: boolean): DeviceSnapshot => ({
        id,
        name: '',
        deviceType: DeviceType.GRIP,
        bluetoothDeviceType: BluetoothDeviceType.KFORCE_GRIP,
        side: null,
        state,
        inUse,
        measuring: false,
    });

    it('is the in-use device in READY', () => {
        assert.equal(readyDevice([device('a', DeviceState.READY, false), device('b', DeviceState.READY, true)])?.id, 'b');
    });

    it('is undefined while the device is still initialising', () => {
        assert.equal(readyDevice([device('a', DeviceState.INITIALIZING, true)]), undefined);
        assert.equal(readyDevice([]), undefined);
    });
});

describe('messages', () => {
    it('E1 names the ladder, or the pinned port', () => {
        assert.equal(
            noCompanionMessage({host: '127.0.0.1', port: undefined}),
            'No Kinvent Companion app found on 127.0.0.1:8477–8481. Start the Kinvent Companion app, or pass `--port`.',
        );
        assert.match(noCompanionMessage({host: 'localhost', port: 9000}), /found on localhost:9000\./);
    });

    it('E2 names both versions', () => {
        assert.equal(versionMismatchMessage('2026.8.0', '2026.9.1'), 'Companion is 2026.8.0, this sample is built for 2026.9.1. Use matching versions.');
    });

    it('the scan summary counts sensors by product, once per sensor', () => {
        const seen = new Map<string, BluetoothDeviceType>([
            ['a', BluetoothDeviceType.MUSCLE_CONTROLLER],
            ['b', BluetoothDeviceType.KFORCE_GRIP],
            ['c', BluetoothDeviceType.KFORCE_GRIP],
        ]);
        assert.equal(seenSummary(seen), '1 × K-Push, 2 × K-Grip');
    });
});

// ---------------------------------------------------------------------------------------------------
// Pairs.
// ---------------------------------------------------------------------------------------------------

const BT = BluetoothDeviceType;
function snap(id: string, deviceType: DeviceType, bt: BluetoothDeviceType, state: DeviceState = DeviceState.READY, inUse = true): DeviceSnapshot {
    return {id, name: '', deviceType, bluetoothDeviceType: bt, side: platformSideOf(bt), state, inUse, measuring: false};
}

describe('The plan and its devices', () => {
    it('the fallback slots: a pair type is LEFT then RIGHT, LEFT alone with --single; other types one slot', () => {
        assert.deepEqual(expectedSlots(DeviceType.PLATES, false), [BT.PLATES_LEFT, BT.PLATES_RIGHT]);
        assert.deepEqual(expectedSlots(DeviceType.PLATES, true), [BT.PLATES_LEFT]);
        assert.deepEqual(expectedSlots(DeviceType.HEXAS, false), [BT.HEXAS_LEFT, BT.HEXAS_RIGHT]);
        assert.deepEqual(expectedSlots(DeviceType.DELTAS_3D, false), [BT.DELTAS_3D_LEFT, BT.DELTAS_3D_RIGHT]);
        assert.deepEqual(expectedSlots(DeviceType.GRIP, false), [BT.KFORCE_GRIP]);
        assert.deepEqual(expectedSlots(DeviceType.GRIP, true), [BT.KFORCE_GRIP]);
    });

    it('a slot is filled by its own type, or a compatible type on the same side (3D-Deltas in a K-Deltas slot)', () => {
        assert.ok(fillsSlot(BT.PLATES_LEFT, snap('a', DeviceType.PLATES, BT.PLATES_LEFT)));
        assert.ok(!fillsSlot(BT.PLATES_LEFT, snap('a', DeviceType.PLATES, BT.PLATES_RIGHT)), 'not the other side');
        assert.ok(fillsSlot(BT.HEXAS_RIGHT, snap('a', DeviceType.DELTAS_3D, BT.DELTAS_3D_RIGHT)));
        assert.ok(!fillsSlot(BT.HEXAS_RIGHT, snap('a', DeviceType.DELTAS_3D, BT.DELTAS_3D_LEFT)));
        assert.ok(!fillsSlot(BT.KFORCE_GRIP, snap('a', DeviceType.PLATES, BT.PLATES_LEFT)), 'another type');
        assert.ok(fillsSlot(BT.KFORCE_GRIP, snap('a', DeviceType.GRIP, BT.KFORCE_GRIP)));
    });

    it('the ready devices come back in PLAN order (left, right), whatever order the companion lists them in', () => {
        const right = snap('r', DeviceType.PLATES, BT.PLATES_RIGHT);
        const left = snap('l', DeviceType.PLATES, BT.PLATES_LEFT);
        const extra = snap('x', DeviceType.GRIP, BT.KFORCE_GRIP);
        assert.deepEqual(
            readyDevicesOfPlan([BT.PLATES_LEFT, BT.PLATES_RIGHT], [extra, right, left])?.map((device) => device.id),
            ['l', 'r'],
            'a device the plan did not ask for is ignored',
        );
        assert.equal(readyDevicesOfPlan([BT.PLATES_LEFT, BT.PLATES_RIGHT], [left]), undefined, 'one missing: not ready');
        assert.equal(
            readyDevicesOfPlan([BT.PLATES_LEFT, BT.PLATES_RIGHT], [left, snap('r', DeviceType.PLATES, BT.PLATES_RIGHT, DeviceState.INITIALIZING)]),
            undefined,
            'one not READY: not ready',
        );
        assert.equal(
            readyDevicesOfPlan([BT.PLATES_LEFT, BT.PLATES_RIGHT], [left, snap('r', DeviceType.PLATES, BT.PLATES_RIGHT, DeviceState.READY, false)]),
            undefined,
            'one not in use: not ready',
        );
        assert.deepEqual(readyDevicesOfPlan([BT.PLATES_LEFT], [right, left])?.map((device) => device.id), ['l'], '--single: LEFT only');
    });

    it('a device fills one slot at most', () => {
        const left = snap('l', DeviceType.PLATES, BT.PLATES_LEFT);
        assert.deepEqual(assignSlots([BT.PLATES_LEFT, BT.PLATES_LEFT], [left], () => true).map((device) => device?.id), ['l', undefined]);
    });

    it('names: a sided device by its Bluetooth name, any other by its product label', () => {
        assert.equal(deviceName(snap('l', DeviceType.PLATES, BT.PLATES_LEFT)), 'K-Plate Left');
        assert.equal(deviceName(snap('r', DeviceType.HEXAS, BT.HEXAS_RIGHT)), 'K-Delta Right');
        assert.equal(deviceName(snap('r', DeviceType.DELTAS_3D, BT.DELTAS_3D_RIGHT)), '3D Delta Right');
        assert.equal(deviceName(snap('b', DeviceType.BUBBLE, BT.BUBBLE)), 'K-Bubble', 'the label, not the Bluetooth name "k-Bubble"');
        assert.equal(switchOnText(DeviceType.PLATES, [BT.PLATES_LEFT, BT.PLATES_RIGHT]), 'K-Plate Left and K-Plate Right');
        assert.equal(switchOnText(DeviceType.PLATES, [BT.PLATES_LEFT]), 'K-Plate Left');
        assert.equal(switchOnText(DeviceType.GRIP, [BT.KFORCE_GRIP]), 'K-Grip');
    });
});

describe('The timeout message (E5)', () => {
    const base = {seconds: 60, seen: new Map<string, BluetoothDeviceType>(), single: false};

    it('one plate connected: names what connected and what is missing, and offers --single when the RIGHT one is missing', () => {
        const message = timeoutMessage({
            ...base,
            type: DeviceType.PLATES,
            slots: [BT.PLATES_LEFT, BT.PLATES_RIGHT],
            devices: [snap('l', DeviceType.PLATES, BT.PLATES_LEFT, DeviceState.CONNECTED)],
        });
        assert.equal(
            message,
            [
                'K-Plate Left connected; waiting for K-Plate Right.',
                'No K-Plate Right connected in 60 s. Is it switched on and charged? Is another app connected to it?',
                'To record the K-Plate Left alone, run again with --single.',
            ].join('\n'),
        );
    });

    it('only the RIGHT one connected: no --single hint (--single keeps the left one)', () => {
        const message = timeoutMessage({
            ...base,
            type: DeviceType.PLATES,
            slots: [BT.PLATES_LEFT, BT.PLATES_RIGHT],
            devices: [snap('r', DeviceType.PLATES, BT.PLATES_RIGHT, DeviceState.INITIALIZING)],
        });
        assert.match(message, /^K-Plate Right connected; waiting for K-Plate Left\.\nNo K-Plate Left connected in 60 s\./);
        assert.doesNotMatch(message, /--single/);
    });

    it('none connected: the sentence with both names', () => {
        assert.equal(
            timeoutMessage({...base, type: DeviceType.HEXAS, slots: [BT.HEXAS_LEFT, BT.HEXAS_RIGHT], devices: []}),
            'No K-Deltas connected in 60 s (waiting for K-Delta Left and K-Delta Right). Is it switched on and charged? Is it a K-Deltas? Is another app connected to it?',
        );
    });

    it('--single and only a right plate nearby: says the right one cannot be used alone', () => {
        const seen = new Map<string, BluetoothDeviceType>([['r', BT.PLATES_RIGHT]]);
        const message = timeoutMessage({...base, single: true, seen, type: DeviceType.PLATES, slots: [BT.PLATES_LEFT], devices: []});
        assert.equal(
            message,
            [
                'No K-Plates connected in 60 s (waiting for K-Plate Left). Is it switched on and charged? Is it a K-Plates? Is another app connected to it?',
                'Seen nearby: 1 × K-Plate Right.',
                'With --single only the left sensor (K-Plate Left) can be used.',
            ].join('\n'),
        );
    });

    it('one sensor: the one-sensor sentence', () => {
        assert.equal(
            timeoutMessage({...base, type: DeviceType.GRIP, slots: [BT.KFORCE_GRIP], devices: []}),
            'No K-Grip connected in 60 s. Is it switched on and charged? Is it a K-Grip? Is another app connected to it?',
        );
    });
});

describe('The ballistic rate families (for the jump test)', () => {
    const hexas = (deltasVariant?: DeltasVariantType): Pick<DeviceSnapshot, 'deviceType' | 'configuration'> => ({
        deviceType: DeviceType.HEXAS,
        configuration: {capabilities: {baselineErrorCheck: false}, timeSynced: null, ...(deltasVariant === undefined ? {} : {deltasVariant})},
    });
    it('K-Deltas: CLASSIC (XL) → deltasXlBallistic, MINI → deltasMiniBallistic, unknown variant → none', () => {
        assert.equal(ballisticFamilyOf(hexas(DeltasVariantType.CLASSIC)), 'deltasXlBallistic');
        assert.equal(ballisticFamilyOf(hexas(DeltasVariantType.MINI)), 'deltasMiniBallistic');
        assert.equal(ballisticFamilyOf(hexas()), undefined);
        assert.equal(ballisticFamilyOf(hexas(DeltasVariantType.TRIDEL)), undefined);
    });
    it('plates and 3D-Deltas have none; their plain family stays', () => {
        assert.equal(ballisticFamilyOf({deviceType: DeviceType.PLATES}), undefined);
        assert.equal(ballisticFamilyOf({deviceType: DeviceType.DELTAS_3D}), undefined);
        assert.equal(familyOf(DeviceType.PLATES), 'plates');
    });
});
