/**
 * Integration: a K-Plates pair through the real CLI flow (`runCli`) and the real
 * SDK client over the fake companion. The fake plans a pair type as LEFT + RIGHT (or LEFT alone with
 * `isMonopodal`), gives each device its own socket and frames, starts every device on ONE `measure/start`
 * and stops one device per `measure/stop`, as the companion does. Every value is synthetic.
 */
import {strict as assert} from 'node:assert';
import {EventEmitter} from 'node:events';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, describe, it} from 'node:test';
import {BluetoothDeviceType, DeviceState, DeviceType, VERSION, type DeviceSnapshot, type ForceSample} from '@kinvent/companion-sdk';
import {runCli, type RunEnv} from '../../src/run.js';
import {readRegistered, rememberDevices} from '../../src/registry.js';
import type {ExitCode} from '../../src/exit.js';
import {DEFAULT_FREQUENCIES, FAKE_DEVICE_ID, FAKE_RIGHT_ID, FakeCompanion, fakeConfiguration, ODD_RIGHT_ID, type FakeOptions} from '../doubles/fakeCompanion.js';
import {findRow, parseCsv, sampleRows, summaryValue, values, type Csv} from '../doubles/rfc4180.js';

const SCRATCH = mkdtempSync(join(tmpdir(), 'cli-sample-pair-'));
after(() => rmSync(SCRATCH, {recursive: true, force: true}));
let runs = 0;

/** 2026-10-07 10:15:30.123, LOCAL time: the file's dates and its time zero (the samples are not from the epoch). */
const FIXED = new Date(2026, 9, 7, 10, 15, 30, 123).getTime();

interface Outcome {
    code: ExitCode;
    stdout: string;
    stderr: string;
    fake: FakeCompanion;
}

interface RunOptions {
    tty?: boolean;
    signals?: EventEmitter;
    onFake?: (fake: FakeCompanion) => void;
    env?: Partial<RunEnv>;
}

async function run(argv: string[], options: FakeOptions = {}, extra: RunOptions = {}): Promise<Outcome> {
    const fake = new FakeCompanion(options);
    const signals = extra.signals ?? new EventEmitter();
    extra.onFake?.(fake);
    let stdout = '';
    let stderr = '';
    const code = await runCli({
        argv,
        stdout: {write: (text) => void (stdout += text)},
        stderr: {write: (text) => void (stderr += text)},
        version: 'test',
        makeReader: undefined,
        signals,
        clientOptions: {fetchImpl: fake.fetch, webSocketImpl: fake.WebSocket, busyPollMs: 5, idlePollMs: 10, activityTailMs: 20},
        keepAliveMs: 40,
        teardownStepTimeoutMs: 1000,
        stdoutIsTTY: extra.tty === true,
        countdownStepMs: 30,
        liveTickMs: 50,
        cwd: join(SCRATCH, `run-${++runs}`),
        now: () => FIXED,
        registryPath: join(SCRATCH, `registry-${runs}.json`),
        zeroTiming: {stillWindowMs: 60, zeroStepTimeoutMs: 2000},
        ...extra.env,
    });
    assert.equal(signals.listenerCount('SIGINT'), 0, 'the SIGINT listener must be removed on exit');
    return {code, stdout, stderr, fake};
}

/** A terminal that answers Enter to everything: present, so the floor devices are calibrated; Enter keeps a rate. */
const INTERACTIVE = {makeReader: () => ({ask: async () => '', close: () => undefined})};

/** A K-Deltas snapshot with only what the registry reads: id, name, side. */
function snapshotLike(id: string, name: string, side: 'LEFT' | 'RIGHT'): DeviceSnapshot {
    return {
        id,
        name,
        deviceType: DeviceType.HEXAS,
        bluetoothDeviceType: side === 'LEFT' ? BluetoothDeviceType.HEXAS_LEFT : BluetoothDeviceType.HEXAS_RIGHT,
        side,
        state: DeviceState.READY,
        inUse: true,
        measuring: false,
    };
}

const START_LEFT = `POST /devices/${FAKE_DEVICE_ID}/measure/start`;
const STOP_LEFT = `POST /devices/${FAKE_DEVICE_ID}/measure/stop`;
const STOP_RIGHT = `POST /devices/${FAKE_RIGHT_ID}/measure/stop`;

const count = (fake: FakeCompanion, command: string): number => fake.commands().filter((entry) => entry === command).length;
const startCount = (fake: FakeCompanion): number => fake.commands().filter((entry) => entry.endsWith('/measure/start')).length;

/** Session hygiene for a pair: released once, activity stopped once, every owed measureStop BEFORE it. */
function assertHygiene(fake: FakeCompanion, stops: {left: number; right: number}): void {
    const commands = fake.commands();
    assert.equal(fake.count('POST', '/session/release'), 1, 'released exactly once');
    assert.equal(fake.count('POST', '/activity/stop'), 1, 'activity stopped exactly once');
    // Floor devices are measured once before the recording, to wait until nothing moves on them: one more stop for
    // every device that was then zeroed.
    const still = (id: string): number => (fake.rezeroes.includes(id) ? 1 : 0);
    assert.equal(count(fake, STOP_LEFT), stops.left + still(FAKE_DEVICE_ID), 'measure/stop for the LEFT device');
    assert.equal(count(fake, STOP_RIGHT), stops.right + still(FAKE_RIGHT_ID), 'measure/stop for the RIGHT device');
    for (const stop of [STOP_LEFT, STOP_RIGHT]) {
        if (commands.includes(stop)) assert.ok(commands.indexOf(stop) < commands.indexOf('POST /activity/stop'), `${stop} before stopActivity`);
    }
    assert.ok(commands.indexOf('POST /activity/stop') < commands.indexOf('POST /session/release'), 'stop before release');
}

function savedPath(stdout: string): string {
    const match = /(?:Saved \d+ rows to |Partial data kept: \d+ rows in )(\/\S+\.csv)\n/.exec(stdout);
    assert.ok(match, `no file report in:\n${stdout}`);
    return match[1]!;
}

const readCsv = (path: string): Csv => parseCsv(readFileSync(path, 'utf8'));

/** `toFixed(15)` of the four force cells of a sample, as the file writes them. */
const cells = (sample: ForceSample): string[] => sample.channels.slice(0, 4).map((value) => value.toFixed(15));
const rate = (samples: readonly ForceSample[]): string =>
    ((samples.length - 1) / ((samples.at(-1)!.timeStamp - samples[0]!.timeStamp) / 1000)).toFixed(1);

