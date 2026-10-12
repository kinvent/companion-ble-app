/**
 * The live view's formatting: names left-aligned, values right-aligned on
 * a fixed width with the unit's decimals, the unit symbol AFTER the value with one space, the non-TTY
 * fallback without escape codes, and zero samples.
 */
import {strict as assert} from 'node:assert';
import {describe, it} from 'node:test';
import {StreamUnit, type StreamField} from '@kinvent/companion-sdk';
import {
    ansiRedraw,
    decimalsFor,
    fieldLines,
    formatValue,
    headerLine,
    LiveView,
    lossText,
    renderBlock,
    renderMultiBlock,
    renderMultiSingleLine,
    renderSingleLine,
    VALUE_WIDTH,
    type DeviceLiveState,
    type LiveState,
    type MultiLiveState,
} from '../../src/render.js';
import {ManualClock} from '../doubles/manualClock.js';

const PLATES: StreamField[] = [
    {index: 0, name: 'force1', unit: StreamUnit.KILOGRAM},
    {index: 1, name: 'force2', unit: StreamUnit.KILOGRAM},
    {index: 2, name: 'force3', unit: StreamUnit.KILOGRAM},
    {index: 3, name: 'force4', unit: StreamUnit.KILOGRAM},
];

function state(overrides: Partial<LiveState> = {}): LiveState {
    return {
        title: 'K-Plates (PLATES)',
        fields: PLATES,
        setRate: {hz: 75, source: 'device configuration'},
        measuredHz: 74.6,
        samples: 150,
        elapsedMs: 2000,
        totalMs: 5000,
        channels: [12.3456, 0.41, -3.0567, 1234.5],
        gapEvents: 0,
        missedFrames: 0,
        lossEvents: 0,
        lostFrames: 0,
        ...overrides,
    };
}

describe('field lines', () => {
    it('the stored block: name left, value right-aligned with 2 decimals, unit after one space', () => {
        assert.deepEqual(fieldLines(PLATES, [12.3456, 0.41, -3.0567, 1234.5]), [
            '  force1       12.35 kg',
            '  force2        0.41 kg',
            '  force3       -3.06 kg',
            '  force4     1234.50 kg',
        ]);
    });

    it('every value ends in the same column, so the decimal points line up (negative and ≥ 1000 included)', () => {
        const lines = fieldLines(PLATES, [5, -99999.994, 1000, 0]);
        const unitColumn = lines.map((line) => line.lastIndexOf(' kg'));
        assert.equal(new Set(unitColumn).size, 1, lines.join('\n'));
        const points = lines.map((line) => line.lastIndexOf('.'));
        assert.equal(new Set(points).size, 1, 'decimal points aligned');
    });

    it('the unit is to the RIGHT of the value', () => {
        for (const line of fieldLines(PLATES, [1, 2, 3, 4])) {
            assert.match(line, /^ {2}force\d {2} +-?\d+\.\d{2} kg$/);
        }
    });

    it('names of different lengths are padded to the longest; the value column does not move', () => {
        const fields: StreamField[] = [
            {index: 0, name: 'force1', unit: StreamUnit.KILOGRAM},
            {index: 4, name: 'forceX1', unit: StreamUnit.KILOGRAM},
        ];
        const lines = fieldLines(fields, [1, 2, 3, 4, 5.5]);
        assert.deepEqual(lines, ['  force1         1.00 kg', '  forceX1        5.50 kg']);
        assert.equal(lines[0]!.length, lines[1]!.length);
    });

    it('reads channels[field.index], not the position in the table', () => {
        const fields: StreamField[] = [{index: 2, name: 'pressure', unit: StreamUnit.MILLIBAR}];
        assert.deepEqual(fieldLines(fields, [9, 9, 1013.256, 9]), ['  pressure     1013.26 mbar']);
    });

    it('zero samples: -- in the value column, unit still shown', () => {
        assert.deepEqual(fieldLines(PLATES.slice(0, 1), undefined), ['  force1          -- kg']);
    });

    it('a channel the frame does not have is --, never another slot', () => {
        assert.deepEqual(fieldLines([{index: 5, name: 'force6', unit: StreamUnit.KILOGRAM}], [1, 2, 3, 4]), ['  force6          -- kg']);
    });
});

