/**
 * The recorder: the CSV layout byte for byte, the cell
 * encoding of the Kinvent CSV exports, the Summary and its end reasons, no overwrite, the
 * file and folder modes, back-pressure and a failing disk. Every value is synthetic.
 */
import {strict as assert} from 'node:assert';
import {existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Writable} from 'node:stream';
import {after, describe, it} from 'node:test';
import {StreamUnit, type ForceSample, type StreamField} from '@kinvent/companion-sdk';
import {
    bytesPerRow,
    csvNum,
    csvRow,
    csvText,
    deviceCell,
    estimateBytes,
    fileBaseName,
    formatChannel,
    formatMeasuredRate,
    formatSeconds,
    formatTimeOfDayMs,
    measuredRateHz,
    openFileSink,
    Recorder,
    RecorderWriteError,
    sampleLine,
    SIZE_WARNING_BYTES,
    type DeviceFacts,
    type OpenSink,
    type RecordingFacts,
} from '../../src/recorder.js';
import {findRow, parseCsv, sampleRows, summaryValue, values} from '../doubles/rfc4180.js';

const SCRATCH = mkdtempSync(join(tmpdir(), 'cli-sample-recorder-'));
after(() => rmSync(SCRATCH, {recursive: true, force: true}));
let folderCount = 0;
const freshFolder = (): string => join(SCRATCH, `run-${++folderCount}`);

/** 2026-10-07 10:15:30.123, LOCAL time, so the expected strings do not depend on the machine's zone. */
const FIXED = new Date(2026, 9, 7, 10, 15, 30, 123).getTime();

const TWO_FIELDS: StreamField[] = [
    {index: 0, name: 'force1', unit: StreamUnit.KILOGRAM},
    {index: 1, name: 'force2', unit: StreamUnit.KILOGRAM},
];

const facts = (over: Partial<RecordingFacts> = {}): RecordingFacts => ({
    sampleVersion: '2026.9.1',
    companionVersion: '2026.9.1',
    sdkVersion: '2026.9.1',
    deviceType: 'MUSCLE_TESTER',
    deviceTitle: 'K-Push',
    seconds: 5,
    sampleRateHz: 75,
    countdownSeconds: 3,
    fields: TWO_FIELDS,
    ...over,
});

const sample = (timeStamp: number, channels: number[], isTimeStampFromEpoch = false): ForceSample => ({timeStamp, isTimeStampFromEpoch, channels});

function recorder(folder = freshFolder(), openSink?: OpenSink): Recorder {
    return new Recorder({folder, cwd: SCRATCH, now: () => FIXED, ...(openSink === undefined ? {} : {openSink})});
}

