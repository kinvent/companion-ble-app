/**
 * Integration: the real CLI flow (`runCli`) and the real SDK client over the fake companion, from
 * "device ready" to the end of the recording.
 *
 * The fake answers `GET /streams` with the SDK's layout and, after `measure/start`, sends real
 * binary frames made with `encodeSampleFrame` at 100 Hz (2 samples every 20 ms), the first one before the
 * HTTP answer. Every value is synthetic.
 */
import {strict as assert} from 'node:assert';
import {EventEmitter} from 'node:events';
import {existsSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {basename, dirname, isAbsolute, join} from 'node:path';
import {Writable} from 'node:stream';
import {after, before, describe, it} from 'node:test';
import {VERSION} from '@kinvent/companion-sdk';
import {runCli, type RunEnv} from '../../src/run.js';
import type {ExitCode} from '../../src/exit.js';
import {openFileSink, type OpenSink} from '../../src/recorder.js';
import {FAKE_DEVICE_ID, FakeCompanion, type FakeOptions} from '../doubles/fakeCompanion.js';
import {findRow, parseCsv, sampleRows, summaryValue, values, type Csv} from '../doubles/rfc4180.js';

/** Every run records into its own scratch folder (the current folder of the run). */
const SCRATCH = mkdtempSync(join(tmpdir(), 'cli-sample-record-'));
after(() => rmSync(SCRATCH, {recursive: true, force: true}));
let runs = 0;
const CWD_OF = new WeakMap<FakeCompanion, string>();
/** The current folder of the run that uses `fake`. */
const cwdOf = (fake: FakeCompanion): string => CWD_OF.get(fake)!;

interface Outcome {
    code: ExitCode;
    stdout: string;
    stderr: string;
    fake: FakeCompanion;
    /** The run's current folder; the file is under `recordings/` there unless `--out` says otherwise. */
    cwd: string;
}

interface RunOptions {
    tty?: boolean;
    signals?: EventEmitter;
    /** Called with the fake once it is created, before the run starts. */
    onFake?: (fake: FakeCompanion, signals: EventEmitter) => void;
    /** Where the output accumulates while the run is going (for a test that looks during the run). */
    sink?: {stdout: string; stderr: string};
    /** Extra environment (seams: `openSink`, `exit`, `makeReader`, `now`). */
    env?: Partial<RunEnv>;
}

async function run(argv: string[], options: FakeOptions = {}, extra: RunOptions = {}): Promise<Outcome> {
    const fake = new FakeCompanion(options);
    const cwd = join(SCRATCH, `run-${++runs}`);
    CWD_OF.set(fake, cwd);
    const signals = extra.signals ?? new EventEmitter();
    extra.onFake?.(fake, signals);
    const sink = extra.sink ?? {stdout: '', stderr: ''};
    const code = await runCli({
        argv,
        stdout: {write: (text) => void (sink.stdout += text)},
        stderr: {write: (text) => void (sink.stderr += text)},
        version: 'test',
        registryPath: join(SCRATCH, 'registry.json'),
        zeroTiming: {stillWindowMs: 60, zeroStepTimeoutMs: 2000},
        makeReader: undefined,
        signals,
        clientOptions: {fetchImpl: fake.fetch, webSocketImpl: fake.WebSocket, busyPollMs: 5, idlePollMs: 10, activityTailMs: 20},
        keepAliveMs: 40,
        teardownStepTimeoutMs: 1000,
        stdoutIsTTY: extra.tty === true,
        countdownStepMs: 30,
        liveTickMs: 50,
        cwd,
        ...extra.env,
    });
    assert.equal(signals.listenerCount('SIGINT'), 0, 'the SIGINT listener must be removed on exit');
    return {code, stdout: sink.stdout, stderr: sink.stderr, fake, cwd};
}

const START = 'POST /devices/fake-device-0001/measure/start';
const STOP = 'POST /devices/fake-device-0001/measure/stop';

function count(fake: FakeCompanion, command: string): number {
    return fake.commands().filter((entry) => entry === command).length;
}

/** Session hygiene: released once, activity stopped once; a running measurement stopped first. */
function assertHygiene(fake: FakeCompanion, expect: {measureStop: number}): void {
    const commands = fake.commands();
    assert.equal(fake.count('POST', '/session/release'), 1, 'released exactly once');
    assert.equal(fake.count('POST', '/activity/stop'), 1, 'activity stopped exactly once');
    assert.equal(count(fake, STOP), expect.measureStop, 'measure/stop count');
    if (expect.measureStop > 0) assert.ok(commands.indexOf(STOP) < commands.indexOf('POST /activity/stop'), 'measureStop before stopActivity');
    assert.ok(commands.indexOf('POST /activity/stop') < commands.indexOf('POST /session/release'), 'stop before release');
}

/** The number in "Done. N samples in …" / "Stopped by Ctrl-C. N samples …". */
function summarySamples(stdout: string): number {
    const match = /(?:Done\.|Stopped by Ctrl-C\.|Ended early\.) (\d+) samples in/.exec(stdout);
    assert.ok(match, `no summary in:\n${stdout}`);
    return Number(match[1]);
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

const GRIP_1S = ['--device', 'GRIP', '--seconds', '1', '--connect-timeout', '5'];

describe('record: the happy path', () => {
    it('descriptor → countdown → measureStart → live values → measureStop at time end → summary, exit 0', async () => {
        // What the user had seen when measure/start reached the companion.
        const sink = {stdout: '', stderr: ''};
        let seenAtStart: string | undefined;
        const {code, stdout, stderr, fake} = await run(GRIP_1S, {}, {
            sink,
            onFake: (f) => {
                const original = f.fetch;
                (f as {fetch: typeof fetch}).fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
                    if (String(input).endsWith('/measure/start')) seenAtStart = sink.stdout;
                    return original(input, init);
                }) as typeof fetch;
            },
        });
        assert.equal(code, 0, stderr);
        assert.ok(seenAtStart !== undefined, 'measure/start sent');
        assert.match(seenAtStart, /Starting in 3…\nStarting in 2…\nStarting in 1…\n$/, 'measureStart after the whole countdown, not before');

        assert.match(stdout, /Fields: force1 — from the companion's stream descriptor \(GET \/streams\)\./);
        assert.equal(fake.count('GET', '/streams'), 1);
        assert.match(stdout, /Starting in 3…\nStarting in 2…\nStarting in 1…\nRecording for 1 s…/);
        // The order of the requests: start after the countdown output, stop at the end, then the activity, then release.
        const commands = fake.commands();
        assert.equal(count(fake, START), 1);
        assert.ok(commands.indexOf(START) < commands.indexOf(STOP));
        assertHygiene(fake, {measureStop: 1});

        // Not a terminal: plain lines, every field with its unit after the value, no escape code.
        assert.ok(!stdout.includes('\u001b'), 'no escape code when stdout is not a terminal');
        assert.match(stdout, /force1 \d+\.\d{2} kg/);
        assert.match(stdout, /75 Hz measured|\d+ Hz measured/);

        // The summary counts exactly the samples the fake sent.
        assert.ok(fake.emittedSamples > 0);
        assert.equal(summarySamples(stdout), fake.emittedSamples);
        assert.match(stdout, /from K-Grip \(GRIP\), \d+\.\d Hz measured; no data lost\./);
        assert.match(stdout, /Saved \d+ rows to \/.*\/recordings\/GRIP-\d{8}-\d{6}\.csv\n/);
        // About 100 Hz for about 1 s (loose: timers on a busy CI machine).
        assert.ok(fake.emittedSamples >= 60 && fake.emittedSamples <= 140, `samples ${fake.emittedSamples}`);
    });

    it('the measured value is the LAST sample of the last frame, read at the field index', async () => {
        const {code, stdout, fake} = await run(GRIP_1S);
        assert.equal(code, 0);
        const lastLine = stdout.split('\n').filter((line) => line.includes(' Hz measured  |  ')).at(-1)!;
        // force1 is channels[0]; the fake's channel 0 of sample n is 1 + n/100.
        assert.ok(lastLine.includes(`force1 ${fake.lastSample!.channels[0]!.toFixed(2)} kg`), lastLine);
    });

    it('on a terminal: the block is redrawn in place with ANSI escapes and shows every field with its unit', async () => {
        // `--single`, so this stays the one-device block (the pair's block is in pair.test.ts).
        const {code, stdout} = await run(['--device', 'PLATES', '--single', '--seconds', '1'], {numOfChannels: 4}, {tty: true});
        assert.equal(code, 0);
        assert.match(stdout, /\u001b\[\d+A/, 'cursor up');
        assert.match(stdout, /\u001b\[2K/, 'clear line');
        assert.match(stdout, /K-Plates \(PLATES\) {2}· {2}75 Hz set \(device configuration\) {2}· {2}\d+ Hz measured/);
        for (const name of ['force1', 'force2', 'force3', 'force4']) {
            assert.match(stdout, new RegExp(`  ${name}  +\\d+\\.\\d{2} kg\\n`), name);
        }
    });

    it('K-Bubble: force1 in kg; K-Deltas 3D: nine kg fields (the always-zero slot 3 is not listed)', async () => {
        const bubble = await run(['--device', 'BUBBLE', '--seconds', '1']);
        assert.equal(bubble.code, 0);
        assert.match(bubble.stdout, /force1 +\d+\.\d{2} kg/);
        assert.doesNotMatch(bubble.stdout, /mbar|pressure/);
        const deltas = await run(['--device', 'DELTAS_3D', '--single', '--seconds', '1']);
        assert.equal(deltas.code, 0);
        assert.match(deltas.stdout, /Fields: force1, force2, force3, forceX1, forceY1, forceX2, forceY2, forceX3, forceY3 —/);
        assert.match(deltas.stdout, /forceY3 \d+\.\d{2} kg/);
    });

    it('no descriptor entry → the SDK layout, said so', async () => {
        const {code, stdout, fake} = await run(GRIP_1S, {streams: 'empty'});
        assert.equal(code, 0);
        assert.equal(fake.count('GET', '/streams'), 1);
        assert.match(stdout, /Fields: force1 — from the SDK's layout \(streamLayoutOf\); the companion listed no descriptor/);
        assert.match(stdout, /force1 \d+\.\d{2} kg/);
    });

    it('losses: a stream.gap and a device.samplesLost are counted and reported', async () => {
        const {code, stdout, fake} = await run(GRIP_1S, {skipSeqAt: 5, samplesLostAfterFrames: 8});
        assert.equal(code, 0);
        assert.match(stdout, /data loss: 1 gap on the stream \(1 frame missed\), 1 drop by the companion \(5 frames lost\)\./);
        assert.equal(summarySamples(stdout), fake.emittedSamples, 'a gap is a missed frame, not a miscount');
    });
});

describe('record: errors', () => {
    it('E11: a device with no descriptor and no SDK layout → exit 4 before any measurement', async () => {
        // EMG is not in the menu; a described type whose configuration gives no
        // layout reaches the same exit. The EMG sentence is pinned in units.test.ts.
        const {code, stderr, fake} = await run(['--device', 'GRIP', '--seconds', '1'], {layoutMissing: true});
        assert.equal(code, 4);
        assert.match(stderr, /The companion gave no field layout for this K-Grip \(GRIP, protocol not reported\), so this sample cannot label its values\. Nothing was recorded\./);
        assert.equal(count(fake, START), 0, 'never started');
        assert.equal(fake.count('POST', '/session/release'), 1);
        assert.equal(fake.count('POST', '/activity/stop'), 1);
    });

    it('E6: the device disconnects mid-run → exit 5, says when and how many samples, nothing left running', async () => {
        const {code, stdout, stderr, fake} = await run(['--device', 'GRIP', '--seconds', '5'], {disconnectAfterFrames: 10});
        assert.equal(code, 5, stderr);
        assert.match(stderr, /The K-Grip disconnected after \d+\.\d s \(link lost\)\. \d+ samples were received\./);
        assert.equal(summarySamples(stdout), fake.emittedSamples);
        assert.match(stdout, /Ended early\./);
        assert.equal(count(fake, START), 1);
        // The device is gone: no measure/stop for it; the activity is stopped and the session released once.
        assertHygiene(fake, {measureStop: 0});
    });

    it('E7: the session is lost mid-run → exit 5, says so, released at most once', async () => {
        const {code, stdout, stderr, fake} = await run(['--device', 'GRIP', '--seconds', '5'], {loseSessionAfterFrames: 10});
        assert.equal(code, 5, stderr);
        assert.match(stderr, /Lost the companion session after \d+\.\d s \(another app took the sensors\)\. \d+ samples were received\./);
        assert.doesNotMatch(stderr, /disconnected after/, 'reported as the session, not as the device');
        assert.equal(summarySamples(stdout), fake.emittedSamples);
        assert.equal(count(fake, STOP), 0, 'no command can be sent without the session');
        assert.ok(fake.count('POST', '/session/release') <= 1);
        assert.equal(fake.count('POST', '/activity/stop'), 0, 'no session: nothing to stop, and no failed clean-up step');
        assert.doesNotMatch(stderr, /Clean-up step/);
    });

    it('a descriptor error is not fatal: GET /streams 500 → the SDK layout', async () => {
        const {code, stdout} = await run(GRIP_1S, {streams: 'error'});
        assert.equal(code, 0);
        assert.match(stdout, /from the SDK's layout/);
    });
});

describe('record: Ctrl-C', () => {
    async function waitFor(condition: () => boolean, what: string): Promise<void> {
        const started = Date.now();
        while (!condition()) {
            if (Date.now() - started > 5000) assert.fail(`timed out waiting for ${what}`);
            await new Promise((resolve) => setTimeout(resolve, 2));
        }
    }

    it('during the countdown: nothing started, released once, activity stopped once, exit 130', async () => {
        const signals = new EventEmitter();
        let fake!: FakeCompanion;
        let out = '';
        const pending = run(['--device', 'GRIP', '--seconds', '1'], {}, {signals, onFake: (f) => (fake = f)});
        await waitFor(() => fake.count('GET', '/streams') === 1, 'the descriptor read');
        await new Promise((resolve) => setTimeout(resolve, 20)); // inside the 90 ms countdown
        signals.emit('SIGINT');
        const outcome = await pending;
        out = outcome.stdout;
        assert.equal(outcome.code, 130);
        assert.match(outcome.stderr, /Stopped\. Nothing was recorded\./);
        assert.match(out, /Starting in 3…/);
        assert.doesNotMatch(out, /Recording for/);
        assert.equal(count(fake, START), 0, 'measureStart never sent');
        assertHygiene(fake, {measureStop: 0});
        assert.equal(fake.emittedSamples, 0);
    });

    it('during the recording: measureStop once (before stopActivity), released once, summary, exit 130', async () => {
        const signals = new EventEmitter();
        let fake!: FakeCompanion;
        const pending = run(['--device', 'GRIP', '--seconds', '3'], {}, {signals, onFake: (f) => (fake = f)});
        await waitFor(() => fake.emittedFrames >= 10, 'frames');
        signals.emit('SIGINT');
        await new Promise((resolve) => setTimeout(resolve, 5));
        signals.emit('SIGINT');
        const {code, stdout, stderr} = await pending;
        assert.equal(code, 130);
        assert.match(stdout, /Stopped by Ctrl-C\. \d+ samples in \d+\.\d s from K-Grip \(GRIP\)/);
        assert.match(stdout, /Saved \d+ rows to /);
        assert.doesNotMatch(stderr, /Nothing was recorded/);
        assert.equal(count(fake, START), 1);
        assertHygiene(fake, {measureStop: 1});
        assert.ok(summarySamples(stdout) > 0);
    });
});

// ---------------------------------------------------------------------------------------------------
// The file.
// ---------------------------------------------------------------------------------------------------

/** The absolute path in "Saved N rows to <path>" or "Partial data kept: N rows in <path>". */
function savedPath(stdout: string): {rows: number; path: string} {
    const match = /(?:Saved (\d+) rows to |Partial data kept: (\d+) rows in )(\/\S+\.csv)\n/.exec(stdout);
    assert.ok(match, `no file report in:\n${stdout}`);
    return {rows: Number(match[1] ?? match[2]), path: match[3]!};
}

function readCsv(path: string): Csv {
    return parseCsv(readFileSync(path, 'utf8'));
}

describe('record: the file', () => {
    it('the file holds every frame sent, first batch included, as rows; Rows = the frames; time end; mode 0600 in ./recordings (0700)', async () => {
        // At the moment measure/stop reaches the companion, the file must not have its Summary yet.
        let summaryAtStop: boolean | undefined;
        let fileAtStop = '';
        const {code, stdout, fake, cwd} = await run(GRIP_1S, {}, {
            onFake: (f) => {
                const original = f.fetch;
                (f as {fetch: typeof fetch}).fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
                    if (String(input).endsWith('/measure/stop')) {
                        const folder = join(cwdOf(f), 'recordings');
                        const name = readdirSync(folder).find((entry) => entry.endsWith('.csv'))!;
                        fileAtStop = readFileSync(join(folder, name), 'utf8');
                        summaryAtStop = fileAtStop.includes('"Summary"');
                    }
                    return original(input, init);
                }) as typeof fetch;
            },
        });
        assert.equal(code, 0);
        const {rows, path} = savedPath(stdout);
        assert.ok(isAbsolute(path));
        assert.equal(dirname(path), join(cwd, 'recordings'));
        assert.match(basename(path), /^GRIP-\d{8}-\d{6}\.csv$/);
        assert.equal(statSync(path).mode & 0o777, 0o600);
        assert.equal(statSync(dirname(path)).mode & 0o777, 0o700);
        assert.match(stdout, /This file contains sensor data of a person\. Keep it on this computer/);
        assert.equal(summaryAtStop, false, 'the Summary is written AFTER measureStop');
        assert.ok(fileAtStop.includes('"Raw Channel Data"'), 'the preamble was on disk before the stop');

        const csv = readCsv(path);
        const table = sampleRows(csv);
        assert.equal(table.length, fake.sentSamples.length, 'one row per sample sent, the first batch included');
        assert.equal(rows, fake.sentSamples.length);
        const first = fake.sentSamples[0]!.timeStamp;
        table.forEach((row, n) => {
            const sent = fake.sentSamples[n]!;
            assert.deepEqual(values(row), [String((sent.timeStamp - first) / 1000), sent.channels[0]!.toFixed(15)], `row ${n}`);
        });
        assert.equal(summaryValue(csv, 'Rows'), String(fake.emittedSamples));
        assert.equal(summaryValue(csv, 'Samples lost'), '0');
        assert.equal(summaryValue(csv, 'Gaps'), '0');
        assert.equal(summaryValue(csv, 'End reason'), 'time end');
        assert.deepEqual(values(csv[0]!), ['Kinvent Companion SDK sample test', `Companion ${VERSION}`, `companion-sdk ${VERSION}`, 'Devices:', 'K-Grip']);
        assert.deepEqual(values(csv[findRow(csv, 'Device type')]!), ['Device type', 'GRIP']);
        assert.deepEqual(values(csv[findRow(csv, 'Sample rate set (Hz)')]!), ['Sample rate set (Hz)', '75']);
        assert.equal(findRow(csv, 'Sample rate (Hz)'), -1, 'the set rate is labelled "set"');
        // The measured rate: right after Rows, the rate of the rows, and the same number the end message prints.
        const summary = findRow(csv, 'Summary');
        assert.equal(findRow(csv, 'Sample rate measured (Hz)', summary), findRow(csv, 'Rows', summary) + 1);
        const measured = summaryValue(csv, 'Sample rate measured (Hz)')!;
        assert.match(measured, /^\d+\.\d$/);
        const lastTime = Number(table.at(-1)![0]!.value);
        assert.equal(measured, ((table.length - 1) / lastTime).toFixed(1));
        assert.equal(/, (\d+\.\d) Hz measured; /.exec(stdout)?.[1], measured, 'the printed rate is the written rate');
        assert.deepEqual(values(csv[findRow(csv, 'CHANNEL_1')]!), ['CHANNEL_1', 'force1', 'kg', 'KILOGRAM']);
        assert.deepEqual(values(csv[findRow(csv, 'Time (sec)')]!), ['Time (sec)', 'CHANNEL_1']);
        assert.ok(!readFileSync(path, 'utf8').includes(FAKE_DEVICE_ID), 'no device id in the file');
    });

    it('--out <folder>: the file goes there; a 4-field K-Plates writes CHANNEL_1..4 in descriptor order; losses in the Summary', async () => {
        const out = join(SCRATCH, 'chosen-out');
        const {code, stdout, fake} = await run(['--device', 'PLATES', '--single', '--seconds', '1', '--out', out], {numOfChannels: 4, skipSeqAt: 5, samplesLostAfterFrames: 8});
        assert.equal(code, 0);
        const {path} = savedPath(stdout);
        assert.equal(dirname(path), out);
        const csv = readCsv(path);
        assert.deepEqual(values(csv[findRow(csv, 'Time (sec)')]!), ['Time (sec)', 'CHANNEL_1', 'CHANNEL_2', 'CHANNEL_3', 'CHANNEL_4']);
        assert.deepEqual(values(csv[findRow(csv, 'Time (sec)') - 1]!), ['', 'K-Plates', '', '', '']);
        const table = sampleRows(csv);
        assert.equal(table.length, fake.sentSamples.length);
        assert.deepEqual(values(table.at(-1)!).slice(1), fake.sentSamples.at(-1)!.channels.slice(0, 4).map((value) => value.toFixed(15)));
        assert.equal(summaryValue(csv, 'Gaps'), '1');
        assert.equal(summaryValue(csv, 'Samples lost'), '5');
    });

    it('--include-serial: the serial is in the traceability row only; without the flag it is nowhere', async () => {
        const withSerial = await run([...GRIP_1S, '--include-serial'], {serialCode: 'SYN-SERIAL-01'});
        assert.equal(withSerial.code, 0);
        const path = savedPath(withSerial.stdout).path;
        assert.ok(!path.includes('SYN'), 'never in the name');
        const text = readFileSync(path, 'utf8');
        assert.equal(values(parseCsv(text)[0]!)[4], 'K-Grip (serial SYN-SERIAL-01)');
        assert.equal(text.split('SYN-SERIAL-01').length, 2, 'once, in the traceability row');

        const without = await run(GRIP_1S, {serialCode: 'SYN-SERIAL-01'});
        assert.equal(without.code, 0);
        assert.ok(!readFileSync(savedPath(without.stdout).path, 'utf8').includes('SYN-SERIAL-01'));
    });

    it('E6: device lost → the Summary says "device lost", the rows are kept, exit 5', async () => {
        const {code, stdout, stderr, fake} = await run(['--device', 'GRIP', '--seconds', '5'], {disconnectAfterFrames: 10});
        assert.equal(code, 5, stderr);
        const csv = readCsv(savedPath(stdout).path);
        assert.equal(summaryValue(csv, 'End reason'), 'device lost');
        assert.equal(sampleRows(csv).length, fake.emittedSamples);
        assert.equal(summaryValue(csv, 'Rows'), String(fake.emittedSamples));
    });

    it('E7: session lost → the Summary says "session lost", exit 5', async () => {
        const {code, stdout} = await run(['--device', 'GRIP', '--seconds', '5'], {loseSessionAfterFrames: 10});
        assert.equal(code, 5);
        assert.equal(summaryValue(readCsv(savedPath(stdout).path), 'End reason'), 'session lost');
    });

    it('Ctrl-C mid-recording → "End reason","Ctrl-C", written after the teardown\'s measureStop, exit 130', async () => {
        const signals = new EventEmitter();
        let fake!: FakeCompanion;
        let summaryAtStop: boolean | undefined;
        const pending = run(['--device', 'GRIP', '--seconds', '3'], {}, {
            signals,
            onFake: (f) => {
                fake = f;
                const original = f.fetch;
                (f as {fetch: typeof fetch}).fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
                    if (String(input).endsWith('/measure/stop')) {
                        const folder = join(cwdOf(f), 'recordings');
                        const name = readdirSync(folder).find((entry) => entry.endsWith('.csv'))!;
                        summaryAtStop = readFileSync(join(folder, name), 'utf8').includes('"Summary"');
                    }
                    return original(input, init);
                }) as typeof fetch;
            },
        });
        await waitUntil(() => fake.emittedFrames >= 10, 'frames');
        signals.emit('SIGINT');
        const {code, stdout} = await pending;
        assert.equal(code, 130);
        assert.equal(summaryAtStop, false);
        const csv = readCsv(savedPath(stdout).path);
        assert.equal(summaryValue(csv, 'End reason'), 'Ctrl-C');
        assert.equal(summaryValue(csv, 'Rows'), String(sampleRows(csv).length));
        assertHygiene(fake, {measureStop: 1});
    });

    it('Ctrl-C during the countdown creates no file', async () => {
        const signals = new EventEmitter();
        let fake!: FakeCompanion;
        const pending = run(['--device', 'GRIP', '--seconds', '1'], {}, {signals, onFake: (f) => (fake = f)});
        await waitUntil(() => fake.count('GET', '/streams') === 1, 'the descriptor read');
        signals.emit('SIGINT');
        const {code, cwd, stdout} = await pending;
        assert.equal(code, 130);
        assert.ok(!existsSync(join(cwd, 'recordings')), 'no folder, no file');
        assert.doesNotMatch(stdout, /Saved/);
    });

    it('E8: the disk fills mid-run → the sensor is stopped, the session released, exit 6, path and rows said, no Summary', async () => {
        let writes = 0;
        const fullDisk: OpenSink = async (target) => {
            const real = await openFileSink(target);
            return new Writable({
                write(chunk: Buffer, encoding, callback) {
                    writes += 1;
                    if (writes >= 6) {
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
        const {code, stdout, stderr, fake} = await run(['--device', 'GRIP', '--seconds', '5'], {}, {env: {openSink: fullDisk}});
        assert.equal(code, 6, stderr);
        const {rows, path} = savedPath(stdout);
        assert.match(stdout, /Partial data kept: \d+ rows in /);
        assert.match(stdout, /The Summary section could not be written/);
        assert.match(stderr, new RegExp(`Could not write ${escapeRegExp(path)}: disk full\\. The file is incomplete: ${rows} rows were written\\. The sensor was stopped\\.`));
        assertHygiene(fake, {measureStop: 1});
        assert.ok(fake.emittedSamples < 400, 'stopped early, not at the 5 s time end');
        await new Promise((resolve) => setTimeout(resolve, 20));
        const csv = readCsv(path);
        assert.equal(sampleRows(csv).length, rows, 'the file parses up to the last row written');
        assert.equal(summaryValue(csv, 'Rows'), undefined);
    });

    it('E8: the folder cannot be created → exit 6 before measureStart, nothing started', async () => {
        const blocker = join(SCRATCH, 'not-a-folder');
        writeFileSync(blocker, 'x');
        const {code, stderr, fake} = await run([...GRIP_1S, '--out', join(blocker, 'sub')]);
        assert.equal(code, 6);
        assert.match(stderr, /Could not write .*not-a-folder.*\. Nothing was recorded\./);
        assert.equal(count(fake, START), 0);
        assertHygiene(fake, {measureStop: 0});
    });
});

describe('record: E9, a second Ctrl-C while the file is being closed', () => {
    it('exits at once with 130 after a one-line note naming the file; the file keeps what was flushed', async () => {
        const signals = new EventEmitter();
        let fake!: FakeCompanion;
        const exits: number[] = [];
        const sink = {stdout: '', stderr: ''};
        const pending = run(['--device', 'GRIP', '--seconds', '3'], {releaseDelayMs: 200}, {
            signals,
            sink,
            onFake: (f) => (fake = f),
            env: {exit: (code) => void exits.push(code)},
        });
        await waitUntil(() => fake.emittedFrames >= 10, 'frames');
        signals.emit('SIGINT');
        await waitUntil(() => fake.count('POST', '/session/release') === 1, 'the teardown under way');
        signals.emit('SIGINT');
        assert.deepEqual(exits, [130], 'the second Ctrl-C exits at once, with 130');
        assert.match(sink.stderr, /Second Ctrl-C: exiting now\. The file keeps the rows written so far: \/\S+\.csv\n/);
        assert.doesNotMatch(sink.stderr, /Already stopping/);
        await pending;
    });

    it('a second Ctrl-C before the file exists (countdown) does not force the exit', async () => {
        const signals = new EventEmitter();
        let fake!: FakeCompanion;
        const exits: number[] = [];
        const pending = run(['--device', 'GRIP', '--seconds', '1'], {releaseDelayMs: 100}, {signals, onFake: (f) => (fake = f), env: {exit: (code) => void exits.push(code)}});
        await waitUntil(() => fake.count('GET', '/streams') === 1, 'the descriptor read');
        signals.emit('SIGINT');
        signals.emit('SIGINT');
        const {code, stderr} = await pending;
        assert.equal(code, 130);
        assert.deepEqual(exits, []);
        assert.match(stderr, /Already stopping; please wait\./);
    });
});

describe('record: the size check', () => {
    // 4 000 000 Hz is a synthetic set rate, chosen only to push a 1 s recording above 100 MB.
    const BIG = {samplingFrequency: 4_000_000};

    it('above 100 MB with no terminal: says the size, does not record, exit 1, released', async () => {
        const {code, stdout, stderr, fake, cwd} = await run(GRIP_1S, BIG);
        assert.equal(code, 1);
        assert.match(stdout, /This recording will be about \d+\.\d MB \(4000000 Hz × 1 s × 1 field\)\./);
        assert.match(stderr, /Not recording: a file above 100\.0 MB needs a confirmation at a terminal\./);
        assert.equal(count(fake, START), 0);
        assert.ok(!existsSync(join(cwd, 'recordings')));
        assertHygiene(fake, {measureStop: 0});
    });

    it('at a terminal: "n" aborts (exit 1); an empty answer continues and records', async () => {
        const reader = (answers: string[]) => () => ({ask: async () => answers.shift(), close: () => undefined});
        const refused = await run(GRIP_1S, BIG, {env: {makeReader: reader(['n'])}});
        assert.equal(refused.code, 1);
        assert.match(refused.stderr, /Not recording\. Nothing was saved\./);
        assert.equal(count(refused.fake, START), 0);

        const accepted = await run(GRIP_1S, BIG, {env: {makeReader: reader([''])}});
        assert.equal(accepted.code, 0, accepted.stderr);
        assert.match(accepted.stdout, /Saved \d+ rows to /);
        assert.deepEqual(values(readCsv(savedPath(accepted.stdout).path)[findRow(readCsv(savedPath(accepted.stdout).path), 'Sample rate set (Hz)')]!), ['Sample rate set (Hz)', '4000000']);
    });

    it('below 100 MB: no question, no size line', async () => {
        const {stdout} = await run(GRIP_1S);
        assert.doesNotMatch(stdout, /This recording will be about/);
    });
});

async function waitUntil(condition: () => boolean, what: string): Promise<void> {
    const started = Date.now();
    while (!condition()) {
        if (Date.now() - started > 5000) assert.fail(`timed out waiting for ${what}`);
        await new Promise((resolve) => setTimeout(resolve, 2));
    }
}

function escapeRegExp(text: string): string {
    return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