describe('formatValue and decimals', () => {
    it('2 decimals for kg and mbar; the documented choice for the others', () => {
        assert.equal(decimalsFor(StreamUnit.KILOGRAM), 2);
        assert.equal(decimalsFor(StreamUnit.MILLIBAR), 2);
        assert.equal(formatValue(1.005, StreamUnit.MICROVOLT), '1.0');
        assert.equal(formatValue(12.345, StreamUnit.DEGREE), '12.3');
        assert.equal(formatValue(1.23456, StreamUnit.METER), '1.235');
        assert.equal(formatValue(1.234, StreamUnit.METER_PER_SECOND), '1.23');
        assert.equal(formatValue(9.80665, StreamUnit.METER_PER_SECOND_SQUARED), '9.81');
    });

    it('every StreamUnit member has a decimals value', () => {
        for (const unit of Object.values(StreamUnit)) {
            assert.ok(Number.isInteger(decimalsFor(unit)), unit);
        }
    });

    it('never shows -0.00; NaN and Infinity are --', () => {
        assert.equal(formatValue(-0.001, StreamUnit.KILOGRAM), '0.00');
        assert.equal(formatValue(-0, StreamUnit.KILOGRAM), '0.00');
        assert.equal(formatValue(Number.NaN, StreamUnit.KILOGRAM), '--');
        assert.equal(formatValue(Number.POSITIVE_INFINITY, StreamUnit.KILOGRAM), '--');
    });

    it('a value wider than the column is shown whole, not cut', () => {
        const text = formatValue(123456789.5, StreamUnit.KILOGRAM);
        assert.equal(text, '123456789.50');
        assert.ok(text.length > VALUE_WIDTH);
    });
});

describe('the block', () => {
    it('header: title, set rate with its source, measured rate, count, elapsed and left', () => {
        assert.equal(
            headerLine(state()),
            'K-Plates (PLATES)  ·  75 Hz set (device configuration)  ·  75 Hz measured  ·  150 samples  ·  2.0 s elapsed, 3.0 s left',
        );
        assert.match(headerLine(state({setRate: {hz: undefined, source: undefined}})), /set rate unknown/);
    });

    it('header, fields, and a loss line only when something was lost', () => {
        assert.equal(renderBlock(state()).length, 1 + PLATES.length);
        const lossy = renderBlock(state({gapEvents: 1, missedFrames: 2, lossEvents: 1, lostFrames: 5}));
        assert.equal(lossy.length, 2 + PLATES.length);
        assert.equal(lossy.at(-1), '  data loss: 1 gap on the stream (2 frames missed), 1 drop by the companion (5 frames lost)');
        assert.equal(lossText(state()), undefined);
    });

    it('zero samples renders', () => {
        const lines = renderBlock(state({samples: 0, channels: undefined, measuredHz: 0, elapsedMs: 0}));
        assert.match(lines[0]!, /0 Hz measured {2}· {2}0 samples {2}· {2}0\.0 s elapsed, 5\.0 s left/);
        assert.ok(lines.slice(1).every((line) => line.endsWith('-- kg')));
    });
});