describe('recorder: cell encoding', () => {
    it('a text cell is quoted, inner quotes doubled', () => {
        assert.equal(csvText('Session Date'), '"Session Date"');
        assert.equal(csvText('He said "hi"'), '"He said ""hi"""');
        assert.equal(csvText(''), '""');
        assert.equal(csvText(undefined), '""');
    });

    it('a leading = + - @ TAB CR is guarded with an apostrophe; a dash-only cell is not', () => {
        assert.equal(csvText('=SUM(A1:A2)'), `"'=SUM(A1:A2)"`);
        assert.equal(csvText('=say "x"'), `"'=say ""x"""`);
        assert.equal(csvText('+1'), `"'+1"`);
        assert.equal(csvText('-5'), `"'-5"`);
        assert.equal(csvText('@cmd'), `"'@cmd"`);
        assert.equal(csvText('\tx'), `"'\tx"`);
        assert.equal(csvText('\rx'), `"'\rx"`);
        assert.equal(csvText('-'), '"-"');
        assert.equal(csvText('---'), '"---"');
        assert.equal(csvText('–'), '"–"');
        assert.equal(csvText('a=b'), '"a=b"', 'only a LEADING trigger is guarded');
    });

    it('a numeric cell is raw: never quoted, never guarded', () => {
        assert.equal(csvNum(-1.5), '-1.5');
        assert.equal(csvNum('0.300000000000000'), '0.300000000000000');
        assert.equal(csvNum(0), '0');
        assert.equal(csvRow([csvText('Rows'), csvNum(12)]), '"Rows",12');
    });

    it('time: (timeStamp - first) / 1000 as a plain decimal; values: toFixed(15), no conversion', () => {
        assert.equal(formatSeconds(1000, 1000), '0');
        assert.equal(formatSeconds(1010, 1000), '0.01');
        assert.equal(formatSeconds(2500, 1000), '1.5');
        assert.equal(formatChannel(0.1 + 0.2), '0.300000000000000');
        assert.equal(formatChannel(-12.345), '-12.345000000000001');
        assert.equal(formatChannel(undefined), '', 'a slot the frame does not carry is an empty cell');
        assert.equal(sampleLine(TWO_FIELDS, sample(1010, [1.5, -2]), 1000), '0.01,1.500000000000000,-2.000000000000000');
    });

    it('the file name: device type and local time only, -n when taken', () => {
        assert.equal(fileBaseName('PLATES', new Date(FIXED)), 'PLATES-20261007-101530.csv');
        assert.equal(fileBaseName('PLATES', new Date(FIXED), 3), 'PLATES-20261007-101530-3.csv');
    });

    it('the serial is in the device cell only when given (--include-serial)', () => {
        assert.equal(deviceCell({deviceTitle: 'K-Push'}), 'K-Push');
        assert.equal(deviceCell({deviceTitle: 'K-Push', serialCode: 'SYN-0001'}), 'K-Push (serial SYN-0001)');
        assert.equal(deviceCell({deviceTitle: 'K-Push', serialCode: null}), 'K-Push (serial not reported)');
    });
});

describe('recorder: the measured rate', () => {
    it('(rows - 1) / (last - first): two rows, one row, no time span', () => {
        assert.equal(measuredRateHz(2, 0, 0.01), 100);
        assert.equal(measuredRateHz(1, 0, 0), undefined, 'one row: no interval to measure');
        assert.equal(measuredRateHz(0, 0, 0), undefined);
        assert.equal(measuredRateHz(3, 1, 1), undefined, 'rows that span no time: no rate');
        assert.equal(measuredRateHz(3, 2, 2.5), 4, 'the first time need not be 0');
    });

    it('a device that sends faster than its set rate: 751 rows from 0 to 10 s is 75.0 Hz', () => {
        const hz = measuredRateHz(751, 0, 10)!;
        assert.equal(formatMeasuredRate(hz), '75.0');
        assert.ok(Math.abs(hz - 750 / 10) < 1e-12);
    });

    it('the Summary row: one decimal, raw; "-" as a text cell when there is no rate', async () => {
        const rec = recorder();
        const path = await rec.open(facts());
        await rec.append([sample(0, [1, 2])]);
        const result = await rec.end('time end');
        const text = readFileSync(path, 'utf8');
        assert.ok(text.includes('"Rows",1\n"Sample rate measured (Hz)","-"\n"Samples lost",0\n'), text);
        assert.equal(result.measuredHz, undefined);
    });
});