/**
 * The pair file, written out by hand from the samples the fake sent (NOT with the recorder's functions):
 * the aligned layout.
 */
function expectedPairFile(left: readonly ForceSample[], right: readonly ForceSample[], reason: string): string {
    const empty = (n: number): string[] => Array.from({length: n}, () => '""');
    const rows: string[] = [];
    for (let i = 0; i < Math.max(left.length, right.length); i += 1) {
        const l = left[i];
        const r = right[i];
        const leftPart = l === undefined ? empty(5) : [String((l.timeStamp - left[0]!.timeStamp) / 1000), ...cells(l)];
        const rightPart = r === undefined ? empty(5) : ['""', ...cells(r)];
        rows.push([...leftPart, ...rightPart].join(','));
    }
    const channelRows = ['Left', 'Right'].flatMap((side) =>
        [1, 2, 3, 4].map((n) => `"CHANNEL_${n}","K-Plate ${side}","force${n}","kg","KILOGRAM"`),
    );
    return [
        `"Kinvent Companion CLI sample test","Companion ${VERSION}","companion-sdk ${VERSION}","Devices:","K-Plate Left","K-Plate Right"`,
        '"Session Date","2026-10-07"',
        '"Session Time","10:15:30"',
        '"Configuration"',
        '"Device type","PLATES"',
        '"Recording time (sec)",1',
        '"Sample rate set (Hz)",75',
        '"Countdown (sec)",3',
        '"Channels"',
        '"Column","Device","Field","Unit","Unit code"',
        ...channelRows,
        `"Join","Rows are joined by index, as the Kinvent app's export does, not by timestamp. Time (sec) is the K-Plate Left's."`,
        '',
        '"Raw Channel Data"',
        '"Time at time zero","10:15:30:123"',
        '"","K-Plate Left","","","","","K-Plate Right","","",""',
        '"Time (sec)","CHANNEL_1","CHANNEL_2","CHANNEL_3","CHANNEL_4","","CHANNEL_1","CHANNEL_2","CHANNEL_3","CHANNEL_4"',
        ...rows,
        '',
        '"Summary"',
        `"Rows",${Math.max(left.length, right.length)}`,
        `"Rows (K-Plate Left)",${left.length}`,
        `"Rows (K-Plate Right)",${right.length}`,
        `"Sample rate measured (Hz) (K-Plate Left)",${rate(left)}`,
        `"Sample rate measured (Hz) (K-Plate Right)",${rate(right)}`,
        '"Samples lost (K-Plate Left)",0',
        '"Samples lost (K-Plate Right)",0',
        '"Gaps (K-Plate Left)",0',
        '"Gaps (K-Plate Right)",0',
        `"End reason","${reason}"`,
        '',
    ].join('\n');
}

/**
 * The single-device file, written out by hand: the format a one-device recording must keep, byte
 * for byte.
 */
function expectedSingleFile(samples: readonly ForceSample[], title: string, type: string): string {
    return [
        `"Kinvent Companion CLI sample test","Companion ${VERSION}","companion-sdk ${VERSION}","Devices:","${title}"`,
        '"Session Date","2026-10-07"',
        '"Session Time","10:15:30"',
        '"Configuration"',
        `"Device type","${type}"`,
        '"Recording time (sec)",1',
        '"Sample rate set (Hz)",75',
        '"Countdown (sec)",3',
        '"Channels"',
        '"Column","Field","Unit","Unit code"',
        ...[1, 2, 3, 4].map((n) => `"CHANNEL_${n}","force${n}","kg","KILOGRAM"`),
        '',
        '"Raw Channel Data"',
        '"Time at time zero","10:15:30:123"',
        `"","${title}","","",""`,
        '"Time (sec)","CHANNEL_1","CHANNEL_2","CHANNEL_3","CHANNEL_4"',
        ...samples.map((sample) => [String((sample.timeStamp - samples[0]!.timeStamp) / 1000), ...cells(sample)].join(',')),
        '',
        '"Summary"',
        `"Rows",${samples.length}`,
        `"Sample rate measured (Hz)",${rate(samples)}`,
        '"Samples lost",0',
        '"Gaps",0',
        '"End reason","time end"',
        '',
    ].join('\n');
}

const originalWarn = console.warn;
const originalInfo = console.info;
before(() => {
    console.warn = () => undefined;
    console.info = () => undefined;
});
after(() => {
    console.warn = originalWarn;
    console.info = originalInfo;
});