describe('terminal and plain output', () => {
    it('ansiRedraw: cursor up over the previous block, clear each line', () => {
        assert.equal(ansiRedraw(0, ['a', 'b']), '\r\u001b[2Ka\n\r\u001b[2Kb\n');
        assert.equal(ansiRedraw(2, ['a', 'b']), '\u001b[2A\r\u001b[2Ka\n\r\u001b[2Kb\n');
    });

    it('the non-TTY line has no escape code and carries every field with its unit after the value', () => {
        const text = renderSingleLine(state({gapEvents: 1, missedFrames: 1}));
        assert.ok(!text.includes('\u001b'));
        assert.equal(
            text,
            '2.0/5.0 s  |  75 Hz set (device configuration)  |  75 Hz measured  |  150 samples  |  force1 12.35 kg  |  force2 0.41 kg  |  force3 -3.06 kg  |  force4 1234.50 kg  |  data loss: 1 gap on the stream (1 frame missed)',
        );
    });

    it('LiveView on a terminal: redraws in place, at most every 100 ms', async () => {
        const clock = new ManualClock();
        let written = '';
        const view = new LiveView({write: (text) => void (written += text)}, true, clock);
        view.update(state());
        assert.ok(!written.includes('\u001b[5A'), 'the first draw moves nothing up');
        const first = written;
        view.update(state());
        assert.equal(written, first, 'throttled');
        await clock.advance(100);
        view.update(state());
        assert.ok(written.slice(first.length).startsWith('\u001b[5A'), 'the second draw goes back up over 5 lines');
    });

    it('LiveView without a terminal: one plain line per second, and the final state on finish', async () => {
        const clock = new ManualClock();
        const lines: string[] = [];
        const view = new LiveView({write: (text) => void lines.push(text)}, false, clock);
        view.update(state());
        await clock.advance(500);
        view.update(state());
        assert.equal(lines.length, 1);
        await clock.advance(500);
        view.update(state());
        view.finish(state({samples: 375}));
        assert.equal(lines.length, 3);
        assert.ok(lines.every((line) => !line.includes('\u001b') && line.endsWith('\n')));
        assert.match(lines.at(-1)!, /375 samples/);
    });
});

describe('The multi-device view', () => {
    const device = (title: string, over: Partial<DeviceLiveState> = {}): DeviceLiveState => ({
        title,
        fields: PLATES.slice(0, 1),
        setRate: {hz: 75, source: 'device configuration'},
        measuredHz: 74.6,
        samples: 150,
        channels: [12.3456],
        gapEvents: 0,
        missedFrames: 0,
        lossEvents: 0,
        lostFrames: 0,
        ...over,
    });
    const multi = (over: Partial<MultiLiveState> = {}): MultiLiveState => ({
        title: 'K-Plates (PLATES)',
        elapsedMs: 2000,
        totalMs: 5000,
        devices: [device('K-Plate Left'), device('K-Plate Right', {samples: 148, channels: [3.1], gapEvents: 1, missedFrames: 2})],
        ...over,
    });

    it('the stored block: the time once, then per device its title, rates, count, fields with units, loss note', () => {
        assert.deepEqual(renderMultiBlock(multi()), [
            'K-Plates (PLATES)  ·  2 devices  ·  2.0 s elapsed, 3.0 s left',
            '  K-Plate Left  ·  75 Hz set (device configuration)  ·  75 Hz measured  ·  150 samples',
            '    force1       12.35 kg',
            '  K-Plate Right  ·  75 Hz set (device configuration)  ·  75 Hz measured  ·  148 samples',
            '    force1        3.10 kg',
            '    data loss: 1 gap on the stream (2 frames missed)',
        ]);
        assert.equal(renderMultiBlock(multi()).filter((line) => line.includes('elapsed')).length, 1, 'the time is shown once');
    });

    it('the plain line: the time once, each device after a bar, no escape code', () => {
        const text = renderMultiSingleLine(multi());
        assert.equal(
            text,
            '2.0/5.0 s  |  K-Plate Left: 75 Hz set (device configuration), 75 Hz measured, 150 samples, force1 12.35 kg  |  ' +
                'K-Plate Right: 75 Hz set (device configuration), 75 Hz measured, 148 samples, force1 3.10 kg, data loss: 1 gap on the stream (2 frames missed)',
        );
        assert.ok(!text.includes('\u001b'));
    });

    it('LiveView draws the multi-device state on a terminal and as a plain line', () => {
        const clock = new ManualClock();
        let tty = '';
        new LiveView({write: (text) => (tty += text)}, true, clock).finish(multi());
        assert.match(tty, /K-Plate Right {2}· {2}75 Hz set/);
        let plain = '';
        new LiveView({write: (text) => (plain += text)}, false, clock).finish(multi());
        assert.match(plain, /^2\.0\/5\.0 s {2}\| {2}K-Plate Left: /);
    });
});