describe('recorder: the file', () => {
    it('golden: preamble, table head, rows and Summary, byte for byte', async () => {
        const rec = recorder();
        const path = await rec.open(facts());
        await rec.append([sample(1000, [1.5, 0.1 + 0.2, 9]), sample(1010, [-2, 0])]);
        await rec.append([sample(1020, [3.25, 1e-16])]);
        const result = await rec.end('time end', {samplesLost: 5, gaps: 1});
        const expected = [
            '"Kinvent Companion SDK sample 2026.9.1","Companion 2026.9.1","companion-sdk 2026.9.1","Devices:","K-Push"',
            '"Session Date","2026-10-07"',
            '"Session Time","10:15:30"',
            '"Configuration"',
            '"Device type","MUSCLE_TESTER"',
            '"Recording time (sec)",5',
            '"Sample rate set (Hz)",75',
            '"Countdown (sec)",3',
            '"Channels"',
            '"Column","Field","Unit","Unit code"',
            '"CHANNEL_1","force1","kg","KILOGRAM"',
            '"CHANNEL_2","force2","kg","KILOGRAM"',
            '',
            '"Raw Channel Data"',
            '"Time at time zero","10:15:30:123"',
            '"","K-Push",""',
            '"Time (sec)","CHANNEL_1","CHANNEL_2"',
            '0,1.500000000000000,0.300000000000000',
            '0.01,-2.000000000000000,0.000000000000000',
            '0.02,3.250000000000000,0.000000000000000',
            '',
            '"Summary"',
            '"Rows",3',
            '"Sample rate measured (Hz)",100.0',
            '"Samples lost",5',
            '"Gaps",1',
            '"End reason","time end"',
            '',
        ].join('\n');
        const bytes = readFileSync(path);
        assert.equal(bytes.toString('utf8'), expected);
        assert.notDeepEqual([...bytes.subarray(0, 3)], [0xef, 0xbb, 0xbf], 'no byte-order mark');
        assert.equal(bytes[0], 0x22, 'the file starts with the first quote');
        assert.deepEqual(
            {rows: result.rows, rowsWritten: result.rowsWritten, summaryWritten: result.summaryWritten, error: result.error},
            {rows: 3, rowsWritten: 3, summaryWritten: true, error: undefined},
        );
        assert.equal(result.measuredHz, 100, 'the result carries the same rate the Summary row writes');
        assert.equal(result.path, path);
    });

    it('a text cell with a quote and a leading = is encoded as the Kinvent exports would, in the file', async () => {
        const rec = recorder();
        const path = await rec.open(facts({deviceTitle: '=K "Push"', fields: [{index: 0, name: '@x"y', unit: StreamUnit.KILOGRAM}]}));
        await rec.end('time end');
        const text = readFileSync(path, 'utf8');
        assert.ok(text.includes(`"Devices:","'=K ""Push"""`), text);
        assert.ok(text.includes(`"CHANNEL_1","'@x""y","kg","KILOGRAM"`), text);
        const csv = parseCsv(text);
        assert.equal(csv[0]![4]!.value, `'=K "Push"`);
    });

    it('the time column starts at 0 and is monotonic; every value has 15 decimals; numbers are never quoted', async () => {
        const rec = recorder();
        const path = await rec.open(facts({fields: TWO_FIELDS}));
        let t = 5_000;
        for (let batch = 0; batch < 20; batch += 1) {
            const samples = Array.from({length: 7}, (_, i) => sample((t += 13.325), [batch * 0.1 + i, -(batch + i) / 3]));
            await rec.append(samples);
        }
        const result = await rec.end('time end');
        const csv = parseCsv(readFileSync(path, 'utf8'));
        const rows = sampleRows(csv);
        assert.equal(rows.length, 140);
        assert.equal(rows[0]![0]!.value, '0');
        let previous = -1;
        for (const row of rows) {
            for (const cell of row) assert.equal(cell.quoted, false, 'a numeric cell is never quoted');
            const time = Number(row[0]!.value);
            assert.ok(time > previous, `monotonic: ${time} after ${previous}`);
            previous = time;
            for (const cell of row.slice(1)) assert.match(cell.value, /^-?\d+\.\d{15}$/);
        }
        assert.equal(summaryValue(csv, 'Rows'), String(rows.length), 'the strict reader parsed the whole file; Rows = sample rows');
        assert.equal(result.rows, rows.length);
        // The Summary's numbers are numbers too: Rows, the measured rate, Samples lost, Gaps.
        const summary = findRow(csv, 'Summary');
        for (const label of ['Rows', 'Sample rate measured (Hz)', 'Samples lost', 'Gaps']) {
            const cell = csv[findRow(csv, label, summary)]![1]!;
            assert.equal(cell.quoted, false, `the Summary's "${label}" is a numeric cell, never quoted`);
        }
        // Round trip: the rate read back is the rate of the rows read back, (rows - 1) / (last - first).
        const last = Number(rows.at(-1)![0]!.value);
        assert.equal(summaryValue(csv, 'Sample rate measured (Hz)'), formatMeasuredRate((rows.length - 1) / last));
        assert.equal(summaryValue(csv, 'Sample rate measured (Hz)'), '75.0');
        assert.equal(result.measuredHz, measuredRateHz(rows.length, 0, last));
    });

    it('Time at time zero: the first sample\'s own time when it is from the epoch', async () => {
        const rec = recorder();
        const epoch = new Date(2026, 9, 7, 9, 0, 1, 7).getTime();
        const path = await rec.open(facts());
        await rec.append([sample(epoch, [1, 2], true), sample(epoch + 10, [1, 2], true)]);
        await rec.end('time end');
        const csv = parseCsv(readFileSync(path, 'utf8'));
        assert.deepEqual(values(csv.find((row) => row[0]!.value === 'Time at time zero')!), ['Time at time zero', '09:00:01:007']);
        assert.equal(formatTimeOfDayMs(new Date(epoch)), '09:00:01:007');
        assert.deepEqual(sampleRows(csv).map((row) => row[0]!.value), ['0', '0.01']);
    });

    it('each end reason is written as given; a recording with no sample still has its table head', async () => {
        for (const reason of ['time end', 'Ctrl-C', 'device lost', 'session lost', 'disk full'] as const) {
            const rec = recorder();
            const path = await rec.open(facts());
            const result = await rec.end(reason);
            const csv = parseCsv(readFileSync(path, 'utf8'));
            assert.equal(summaryValue(csv, 'End reason'), reason);
            assert.equal(summaryValue(csv, 'Rows'), '0');
            const rate = csv[findRow(csv, 'Sample rate measured (Hz)', findRow(csv, 'Summary'))]![1]!;
            assert.deepEqual({value: rate.value, quoted: rate.quoted}, {value: '-', quoted: true}, 'no rate below two rows: a "-" text cell');
            assert.equal(result.measuredHz, undefined);
            assert.deepEqual(values(csv.find((row) => row[0]!.value === 'Time at time zero')!), ['Time at time zero', '']);
            assert.deepEqual(sampleRows(csv), []);
            assert.equal(result.summaryWritten, true);
        }
    });

    it('end is idempotent: the second call returns the first result and writes nothing', async () => {
        const rec = recorder();
        const path = await rec.open(facts());
        await rec.append([sample(0, [1, 2])]);
        const first = rec.end('time end');
        const second = rec.end('Ctrl-C');
        assert.equal(first, second);
        await first;
        const text = readFileSync(path, 'utf8');
        assert.equal(text.match(/"Summary"/g)?.length, 1);
        assert.ok(text.endsWith('"End reason","time end"\n'));
        await assert.rejects(rec.append([sample(10, [1, 2])]), /already ended/);
    });

    it('the serial is written only when given, and never in the name', async () => {
        const rec = recorder();
        const path = await rec.open(facts({serialCode: 'SYN-0001'}));
        await rec.end('time end');
        assert.ok(readFileSync(path, 'utf8').startsWith('"Kinvent Companion SDK sample 2026.9.1","Companion 2026.9.1","companion-sdk 2026.9.1","Devices:","K-Push (serial SYN-0001)"\n'));
        assert.ok(!path.includes('SYN'));
        const plain = recorder();
        const plainPath = await plain.open(facts());
        await plain.end('time end');
        assert.ok(!readFileSync(plainPath, 'utf8').includes('serial'));
    });
});