async function waitUntil(condition: () => boolean, what: string): Promise<void> {
    const started = Date.now();
    while (!condition()) {
        if (Date.now() - started > 5000) assert.fail(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
}

const PAIR_1S = ['--device', 'PLATES', '--seconds', '1', '--connect-timeout', '5'];

describe('pair: the happy path', () => {
    it('no terminal: a pair by default; both recorded; one measureStart, one measureStop per device; the aligned file byte for byte', async () => {
        // The RIGHT plate starts 5 frames late, so it has 10 samples fewer: the last rows are padded.
        const {code, stdout, stderr, fake} = await run(PAIR_1S, {numOfChannels: 4, rightFrameDelay: 5});
        assert.equal(code, 0, stderr);
        assert.ok(fake.lastPlan !== undefined && !('isMonopodal' in fake.lastPlan), 'a pair: no isMonopodal key at all');
        assert.match(stdout, /Device: K-Plates \(PLATES\), a pair \(left and right\)\. Recording time: 1 s\./);
        assert.match(stdout, /Switch on your K-Plate Left and K-Plate Right\. Waiting for them to connect…/);
        assert.match(stdout, /K-Plate Left: connecting[\s\S]*K-Plate Right: ready/);
        assert.match(stdout, /Devices ready: K-Plate Left \(PLATES\), K-Plate Right \(PLATES\)\./);
        assert.match(stdout, /Fields \(K-Plate Left\): force1, force2, force3, force4 — from the companion's stream descriptor/);
        assert.match(stdout, /Fields \(K-Plate Right\): force1, force2, force3, force4 — from the companion's stream descriptor/);
        assert.equal(fake.count('GET', '/streams'), 1, 'one descriptor read for both devices');

        assert.equal(startCount(fake), 1, 'ONE measureStart starts both devices');
        assert.equal(count(fake, START_LEFT), 1, 'sent for the first (left) device');
        assertHygiene(fake, {left: 1, right: 1});

        const left = fake.sentByDevice.get(FAKE_DEVICE_ID)!;
        const right = fake.sentByDevice.get(FAKE_RIGHT_ID)!;
        assert.ok(left.length > right.length, `unequal counts: ${left.length} vs ${right.length}`);
        assert.match(
            stdout,
            new RegExp(
                `Done\\. ${left.length + right.length} samples in \\d+\\.\\d s from K-Plates \\(PLATES\\): K-Plate Left ${left.length} samples, ${rate(left)} Hz measured; K-Plate Right ${right.length} samples, ${rate(right)} Hz measured; no data lost\\.`,
            ),
        );
        // Not a terminal: the plain line shows both devices, each value with its unit.
        assert.match(stdout, /K-Plate Left: 75 Hz set \(device configuration\), \d+ Hz measured, \d+ samples, force1 \d+\.\d{2} kg/);
        assert.match(stdout, /\| {2}K-Plate Right: 75 Hz set/);

        const path = savedPath(stdout);
        assert.match(path, /\/recordings\/PLATES-20261007-101530\.csv$/, 'one file for the pair, <DEVICE TYPE>-<timestamp>.csv');
        assert.equal(readFileSync(path, 'utf8'), expectedPairFile(left, right, 'time end'));
    });

    it('the strict RFC 4180 reader parses the pair file; every data row has the header\'s width; the Summary is per device', async () => {
        const {code, stdout, fake} = await run(PAIR_1S, {numOfChannels: 4, leftFrameDelay: 4});
        assert.equal(code, 0);
        const csv = readCsv(savedPath(stdout));
        const header = csv[findRow(csv, 'Time (sec)')]!;
        assert.equal(header.length, 10);
        const rows = sampleRows(csv);
        for (const row of rows) assert.equal(row.length, header.length, 'every data row has the header width');
        const left = fake.sentByDevice.get(FAKE_DEVICE_ID)!;
        const right = fake.sentByDevice.get(FAKE_RIGHT_ID)!;
        assert.ok(right.length > left.length, 'here the LEFT one is shorter');
        // The shorter LEFT device is padded, its time cell included.
        assert.deepEqual(values(rows.at(-1)!).slice(0, 6), ['', '', '', '', '', '']);
        assert.deepEqual(values(rows.at(-1)!).slice(6), cells(right.at(-1)!));
        assert.equal(summaryValue(csv, 'Rows'), String(rows.length));
        assert.equal(summaryValue(csv, 'Rows (K-Plate Left)'), String(left.length));
        assert.equal(summaryValue(csv, 'Rows (K-Plate Right)'), String(right.length));
        assert.equal(summaryValue(csv, 'Sample rate measured (Hz) (K-Plate Right)'), rate(right));
        assert.deepEqual(values(csv[findRow(csv, 'Column')]!), ['Column', 'Device', 'Field', 'Unit', 'Unit code']);
        assert.equal(findRow(csv, 'Time sync (K-Plate Right)'), -1, 'confirmed (true): no row');
    });

    it('on a terminal: the time once, then a block per device with its title', async () => {
        const {code, stdout} = await run(PAIR_1S, {numOfChannels: 1}, {tty: true});
        assert.equal(code, 0);
        assert.match(stdout, /K-Plates \(PLATES\) {2}· {2}2 devices {2}· {2}\d+\.\d s elapsed, \d+\.\d s left/);
        assert.match(stdout, / {2}K-Plate Left {2}· {2}75 Hz set \(device configuration\) {2}· {2}\d+ Hz measured {2}· {2}\d+ samples/);
        assert.match(stdout, / {2}K-Plate Right {2}· {2}75 Hz set/);
        assert.match(stdout, / {4}force1 +\d+\.\d{2} kg\n/);
    });

    it('timeSynced false on the right plate: "Time sync (K-Plate Right)","not confirmed" in the Configuration', async () => {
        const {code, stdout} = await run(PAIR_1S, {rightTimeSynced: false});
        assert.equal(code, 0);
        const csv = readCsv(savedPath(stdout));
        const row = findRow(csv, 'Time sync (K-Plate Right)');
        assert.ok(row > findRow(csv, 'Configuration') && row < findRow(csv, 'Channels'));
        assert.deepEqual(values(csv[row]!), ['Time sync (K-Plate Right)', 'not confirmed']);
    });

    it('a stream.layout event re-labels that device\'s live values (relies on it)', async () => {
        const jump = {
            ...fakeConfiguration('PLATES', 4),
            stream: {deviceType: 'PLATES' as const, mode: 'jump', fields: [{index: 0, name: 'forceTotal', unit: 'KILOGRAM' as const}]},
        };
        let fake!: FakeCompanion;
        const pending = run(['--device', 'PLATES', '--seconds', '1'], {numOfChannels: 4}, {onFake: (f) => (fake = f)});
        await waitUntil(() => fake.framesOf(FAKE_RIGHT_ID) >= 3, 'right frames');
        fake.emitEvent({type: 'stream.layout', deviceId: FAKE_RIGHT_ID, configuration: jump});
        const {code, stdout} = await pending;
        assert.equal(code, 0);
        const last = stdout.split('\n').filter((line) => line.includes('K-Plate Right: ')).at(-1)!;
        assert.match(last, /K-Plate Right: .*, forceTotal \d+\.\d{2} kg$/, last);
        assert.doesNotMatch(last.slice(last.indexOf('K-Plate Right: ')), /force1|force2/, 'the right device shows only the new field');
        assert.match(last, /K-Plate Left: .*force4 \d+\.\d{2} kg/, 'the other device keeps its fields');
    });
});

describe('pair: --single and the question', () => {
    it('--single: isMonopodal sent, ONE device (the left one), the single-device file byte for byte', async () => {
        const {code, stdout, stderr, fake} = await run(['--device', 'PLATES', '--single', '--seconds', '1'], {numOfChannels: 4});
        assert.equal(code, 0, stderr);
        assert.deepEqual(fake.lastPlan, {activityCode: 'cli-sample', deviceTypes: ['PLATES'], isMonopodal: true, registered: [], exclude: []});
        assert.match(stdout, /Device: K-Plates \(PLATES\), one plate \(the left one\)\. Recording time: 1 s\./);
        assert.match(stdout, /Switch on your K-Plate Left\. Waiting for it to connect…/);
        assert.match(stdout, /Device ready: K-Plates, PLATES\./);
        assert.equal(fake.sentByDevice.get(FAKE_RIGHT_ID), undefined, 'no right plate');
        assert.equal(count(fake, STOP_LEFT), 1);
        assert.equal(readFileSync(savedPath(stdout), 'utf8'), expectedSingleFile(fake.sentByDevice.get(FAKE_DEVICE_ID)!, 'K-Plates', 'PLATES'));
    });

    it('a one-sensor type keeps the single-device file byte for byte (K-Push); --single is refused for it', async () => {
        const push = await run(['--device', 'MUSCLE_TESTER', '--seconds', '1'], {numOfChannels: 4});
        assert.equal(push.code, 0);
        assert.ok(!('isMonopodal' in push.fake.lastPlan!), 'nothing new in the plan of a one-sensor type');
        assert.equal(readFileSync(savedPath(push.stdout), 'utf8'), expectedSingleFile(push.fake.sentSamples, 'K-Push', 'MUSCLE_TESTER'));

        const refused = await run(['--device', 'GRIP', '--single', '--seconds', '1']);
        assert.equal(refused.code, 1);
        assert.match(refused.stderr, /--single: only for a sensor pair \(K-Plates, K-Deltas, K-Deltas 3D\); a K-Grip is one sensor already\./);
        assert.equal(refused.fake.requests.length, 0);
    });

    it('with no flags at a terminal, the device questions come first, then the recording time, then (plates) the rate', async () => {
        const asked: string[] = [];
        const answers = ['PLATES', '', '', '1', ''];
        const reader = () => ({
            ask: async (prompt: string) => {
                asked.push(prompt);
                return answers.shift();
            },
            close: () => undefined,
        });
        const result = await run([], {}, {env: {makeReader: reader}});
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(asked.slice(1), [
            'Use a single plate? [y/N] ',
            'Jump test (total force at a high rate)? [y/N] ',
            'Recording time in seconds (1–3600): ',
            'Sampling rate (1-2, Enter keeps 100 Hz): ',
        ]);
        assert.match(asked[0]!, /^Device \(1-7 or name\): $/);
    });

    it('at a terminal without --single: "Use a single plate? [y/N]"; "y" sends isMonopodal, empty records the pair', async () => {
        const asked: string[] = [];
        const reader = (answers: string[]) => () => ({
            ask: async (prompt: string) => {
                asked.push(prompt);
                return answers.shift();
            },
            close: () => undefined,
        });
        // `--normal` answers the jump question K-Plates also get at a terminal (tested in jump.test.ts).
        const single = await run(['--device', 'PLATES', '--seconds', '1', '--normal', '--rate', '100'], {}, {env: {makeReader: reader(['y'])}});
        assert.equal(single.code, 0, single.stderr);
        assert.deepEqual(asked, ['Use a single plate? [y/N] ']);
        assert.equal(single.fake.lastPlan?.isMonopodal, true);

        const pair = await run(['--device', 'PLATES', '--seconds', '1', '--normal', '--rate', '100'], {}, {env: {makeReader: reader([''])}});
        assert.equal(pair.code, 0);
        assert.ok(!('isMonopodal' in pair.fake.lastPlan!));
        assert.match(pair.stdout, /Devices ready: K-Plate Left \(PLATES\), K-Plate Right \(PLATES\)\./);

        asked.length = 0;
        await run(['--device', 'GRIP', '--seconds', '1'], {}, {env: {makeReader: reader([])}});
        assert.deepEqual(asked, [], 'not asked for a one-sensor type');
    });
});

describe('pair: errors', () => {
    it('one plate missing → E5 (exit 4): what connected and what is missing; nothing measured; stopped and released', async () => {
        const {code, stdout, stderr, fake} = await run(['--device', 'PLATES', '--seconds', '1', '--connect-timeout', '1'], {scenario: 'onePlateMissing'});
        assert.equal(code, 4);
        assert.match(stdout, /K-Plate Left: connected/);
        assert.match(
            stderr,
            /K-Plate Left connected; waiting for K-Plate Right\.\nNo K-Plate Right connected in 1 s\. Is it switched on and charged\? Is another app connected to it\?\nTo record the K-Plate Left alone, run again with --single\./,
        );
        assert.doesNotMatch(stderr, /No K-Plates connected/, 'not the one-sensor sentence: a plate did connect');
        assert.equal(startCount(fake), 0);
        assertHygiene(fake, {left: 0, right: 0});
    });

    it('--single with only a right plate nearby → E5, says the right one cannot be used alone', async () => {
        const {code, stderr, fake} = await run(['--device', 'PLATES', '--single', '--seconds', '1', '--connect-timeout', '1'], {scenario: 'rightOnly'});
        assert.equal(code, 4);
        assert.equal(fake.lastPlan?.isMonopodal, true);
        assert.match(stderr, /No K-Plates connected in 1 s \(waiting for K-Plate Left\)\./);
        assert.match(stderr, /Seen nearby: 1 × K-Plate Right\.\nWith --single only the left sensor \(K-Plate Left\) can be used\./);
    });

    it('E6: the right plate is lost mid-run → exit 5; the left one is stopped; the file ends "device lost (K-Plate Right)"', async () => {
        const {code, stdout, stderr, fake} = await run(['--device', 'PLATES', '--seconds', '5'], {disconnectSide: 'RIGHT', disconnectAfterFrames: 10});
        assert.equal(code, 5, stderr);
        assert.match(stderr, /The K-Plate Right disconnected after \d+\.\d s \(link lost\)\. \d+ samples were received\. The other sensor was stopped\./);
        assert.match(stdout, /Ended early\./);
        assertHygiene(fake, {left: 1, right: 0});
        assert.ok(fake.emittedSamples < 400, 'ended early, not at the 5 s time end');
        const csv = readCsv(savedPath(stdout));
        assert.equal(summaryValue(csv, 'End reason'), 'device lost (K-Plate Right)');
        assert.equal(summaryValue(csv, 'Rows (K-Plate Right)'), String(fake.sentByDevice.get(FAKE_RIGHT_ID)!.length));
        assert.equal(summaryValue(csv, 'Rows (K-Plate Left)'), String(fake.sentByDevice.get(FAKE_DEVICE_ID)!.length));
    });

    it('E6: the LEFT plate lost → the right one is stopped, the message names the left one', async () => {
        const {code, stderr, fake} = await run(['--device', 'PLATES', '--seconds', '5'], {disconnectSide: 'LEFT', disconnectAfterFrames: 10});
        assert.equal(code, 5);
        assert.match(stderr, /The K-Plate Left disconnected after/);
        assertHygiene(fake, {left: 0, right: 1});
    });

    it('Ctrl-C with a pair: measureStop for BOTH before stopActivity, released once, "Ctrl-C" in the file, exit 130', async () => {
        const signals = new EventEmitter();
        let fake!: FakeCompanion;
        const pending = run(['--device', 'PLATES', '--seconds', '3'], {}, {signals, onFake: (f) => (fake = f)});
        await waitUntil(() => fake.emittedFrames >= 20, 'frames');
        signals.emit('SIGINT');
        const {code, stdout} = await pending;
        assert.equal(code, 130);
        assert.match(stdout, /Stopped by Ctrl-C\. \d+ samples in \d+\.\d s from K-Plates \(PLATES\): K-Plate Left \d+ samples/);
        assertHygiene(fake, {left: 1, right: 1});
        const csv = readCsv(savedPath(stdout));
        assert.equal(summaryValue(csv, 'End reason'), 'Ctrl-C');
        assert.equal(summaryValue(csv, 'Rows'), String(sampleRows(csv).length));
    });
});

describe('plates: nobody on them while they are zeroed', () => {
    const FAST = {zeroRetryMs: 10, zeroStepTimeoutMs: 2000, stillWindowMs: 60};
    const REZERO_LEFT = FAKE_DEVICE_ID;
    const REZERO_RIGHT = FAKE_RIGHT_ID;

    it('warns before they connect, zeroes both again, then says when to step on', async () => {
        const result = await run(['--device', 'PLATES', '--seconds', '1', '--normal'], {baselineErrorCheck: true}, {env: {...INTERACTIVE, zeroTiming: FAST}});
        assert.equal(result.code, 0, result.stderr);
        const out = result.stdout;
        const warn = out.indexOf('Do not step on the plates: they are calibrated while they connect.');
        const ready = out.indexOf('Devices ready:');
        const waiting = out.indexOf('Step off the plates. Waiting until nothing moves on the plates…');
        const calibrating = out.indexOf('Calibrating the plates. Keep them free of load…');
        const zeroed = out.indexOf('Plates calibrated.');
        const stepOn = out.indexOf('You can step on the plates now.');
        assert.ok(warn >= 0 && warn < ready && ready < waiting && waiting < calibrating && calibrating < zeroed && zeroed < stepOn, out);
        assert.deepEqual(result.fake.rezeroes, [REZERO_LEFT, REZERO_RIGHT]);
        // A short measurement watches for stillness, then the zero, then the recording's own measurement.
        const commands = result.fake.commands();
        const rezero = commands.indexOf(`POST /devices/${REZERO_RIGHT}/rezero`);
        assert.ok(commands.indexOf(START_LEFT) < rezero && rezero < commands.lastIndexOf(START_LEFT), commands.join('\n'));
        assert.equal(result.fake.measureStarts, 2);
        assert.ok(commands.filter((command) => command === STOP_LEFT).length >= 2, 'the stillness measurement is stopped on every device');
    });

    it('weight on the left plate: tells the user to step off and zeroes that plate again until it is empty', async () => {
        const result = await run(
            ['--device', 'PLATES', '--seconds', '1', '--normal'],
            {baselineErrorCheck: true, zeroErrors: {LEFT: 2}},
            {env: {...INTERACTIVE, zeroTiming: FAST}},
        );
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(result.fake.rezeroes, [REZERO_LEFT, REZERO_RIGHT, REZERO_LEFT, REZERO_LEFT]);
        assert.equal(result.stdout.match(/Calibration has failed \(K-Plate Left: forces were being applied\)\. Please step off the plates/g)?.length, 2);
        assert.match(result.stdout, /Plates calibrated\./);
    });

    it('a changing load on a plate delays the zero: the user is told to step off and keep still, then it goes on', async () => {
        const result = await run(['--device', 'PLATES', '--seconds', '1', '--normal'], {baselineErrorCheck: true, unsteadyFrames: 12}, {env: {...INTERACTIVE, zeroTiming: FAST}});
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /Load changing on K-Plate Left\. Step off the plates and keep still…/);
        assert.match(result.stdout, /Plates calibrated\./);
        assert.deepEqual(result.fake.rezeroes, [REZERO_LEFT, REZERO_RIGHT], 'no zero was taken while the load changed');
        assert.equal(result.fake.measureStarts, 2);
    });

    it('the plates never become empty: exit 4, nothing recorded', async () => {
        const result = await run(
            ['--device', 'PLATES', '--seconds', '1', '--normal'],
            {baselineErrorCheck: true, zeroErrors: {RIGHT: 1000}},
            {env: {...INTERACTIVE, zeroTiming: {...FAST, zeroEmptyTimeoutMs: 100}}},
        );
        assert.equal(result.code, 4);
        assert.match(
            result.stderr,
            /(Calibration of the plates has failed \(K-Plate Right: forces were being applied\)|Nothing stood still on the plates in time)\. (Please step|Step) off the plates and run again\./,
        );
        assert.doesNotMatch(result.stdout, /Done\.|Saved \d+ rows/, 'nothing recorded');
    });

    it('older firmware cannot report weight: one zero each, with a warning, and the recording goes on', async () => {
        const result = await run(['--device', 'PLATES', '--seconds', '1', '--normal'], {zeroErrors: {LEFT: 1}}, {env: {...INTERACTIVE, zeroTiming: FAST}});
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(result.fake.rezeroes, [REZERO_LEFT, REZERO_RIGHT]);
        assert.match(result.stdout, /this firmware cannot report load while calibrating\. Make sure nothing presses on the plates\./);
    });

    it('no zero result from the companion: exit 4 after the step timeout', async () => {
        const result = await run(
            ['--device', 'PLATES', '--seconds', '1', '--normal'],
            {baselineErrorCheck: true, zeroSilent: true},
            {env: {...INTERACTIVE, zeroTiming: {...FAST, zeroStepTimeoutMs: 100}}},
        );
        assert.equal(result.code, 4);
        assert.match(result.stderr, /did not report the calibration in time/);
    });

    it('a single plate is zeroed alone; other device types are never zeroed or warned about', async () => {
        const single = await run(['--device', 'PLATES', '--single', '--seconds', '1', '--normal'], {baselineErrorCheck: true}, {env: {...INTERACTIVE, zeroTiming: FAST}});
        assert.equal(single.code, 0, single.stderr);
        assert.deepEqual(single.fake.rezeroes, [REZERO_LEFT]);

        const grip = await run(['--device', 'GRIP', '--seconds', '1']);
        assert.equal(grip.code, 0, grip.stderr);
        assert.deepEqual(grip.fake.rezeroes, []);
        assert.doesNotMatch(grip.stdout, /plates/);
    });
});

describe('plates: the sampling rate is chosen from the rates the companion offers', () => {
    const FREQS = {
        ble5Available: false,
        families: [{family: 'plates' as const, options: [75, 100, 125, 200, 250, 300, 500, 1000].map((rate) => ({rate})), ble5OnlyOptions: [], current: {rate: 250}}],
    };
    const terminal = (answers: string[], asked: string[]) => () => ({
        ask: async (prompt: string) => {
            asked.push(prompt);
            return answers.shift();
        },
        close: () => undefined,
    });
    const ARGS = ['--device', 'PLATES', '--seconds', '1', '--pair', '--normal'];
    const puts = (fake: FakeCompanion) => fake.requests.filter((request) => request.method === 'PUT').map((request) => request.body);

    it('lists the rates with the current one marked; a menu number sets that rate before the activity', async () => {
        const asked: string[] = [];
        const result = await run(ARGS, {frequencies: FREQS}, {env: {makeReader: terminal(['7'], asked)}});
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(asked, ['Sampling rate (1-8, Enter keeps 250 Hz): ']);
        assert.match(result.stdout, /Sampling rate for the K-Plates\?\n  1\. 75 Hz\n/);
        assert.match(result.stdout, /  5\. 250 Hz \(current\)\n/);
        assert.deepEqual(puts(result.fake), [{family: 'plates', rate: 500}]);
        const commands = result.fake.commands();
        assert.ok(commands.indexOf('PUT /settings/frequencies') < commands.indexOf('POST /activity/prepare'));
    });

    it('Enter keeps the current rate and changes nothing; "1000 Hz" picks by value; a wrong answer asks again', async () => {
        const kept = await run(ARGS, {frequencies: FREQS}, {env: {makeReader: terminal([''], [])}});
        assert.equal(kept.code, 0, kept.stderr);
        assert.deepEqual(puts(kept.fake), []);
        assert.match(kept.stdout, /Sampling rate stays at 250 Hz\./);

        const asked: string[] = [];
        const byValue = await run(ARGS, {frequencies: FREQS}, {env: {makeReader: terminal(['90', '1000 Hz'], asked)}});
        assert.equal(byValue.code, 0, byValue.stderr);
        assert.equal(asked.length, 2);
        assert.match(byValue.stdout, /90 Hz is not offered\./);
        assert.deepEqual(puts(byValue.fake), [{family: 'plates', rate: 1000}]);
    });

    it('--rate skips the question; no terminal keeps the rate; other devices are not asked', async () => {
        const asked: string[] = [];
        const flagged = await run([...ARGS, '--rate', '300'], {frequencies: FREQS}, {env: {makeReader: terminal([], asked)}});
        assert.equal(flagged.code, 0, flagged.stderr);
        assert.deepEqual(puts(flagged.fake), [{family: 'plates', rate: 300}]);

        const scripted = await run(ARGS, {frequencies: FREQS});
        assert.equal(scripted.code, 0, scripted.stderr);
        assert.deepEqual(puts(scripted.fake), []);

        const grip = await run(['--device', 'GRIP', '--seconds', '1'], {}, {env: {makeReader: terminal([], asked)}});
        assert.equal(grip.code, 0, grip.stderr);
        assert.deepEqual(asked, []);
    });
});

describe('Deltas and 3D Deltas: calibrated as in the mobile app, and the rate can be chosen', () => {
    const FAST = {zeroRetryMs: 10, zeroStepTimeoutMs: 2000, stillWindowMs: 60};
    const terminal = (answers: string[], asked: string[]) => () => ({
        ask: async (prompt: string) => {
            asked.push(prompt);
            return answers.shift();
        },
        close: () => undefined,
    });
    const puts = (fake: FakeCompanion) => fake.requests.filter((request) => request.method === 'PUT').map((request) => request.body);

    it('K-Deltas: the warning, a failed calibration with the app\'s words, recalibrated until it passes', async () => {
        const result = await run(
            ['--device', 'HEXAS', '--seconds', '1', '--pair', '--normal'],
            {baselineErrorCheck: true, zeroErrors: {RIGHT: 1}},
            {env: {...INTERACTIVE, zeroTiming: FAST}},
        );
        assert.equal(result.code, 0, result.stderr);
        const out = result.stdout;
        assert.match(out, /Do not step on the Deltas: they are calibrated while they connect\. Use them only when told\./);
        assert.match(out, /Calibrating the Deltas\. Keep them free of load…/);
        assert.match(out, /Calibration has failed \([^:]+: forces were being applied\)\. Please release the device\. Waiting until nothing moves…/);
        assert.match(out, /Release the device\. Waiting until nothing moves on the Deltas…/);
        assert.match(out, /Deltas calibrated\./);
        assert.match(out, /You can use the Deltas now\. The recording starts after the countdown\./);
        assert.deepEqual(result.fake.rezeroes, [FAKE_DEVICE_ID, FAKE_RIGHT_ID, FAKE_RIGHT_ID]);
    });

    it('K-Deltas 3D: zeroed once each, never failed (the app skips their check), with a warning', async () => {
        const result = await run(
            ['--device', 'DELTAS_3D', '--seconds', '1', '--pair'],
            {baselineErrorCheck: true, zeroErrors: {LEFT: 5, RIGHT: 5}},
            {env: {...INTERACTIVE, zeroTiming: FAST}},
        );
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(result.fake.rezeroes, [FAKE_DEVICE_ID, FAKE_RIGHT_ID]);
        assert.match(result.stdout, /The 3D Deltas do not check their calibration \(as in the mobile app\)\. Make sure nothing presses on them\./);
        assert.match(result.stdout, /3D Deltas calibrated\./);
        assert.doesNotMatch(result.stdout, /Calibration has failed/);
    });

    it('K-Deltas 3D rate: the Bluetooth-5-only rates are offered only with Bluetooth 5', async () => {
        const family = (ble5Available: boolean) => ({
            ble5Available,
            families: [
                {family: 'deltas3d' as const, options: [75, 100, 125, 200, 250, 300].map((rate) => ({rate})), ble5OnlyOptions: [500, 1000].map((rate) => ({rate})), current: {rate: 250}},
            ],
        });
        const asked: string[] = [];
        const without = await run(['--device', 'DELTAS_3D', '--seconds', '1', '--pair', '--normal'], {frequencies: family(false)}, {env: {zeroTiming: FAST, makeReader: terminal([''], asked)}});
        assert.equal(without.code, 0, without.stderr);
        assert.deepEqual(asked, ['Sampling rate (1-6, Enter keeps 250 Hz): ']);
        assert.match(without.stdout, /Sampling rate for the K-Deltas 3D\?/);

        asked.length = 0;
        const withBle5 = await run(['--device', 'DELTAS_3D', '--seconds', '1', '--pair', '--normal'], {frequencies: family(true)}, {env: {zeroTiming: FAST, makeReader: terminal(['8'], asked)}});
        assert.equal(withBle5.code, 0, withBle5.stderr);
        assert.deepEqual(asked, ['Sampling rate (1-8, Enter keeps 250 Hz): ']);
        assert.deepEqual(puts(withBle5.fake), [{family: 'deltas3d', rate: 1000}]);
    });

    it('K-Deltas rate: asked for a normal test from the deltas family; a jump test with --rate asks nothing', async () => {
        const frequencies = {
            ...DEFAULT_FREQUENCIES,
            families: [...DEFAULT_FREQUENCIES.families, {family: 'deltas' as const, options: [250, 300, 500, 1000].map((rate) => ({rate})), ble5OnlyOptions: [], current: {rate: 250}}],
        };
        const asked: string[] = [];
        const normal = await run(['--device', 'HEXAS', '--seconds', '1', '--pair', '--normal'], {frequencies}, {env: {zeroTiming: FAST, makeReader: terminal(['2'], asked)}});
        assert.equal(normal.code, 0, normal.stderr);
        assert.deepEqual(asked, ['Sampling rate (1-4, Enter keeps 250 Hz): ']);
        assert.deepEqual(puts(normal.fake), [{family: 'deltas', rate: 300}]);

        asked.length = 0;
        const jump = await run(['--device', 'HEXAS', '--seconds', '1', '--single', '--jump', '--rate', '1000'], {frequencies, jump: 'v3'}, {env: {zeroTiming: FAST, makeReader: terminal([], asked)}});
        assert.equal(jump.code, 0, jump.stderr);
        assert.deepEqual(asked, [], 'with --rate the jump test asks nothing');
    });
});

describe('a dead radio', () => {
    it('adapter state unsupported: exit 2 at once with the restart advice, no waiting for sensors', async () => {
        const started = Date.now();
        const result = await run(['--device', 'HEXAS', '--seconds', '1', '--pair', '--normal', '--connect-timeout', '30'], {adapterState: 'unsupported'});
        assert.equal(result.code, 2);
        assert.match(result.stderr, /Bluetooth radio is not usable \(adapter state: unsupported\)\. Restart the Kinvent Companion app and run again\./);
        assert.ok(Date.now() - started < 5000, 'did not wait for the connect timeout');
        assert.equal(result.fake.count('POST', '/activity/stop'), 1);
        assert.equal(result.fake.count('POST', '/session/release'), 1);
    });
});

describe('pairs: a 3D Delta may fill a K-Deltas slot, as in the mobile app', () => {
    const FAST = {zeroRetryMs: 10, zeroStepTimeoutMs: 2000, stillWindowMs: 60};
    const prepares = (fake: FakeCompanion) => fake.prepareBodies.map((body) => body.exclude);

    it('K-Deltas + a 3D Delta: prepared once, recorded as it is; only the K-Delta is remembered', async () => {
        const registryPath = join(SCRATCH, 'mixed.json');
        const result = await run(['--device', 'HEXAS', '--seconds', '1', '--pair', '--normal'], {oddRight: true}, {env: {zeroTiming: FAST, registryPath}});
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(prepares(result.fake), [[]], 'one prepare, nothing excluded');
        assert.doesNotMatch(result.stdout, /Leaving out|not all K-Deltas/);
        assert.match(result.stdout, /Devices ready: [^\n]*\(HEXAS\), [^\n]*\(DELTAS_3D\)\./);
        assert.deepEqual(readRegistered(registryPath, DeviceType.HEXAS).map((entry) => entry.deviceId), [FAKE_DEVICE_ID]);
    });

    it('a 3D Deltas pair is prepared once (a K-Delta never fills a 3D Deltas slot)', async () => {
        const result = await run(['--device', 'DELTAS_3D', '--seconds', '1', '--pair'], {oddRight: true}, {env: {zeroTiming: FAST}});
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(prepares(result.fake), [[]]);
        assert.match(result.stdout, /Devices ready: [^\n]*\(DELTAS_3D\), [^\n]*\(DELTAS_3D\)\./);
    });
});

describe('pairs: the sensors used last time are tried first (the mobile app\'s registered devices)', () => {
    const FAST = {zeroRetryMs: 10, zeroStepTimeoutMs: 2000, stillWindowMs: 60};
    const ARGS = ['--device', 'HEXAS', '--seconds', '1', '--pair', '--normal'];

    it('the pair recorded is remembered; the next run hands it to the companion, which connects it before any scan', async () => {
        const registryPath = join(SCRATCH, 'remember.json');
        const first = await run(ARGS, {}, {env: {zeroTiming: FAST, registryPath}});
        assert.equal(first.code, 0, first.stderr);
        assert.deepEqual(first.fake.registeredSent, [[]], 'nothing remembered yet: a scan');
        assert.deepEqual(readRegistered(registryPath, DeviceType.HEXAS).map((entry) => entry.deviceId), [FAKE_DEVICE_ID, FAKE_RIGHT_ID]);

        // With the pair remembered, a 3D Delta nearby cannot take the RIGHT slot: the remembered RIGHT is connected first.
        const second = await run(ARGS, {oddRight: true}, {env: {zeroTiming: FAST, registryPath}});
        assert.equal(second.code, 0, second.stderr);
        assert.deepEqual(second.fake.registeredSent, [[FAKE_DEVICE_ID, FAKE_RIGHT_ID]], 'one prepare, with last time\'s pair');
        assert.match(second.stdout, /Trying the sensors used last time first \(Example Deltas L, Example Deltas R\)\./);
        assert.doesNotMatch(second.stdout, /Leaving out/);
        assert.match(second.stdout, /Devices ready: [^\n]*\(HEXAS\), [^\n]*\(HEXAS\)\./);
    });

    it('a remembered sensor that does not answer is dropped: the next one is tried, then a scan; the new pair is remembered', async () => {
        const registryPath = join(SCRATCH, 'absent.json');
        rememberDevices(registryPath, DeviceType.HEXAS, [
            {...snapshotLike('gone-left', 'Example Deltas L old', 'LEFT')},
            {...snapshotLike('gone-right', 'Example Deltas R old', 'RIGHT')},
        ]);
        const result = await run(ARGS, {registeredAbsent: ['gone-left', 'gone-right']}, {env: {zeroTiming: FAST, registryPath}});
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(result.fake.registeredSent, [['gone-left', 'gone-right'], ['gone-right'], []]);
        assert.match(result.stdout, /Example Deltas L old did not answer\. Trying the next remembered sensor…/);
        assert.match(result.stdout, /Example Deltas R old did not answer\. Scanning for sensors instead…/);
        assert.deepEqual(readRegistered(registryPath, DeviceType.HEXAS).map((entry) => entry.deviceId), [FAKE_DEVICE_ID, FAKE_RIGHT_ID]);
    });

    it('--forget-devices: the remembered pair is dropped before the run, which scans', async () => {
        const registryPath = join(SCRATCH, 'forget.json');
        rememberDevices(registryPath, DeviceType.HEXAS, [snapshotLike('old-left', 'Example Deltas L old', 'LEFT')]);
        const result = await run([...ARGS, '--forget-devices'], {}, {env: {zeroTiming: FAST, registryPath}});
        assert.equal(result.code, 0, result.stderr);
        assert.match(result.stdout, /Forgot the K-Deltas sensors used last time; scanning afresh\./);
        assert.deepEqual(result.fake.registeredSent, [[]]);
    });

    it('one-sensor types are not remembered (a user swaps a K-Grip V2 for a V3 freely)', async () => {
        const registryPath = join(SCRATCH, 'grip.json');
        const result = await run(['--device', 'GRIP', '--seconds', '1'], {}, {env: {registryPath}});
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(readRegistered(registryPath, DeviceType.GRIP), []);
    });
});

describe('K-Deltas jump test: the jump rate is chosen from both ballistic families', () => {
    const FAST = {zeroRetryMs: 10, zeroStepTimeoutMs: 2000, stillWindowMs: 60};
    const terminal = (answers: string[], asked: string[]) => () => ({
        ask: async (prompt: string) => {
            asked.push(prompt);
            return answers.shift();
        },
        close: () => undefined,
    });
    const puts = (fake: FakeCompanion) => fake.requests.filter((request) => request.method === 'PUT').map((request) => request.body);

    it('lists the union of the jump rates, names the XL-only one; no "current" while the families are not in jump mode; a choice sets both', async () => {
        const asked: string[] = [];
        const result = await run(['--device', 'HEXAS', '--seconds', '1', '--single', '--jump'], {jump: 'v3'}, {env: {zeroTiming: FAST, makeReader: terminal(['', '3'], asked)}});
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(asked, ['Sampling rate (1-4): ', 'Sampling rate (1-4): '], 'Enter is not an answer when there is no one current jump rate');
        assert.match(result.stdout, /Sampling rate for the K-Deltas jump test\?\n  1\. 500 Hz\n  2\. 1000 Hz\n  3\. 2000 Hz\n  4\. 4000 Hz \(K-Deltas XL only\)\n/);
        assert.match(result.stdout, /Please type a number from 1 to 4\./);
        assert.deepEqual(puts(result.fake), [
            {family: 'deltasMiniBallistic', rate: 2000, mode: 'jumpProtocol'},
            {family: 'deltasXlBallistic', rate: 2000, mode: 'jumpProtocol'},
        ]);
    });

    it('at a terminal, the zero comes first: a normal prepare, the zero, then the jump prepare; the jump layout only at the recording', async () => {
        const result = await run(['--device', 'HEXAS', '--seconds', '1', '--single', '--jump', '--rate', '1000'], {jump: 'v3', baselineErrorCheck: true}, {env: {zeroTiming: FAST, ...INTERACTIVE}});
        assert.equal(result.code, 0, result.stderr);
        const bodies = result.fake.prepareBodies;
        assert.equal(bodies.length, 2, 'two prepares');
        assert.ok(!('exerciseType' in bodies[0]!), 'the first is a normal activity (for the zero)');
        assert.equal(bodies[1]!.exerciseType, 'JUMP_ANALYSIS', 'the second is the jump test');
        const commands = result.fake.commands();
        const rezero = commands.indexOf(`POST /devices/${FAKE_DEVICE_ID}/rezero`);
        const secondPrepare = commands.lastIndexOf('POST /activity/prepare');
        assert.ok(rezero > 0 && rezero < secondPrepare, 'zeroed before the jump prepare');
        assert.match(result.stdout, /Deltas calibrated\.\n.*Switching the K-Deltas to the jump test \(the zero just taken is kept\)…/s);
        assert.equal(result.fake.measureStarts, 2, 'the stillness measurement, then the recording');
        // The layout changed at the recording's start, not before: the file says jump, as a jump test must.
        assert.match(result.stdout, /Done\. \d+ samples in 1\.0 s from K-Deltas \(HEXAS\)/);
    });

    it('when both families already jump at one rate, Enter keeps it and nothing is sent', async () => {
        const frequencies = {
            ...DEFAULT_FREQUENCIES,
            families: DEFAULT_FREQUENCIES.families.map((family) =>
                family.family === 'deltasMiniBallistic' || family.family === 'deltasXlBallistic' ? {...family, current: {rate: 1000, mode: 'jumpProtocol' as const}} : family,
            ),
        };
        const asked: string[] = [];
        const result = await run(['--device', 'HEXAS', '--seconds', '1', '--single', '--jump'], {jump: 'v3', frequencies}, {env: {zeroTiming: FAST, makeReader: terminal([''], asked)}});
        assert.equal(result.code, 0, result.stderr);
        assert.deepEqual(asked, ['Sampling rate (1-4, Enter keeps 1000 Hz): ']);
        assert.match(result.stdout, /  2\. 1000 Hz \(current\)\n/);
        assert.deepEqual(puts(result.fake), []);
    });
});
