import {strict as assert} from 'node:assert';
import {describe, it} from 'node:test';
import {DeviceType} from '@kinvent/companion-sdk';
import {parseSeconds} from '../../src/args.js';
import {
    AnswerRequired,
    askDeviceType,
    askSeconds,
    askSingle,
    BadFlagValue,
    isPairType,
    parseYesNo,
    InputClosed,
    labelOf,
    offeredTypes,
    parseDeviceChoice,
    type LineReader,
} from '../../src/prompts.js';

/** A reader that answers from a script; `undefined` in the script means Ctrl-D. */
function scripted(answers: Array<string | undefined>): LineReader & {asked: string[]} {
    const queue = [...answers];
    const asked: string[] = [];
    return {
        asked,
        ask(prompt: string): Promise<string | undefined> {
            asked.push(prompt);
            if (queue.length === 0) throw new Error(`no scripted answer left for: ${prompt}`);
            return Promise.resolve(queue.shift());
        },
    };
}

function sink(): {write(text: string): void; text(): string} {
    let all = '';
    return {write: (text) => (all += text), text: () => all};
}

const FORCE = [
    DeviceType.GRIP,
    DeviceType.MUSCLE_TESTER,
    DeviceType.PLATES,
    DeviceType.BUBBLE,
    DeviceType.LINK,
    DeviceType.HEXAS,
    DeviceType.DELTAS_3D,
];

describe('offeredTypes', () => {
    it('offers exactly the seven force types, in the order of the SDK enum', () => {
        assert.deepEqual(
            offeredTypes().map((entry) => entry.type),
            FORCE,
        );
    });

    it('never offers UNKNOWN, KPOWER, SENS or EMG', () => {
        const types = offeredTypes().map((entry) => entry.type);
        for (const no of [DeviceType.UNKNOWN, DeviceType.KPOWER, DeviceType.SENS, DeviceType.EMG]) assert.ok(!types.includes(no), no);
    });

    it('labels are the product names; K-Myo keeps its label for E11', () => {
        assert.equal(offeredTypes().find((entry) => entry.type === DeviceType.MUSCLE_TESTER)?.label, 'K-Push');
        assert.equal(labelOf(DeviceType.EMG), 'K-Myo');
    });
});

describe('parseDeviceChoice', () => {
    const offered = offeredTypes();

    it('accepts a number in range', () => {
        assert.deepEqual(parseDeviceChoice('1', offered), {ok: true, type: DeviceType.GRIP});
        assert.deepEqual(parseDeviceChoice(' 7 ', offered), {ok: true, type: DeviceType.DELTAS_3D});
    });

    it('accepts an enum name in any case', () => {
        assert.deepEqual(parseDeviceChoice('plates', offered), {ok: true, type: DeviceType.PLATES});
        assert.deepEqual(parseDeviceChoice('Muscle_Tester', offered), {ok: true, type: DeviceType.MUSCLE_TESTER});
    });

    it('refuses numbers out of range, signs and decimals with the range message', () => {
        for (const text of ['0', '8', '-1', '1.5', '', '   ']) {
            const result = parseDeviceChoice(text, offered);
            assert.equal(result.ok, false, text);
            if (!result.ok) assert.match(result.message, /Please type a number from 1 to 7\./, text);
        }
    });

    it('refuses UNKNOWN, KPOWER and SENS as not offered', () => {
        for (const text of ['UNKNOWN', 'kpower', 'SENS']) {
            const result = parseDeviceChoice(text, offered);
            assert.equal(result.ok, false, text);
            if (!result.ok) assert.match(result.message, /is not offered by this sample/, text);
        }
    });

    it('refuses EMG, saying why', () => {
        const result = parseDeviceChoice('emg', offered);
        assert.equal(result.ok, false);
        if (!result.ok) assert.match(result.message, /EMG \(K-Myo\) is not offered: the companion does not describe its live values yet\. Please type a number from 1 to 7\./);
    });

    it('refuses a name that is no device type', () => {
        const result = parseDeviceChoice('toaster', offered);
        assert.equal(result.ok, false);
        if (!result.ok) assert.match(result.message, /Unknown device type "toaster"/);
    });
});