describe('recorder: where and how the file is written', () => {
    it('never overwrites: an existing name gets -2, then -3; the existing file is untouched', async () => {
        const folder = freshFolder();
        mkdirSync(folder, {recursive: true});
        const taken = join(folder, 'MUSCLE_TESTER-20261007-101530.csv');
        writeFileSync(taken, 'keep me\n');
        const second = recorder(folder);
        const path2 = await second.open(facts());
        await second.end('time end');
        assert.equal(path2, join(folder, 'MUSCLE_TESTER-20261007-101530-2.csv'));
        assert.equal(second.suffixed, true);
        const third = recorder(folder);
        const path3 = await third.open(facts());
        await third.end('time end');
        assert.equal(path3, join(folder, 'MUSCLE_TESTER-20261007-101530-3.csv'));
        assert.equal(readFileSync(taken, 'utf8'), 'keep me\n');
    });

    it('file mode 0600; a folder it creates is 0700; an existing folder is left as it is', async () => {
        const folder = join(freshFolder(), 'nested', 'recordings');
        const rec = recorder(folder);
        const path = await rec.open(facts());
        await rec.end('time end');
        assert.equal(statSync(path).mode & 0o777, 0o600);
        assert.equal(statSync(folder).mode & 0o777, 0o700);

        const existing = freshFolder();
        mkdirSync(existing, {mode: 0o755});
        const other = recorder(existing);
        await other.open(facts());
        await other.end('time end');
        assert.equal(statSync(existing).mode & 0o777, 0o755 & ~process.umask());
    });

    it('--out is resolved against the current folder; the default folder is ./recordings', async () => {
        const cwd = freshFolder();
        mkdirSync(cwd);
        const rec = new Recorder({folder: 'recordings', cwd, now: () => FIXED});
        const path = await rec.open(facts());
        await rec.end('time end');
        assert.equal(path, join(cwd, 'recordings', 'MUSCLE_TESTER-20261007-101530.csv'));
        assert.equal(rec.folder, join(cwd, 'recordings'));
    });

    it('a folder that cannot be created → RecorderWriteError, nothing written', async () => {
        const blocker = join(freshFolder());
        writeFileSync(blocker, 'a file where the folder should be');
        const rec = recorder(join(blocker, 'sub'));
        await assert.rejects(rec.open(facts()), (error: unknown) => error instanceof RecorderWriteError && /Could not write/.test(error.message));
        assert.equal(rec.path, undefined);
    });

    it('back-pressure: a slow sink that refuses more data waits for drain; every row arrives, in order', async () => {
        let written = '';
        let drains = 0;
        const slowSink: OpenSink = async () => {
            const sink = new Writable({
                highWaterMark: 16,
                write(chunk: Buffer, _encoding, callback) {
                    setTimeout(() => {
                        written += chunk.toString('utf8');
                        callback();
                    }, 2);
                },
            });
            sink.on('drain', () => (drains += 1));
            return sink;
        };
        const rec = recorder(freshFolder(), slowSink);
        await rec.open(facts());
        const pending: Promise<void>[] = [];
        for (let n = 0; n < 30; n += 1) pending.push(rec.append([sample(n * 10, [n, -n])]));
        await Promise.all(pending);
        const result = await rec.end('time end');
        assert.ok(drains > 0, 'the sink signalled back-pressure');
        const rows = sampleRows(parseCsv(written));
        assert.deepEqual(rows.map((row) => row[1]!.value), Array.from({length: 30}, (_, n) => n.toFixed(15)));
        assert.equal(result.rowsWritten, 30);
    });

    it('a failing disk (ENOSPC): the append rejects with "disk full", no Summary, the rows written before stay', async () => {
        let writes = 0;
        let path = '';
        const failing: OpenSink = async (target) => {
            path = target;
            const real = await openFileSink(target);
            return new Writable({
                write(chunk: Buffer, encoding, callback) {
                    writes += 1;
                    if (writes === 3) {
                        callback(Object.assign(new Error('ENOSPC: no space left on device, write'), {code: 'ENOSPC'}));
                        return;
                    }
                    real.write(chunk, encoding, callback);
                },
                final(callback) {
                    real.end(callback);
                },
                destroy(error, callback) {
                    real.end(() => callback(error));
                },
            });
        };
        const rec = recorder(freshFolder(), failing);
        await rec.open(facts()); // write 1: the preamble
        await rec.append([sample(0, [1, 2]), sample(10, [3, 4])]); // write 2
        const failed = await rec.append([sample(20, [5, 6])]).then(
            () => undefined,
            (error: unknown) => error,
        ); // write 3 fails
        assert.ok(failed instanceof RecorderWriteError, String(failed));
        assert.equal(failed.reason, 'disk full');
        assert.match(failed.message, /Could not write .*: disk full\./);
        await assert.rejects(rec.append([sample(30, [7, 8])]), RecorderWriteError, 'later writes report the same error');
        const result = await rec.end('time end');
        assert.equal(result.summaryWritten, false);
        assert.equal(result.error?.code, 'ENOSPC');
        assert.equal(result.rowsWritten, 2);
        await new Promise((resolve) => setTimeout(resolve, 20));
        const csv = parseCsv(readFileSync(path, 'utf8'));
        assert.equal(sampleRows(csv).length, 2, 'the file still parses up to the last flushed row');
        assert.equal(summaryValue(csv, 'Rows'), undefined, 'no Summary');
    });
});

describe('recorder: the size estimate', () => {
    it('bytesPerRow is a real row of the encoder, line end included', () => {
        const fields = [{index: 0, name: 'force1', unit: StreamUnit.KILOGRAM}];
        const line = sampleLine(fields, sample(1_234_567, [-12.345678901234567]), 0);
        assert.equal(line, '1234.567,-12.345678901234567');
        assert.equal(bytesPerRow(1), line.length + 1);
        assert.equal(bytesPerRow(4), '1234.567'.length + 4 * ',-12.345678901234567'.length + 1);
    });

    it('the 100 MB threshold: 1000 Hz × 3600 s × 4 fields is above it; 100 Hz × 30 s × 1 field is not', () => {
        assert.equal(SIZE_WARNING_BYTES, 100_000_000);
        assert.ok(estimateBytes(1000, 3600, 4) > SIZE_WARNING_BYTES);
        assert.ok(estimateBytes(100, 30, 1) < SIZE_WARNING_BYTES);
    });

    it('the estimate matches a real file within 25 % for the representative values', async () => {
        const rec = recorder();
        const path = await rec.open(facts({fields: [{index: 0, name: 'force1', unit: StreamUnit.KILOGRAM}]}));
        const samples = Array.from({length: 1000}, (_, n) => sample(n * 1000 + 1_000_000, [-12.345678901234567 + n / 1000]));
        await rec.append(samples);
        await rec.end('time end');
        const size = statSync(path).size;
        const estimate = estimateBytes(1000, 1, 1);
        assert.ok(Math.abs(size - estimate) / estimate < 0.25, `file ${size} B, estimate ${estimate} B`);
        assert.ok(existsSync(path));
    });
});