describe('askDeviceType', () => {
    it('--device skips the prompt and is validated by the same rule', async () => {
        const reader = scripted([]);
        assert.equal(await askDeviceType('plates', {reader, out: sink()}), DeviceType.PLATES);
        assert.deepEqual(reader.asked, []);
        await assert.rejects(askDeviceType('KPOWER', {reader, out: sink()}), BadFlagValue);
        await assert.rejects(askDeviceType('EMG', {reader, out: sink()}), /EMG \(K-Myo\) is not offered/);
    });

    it('shows the menu, re-asks on bad input, accepts the first valid answer', async () => {
        const out = sink();
        const reader = scripted(['', '9', 'kpower', '3']);
        assert.equal(await askDeviceType(undefined, {reader, out}), DeviceType.PLATES);
        assert.equal(reader.asked.length, 4);
        assert.match(out.text(), /1\. K-Grip \(GRIP\)/);
        assert.match(out.text(), /7\. K-Deltas 3D \(DELTAS_3D\)/);
        assert.doesNotMatch(out.text(), /K-Myo/);
        assert.equal((out.text().match(/Please type a number from 1 to 7\./g) ?? []).length, 3);
    });

    it('Ctrl-D at the question is InputClosed', async () => {
        await assert.rejects(askDeviceType(undefined, {reader: scripted([undefined]), out: sink()}), InputClosed);
    });

    it('no terminal and no --device is AnswerRequired, naming the flag', async () => {
        await assert.rejects(askDeviceType(undefined, {reader: undefined, out: sink()}), (error: unknown) => {
            assert.ok(error instanceof AnswerRequired);
            assert.equal(error.flag, '--device');
            return true;
        });
    });
});

describe('askSeconds', () => {
    it('--seconds skips the prompt', async () => {
        const reader = scripted([]);
        assert.equal(await askSeconds(30, {reader, out: sink()}), 30);
        assert.deepEqual(reader.asked, []);
    });

    it('re-asks with parseSeconds messages until valid', async () => {
        const out = sink();
        const reader = scripted(['abc', '0', '1.5', '3601', ' 30 ']);
        assert.equal(await askSeconds(undefined, {reader, out}), 30);
        assert.equal(reader.asked.length, 5);
        assert.match(reader.asked[0]!, /Recording time in seconds \(1–3600\)/);
        assert.match(out.text(), /Please type a whole number\./);
        assert.match(out.text(), /Please type a number from 1 to 3600\./);
    });

    it('uses the same rule as the flag parser', () => {
        for (const text of ['1', '30', '3600', ' 30 ']) assert.equal(typeof parseSeconds(text), 'number', text);
        for (const text of ['0', '-1', '3601', '1.5', '1e3', 'abc', '']) assert.equal(typeof parseSeconds(text), 'string', text);
    });

    it('Ctrl-D is InputClosed; no terminal is AnswerRequired', async () => {
        await assert.rejects(askSeconds(undefined, {reader: scripted([undefined]), out: sink()}), InputClosed);
        await assert.rejects(askSeconds(undefined, {reader: undefined, out: sink()}), /--seconds is required/);
    });
});

describe('The --single question', () => {
    it('pair types are K-Plates, K-Deltas and K-Deltas 3D', () => {
        assert.deepEqual(
            offeredTypes().filter(({type}) => isPairType(type)).map(({type}) => type),
            [DeviceType.PLATES, DeviceType.HEXAS, DeviceType.DELTAS_3D],
        );
    });

    it('not a pair type: false, nothing asked', async () => {
        const reader = scripted([]);
        assert.equal(await askSingle(false, DeviceType.GRIP, {reader, out: sink()}), false);
        assert.deepEqual(reader.asked, []);
    });

    it('--single: true, nothing asked', async () => {
        const reader = scripted([]);
        assert.equal(await askSingle(true, DeviceType.PLATES, {reader, out: sink()}), true);
        assert.deepEqual(reader.asked, []);
    });

    it('no terminal: the default, a pair', async () => {
        assert.equal(await askSingle(false, DeviceType.PLATES, {reader: undefined, out: sink()}), false);
    });

    it('at a terminal: "Use a single plate? [y/N]"; y is single, empty is the pair, anything else asks again', async () => {
        const out = sink();
        const reader = scripted(['maybe', 'Y']);
        assert.equal(await askSingle(false, DeviceType.PLATES, {reader, out}), true);
        assert.deepEqual(reader.asked, ['Use a single plate? [y/N] ', 'Use a single plate? [y/N] ']);
        assert.match(out.text(), /Please type y or n\./);
        assert.equal(await askSingle(false, DeviceType.HEXAS, {reader: scripted(['']), out: sink()}), false);
        await assert.rejects(askSingle(false, DeviceType.DELTAS_3D, {reader: scripted([undefined]), out: sink()}), InputClosed);
    });

    it('parseYesNo', () => {
        assert.equal(parseYesNo(' yes '), true);
        assert.equal(parseYesNo('n'), false);
        assert.equal(parseYesNo(''), false);
        assert.equal(parseYesNo('x'), undefined);
    });
});