// ---------------------------------------------------------------------------------------------------
// The aligned multi-device layout.
// ---------------------------------------------------------------------------------------------------

const ONE_FIELD: StreamField[] = [{index: 0, name: 'force1', unit: StreamUnit.KILOGRAM}];
const LEFT: DeviceFacts = {title: 'K-Plate Left', fields: TWO_FIELDS, sampleRateHz: 75, timeSynced: null};
const RIGHT: DeviceFacts = {title: 'K-Plate Right', fields: ONE_FIELD, sampleRateHz: 75, timeSynced: true};

const pairFacts = (devices: DeviceFacts[] = [LEFT, RIGHT], over: Partial<RecordingFacts> = {}): RecordingFacts =>
    facts({deviceType: 'PLATES', deviceTitle: devices[0]!.title, fields: devices[0]!.fields, devices, ...over});

describe('recorder: two devices', () => {
    it('golden: the aligned layout, rows joined by index, the shorter device padded, byte for byte', async () => {
        const rec = recorder();
        const path = await rec.open(pairFacts());
        // Unequal counts, and the right device's batches arrive at other times than the left's.
        await rec.append([sample(1000, [1.5, 2]), sample(1010, [3, 4])], 0);
        await rec.append([sample(5000, [7])], 1);
        await rec.append([sample(1020, [5, 6])], 0);
        await rec.append([sample(5010, [8])], 1);
        const result = await rec.end('time end', {samplesLost: 5, gaps: 1, perDevice: [{samplesLost: 5, gaps: 0}, {samplesLost: 0, gaps: 1}]});
        const expected = [
            '"Kinvent Companion SDK sample 2026.9.1","Companion 2026.9.1","companion-sdk 2026.9.1","Devices:","K-Plate Left","K-Plate Right"',
            '"Session Date","2026-10-07"',
            '"Session Time","10:15:30"',
            '"Configuration"',
            '"Device type","PLATES"',
            '"Recording time (sec)",5',
            '"Sample rate set (Hz)",75',
            '"Countdown (sec)",3',
            '"Channels"',
            '"Column","Device","Field","Unit","Unit code"',
            '"CHANNEL_1","K-Plate Left","force1","kg","KILOGRAM"',
            '"CHANNEL_2","K-Plate Left","force2","kg","KILOGRAM"',
            '"CHANNEL_1","K-Plate Right","force1","kg","KILOGRAM"',
            '"Join","Rows are joined by index, as the Kinvent app\'s export does, not by timestamp. Time (sec) is the K-Plate Left\'s."',
            '',
            '"Raw Channel Data"',
            '"Time at time zero","10:15:30:123"',
            '"","K-Plate Left","","","K-Plate Right"',
            '"Time (sec)","CHANNEL_1","CHANNEL_2","","CHANNEL_1"',
            '0,1.500000000000000,2.000000000000000,"",7.000000000000000',
            '0.01,3.000000000000000,4.000000000000000,"",8.000000000000000',
            '0.02,5.000000000000000,6.000000000000000,"",""',
            '',
            '"Summary"',
            '"Rows",3',
            '"Rows (K-Plate Left)",3',
            '"Rows (K-Plate Right)",2',
            '"Sample rate measured (Hz) (K-Plate Left)",100.0',
            '"Sample rate measured (Hz) (K-Plate Right)",100.0',
            '"Samples lost (K-Plate Left)",5',
            '"Samples lost (K-Plate Right)",0',
            '"Gaps (K-Plate Left)",0',
            '"Gaps (K-Plate Right)",1',
            '"End reason","time end"',
            '',
        ].join('\n');
        assert.equal(readFileSync(path, 'utf8'), expected);
        assert.equal(result.rows, 3);
        assert.deepEqual(
            result.devices?.map((device) => [device.title, device.rows, device.measuredHz]),
            [
                ['K-Plate Left', 3, 100],
                ['K-Plate Right', 2, 100],
            ],
        );
    });

    it('the strict reader parses it and EVERY row of the table has the header\'s width; numbers are never quoted', async () => {
        const rec = recorder();
        const path = await rec.open(pairFacts());
        await rec.append([sample(0, [1, 2]), sample(10, [1, 2]), sample(20, [1, 2])], 0);
        await rec.append([sample(0, [9])], 1);
        await rec.end('time end');
        const csv = parseCsv(readFileSync(path, 'utf8'));
        const header = csv[findRow(csv, 'Time (sec)')]!;
        const titles = csv[findRow(csv, 'Time (sec)') - 1]!;
        assert.equal(titles.length, header.length, 'the device-title row has the header\'s width');
        const rows = sampleRows(csv);
        assert.equal(rows.length, 3);
        for (const row of rows) {
            assert.equal(row.length, header.length, 'no extra trailing cell, no missing cell');
            for (const cell of row) if (cell.value !== '') assert.equal(cell.quoted, false);
        }
        // Each device's values line up under its own CHANNEL_1.
        const rightColumn = header.findIndex((cell, i) => i > 0 && cell.value === 'CHANNEL_1' && i > 1);
        assert.equal(titles[rightColumn]!.value, 'K-Plate Right');
        assert.equal(rows[0]![rightColumn]!.value, '9.000000000000000');
        assert.equal(rows[1]![rightColumn]!.value, '', 'padding, not the next right sample');
    });

    it('a shorter FIRST device: its time cell and channels are padded too; time zero is still the first device\'s', async () => {
        const rec = recorder();
        const path = await rec.open(pairFacts());
        await rec.append([sample(10, [9]), sample(20, [9]), sample(30, [9])], 1);
        await rec.append([sample(100, [1, 2])], 0);
        await rec.end('time end');
        const text = readFileSync(path, 'utf8');
        assert.ok(text.includes('"Time at time zero","10:15:30:123"\n'), text);
        assert.deepEqual(
            sampleRows(parseCsv(text)).map(values),
            [
                ['0', '1.000000000000000', '2.000000000000000', '', '9.000000000000000'],
                ['', '', '', '', '9.000000000000000'],
                ['', '', '', '', '9.000000000000000'],
            ],
        );
    });

    it('a row is written as soon as every device has its sample of that index (not only at the end)', async () => {
        const rec = recorder();
        const path = await rec.open(pairFacts());
        await rec.append([sample(0, [1, 2]), sample(10, [1, 2])], 0);
        assert.deepEqual(sampleRowsSoFar(path), [], 'the right device has no sample yet: nothing written');
        await rec.append([sample(0, [9])], 1);
        assert.equal(sampleRowsSoFar(path).length, 1, 'row 0 is complete and written; row 1 waits');
        await rec.end('time end');
        assert.equal(sampleRows(parseCsv(readFileSync(path, 'utf8'))).length, 2);
    });

    it('rates that differ: one "Sample rate set (Hz) (<title>)" row per device; timeSynced false: "Time sync (<title>)","not confirmed"', async () => {
        const rec = recorder();
        const path = await rec.open(
            pairFacts([LEFT, {...RIGHT, sampleRateHz: undefined, timeSynced: false, serialCode: 'SYN-R'}], {}),
        );
        await rec.end('device lost (K-Plate Right)');
        const text = readFileSync(path, 'utf8');
        assert.ok(
            text.includes(
                [
                    '"Recording time (sec)",5',
                    '"Sample rate set (Hz) (K-Plate Left)",75',
                    '"Sample rate set (Hz) (K-Plate Right)","unknown"',
                    '"Countdown (sec)",3',
                    '"Time sync (K-Plate Right)","not confirmed"',
                    '"Channels"',
                ].join('\n'),
            ),
            text,
        );
        assert.ok(text.startsWith('"Kinvent Companion SDK sample 2026.9.1","Companion 2026.9.1","companion-sdk 2026.9.1","Devices:","K-Plate Left","K-Plate Right (serial SYN-R)"\n'));
        const csv = parseCsv(text);
        assert.equal(findRow(csv, 'Sample rate set (Hz)'), -1, 'no shared row when the rates differ');
        assert.equal(summaryValue(csv, 'End reason'), 'device lost (K-Plate Right)');
        // No sample at all: the head is still there, every per-device rate is "-".
        assert.equal(summaryValue(csv, 'Rows'), '0');
        assert.equal(summaryValue(csv, 'Sample rate measured (Hz) (K-Plate Right)'), '-');
        assert.equal(findRow(csv, 'Time sync (K-Plate Left)'), -1, 'null (the master) is not written');
    });

    it('one device in `devices` keeps the single-device layout, byte for byte', async () => {
        const plain = recorder();
        const a = await plain.open(facts());
        await plain.append([sample(1000, [1, 2])]);
        await plain.end('time end');
        const listed = recorder();
        const b = await listed.open(facts({devices: [{title: 'ignored', fields: ONE_FIELD, sampleRateHz: 1}]}));
        await listed.append([sample(1000, [1, 2])]);
        await listed.end('time end');
        assert.equal(readFileSync(b, 'utf8'), readFileSync(a, 'utf8'));
    });
});

/** The sample rows on disk now (the head may not be written yet). */
function sampleRowsSoFar(path: string): string[] {
    const text = readFileSync(path, 'utf8');
    const lines = text.split('\n');
    const header = lines.findIndex((line) => line.startsWith('"Time (sec)"'));
    return header < 0 ? [] : lines.slice(header + 1).filter((line) => line !== '');
}
