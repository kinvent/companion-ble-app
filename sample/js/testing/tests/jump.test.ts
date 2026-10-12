/**
 * Integration: the jump test through the real CLI flow (`runCli`) and the real SDK
 * client over the fake companion. The fake plays the companion's start sequence of a jump analysis (option
 * `jump`): a K-Deltas goes to the jump protocol at the first `measure/start`, a `stream.layout` follows on the
 * poll while the first frame is already on the socket, and the frames carry the total force. Every value is
 * synthetic.
 */
import {strict as assert} from 'node:assert';
import {EventEmitter} from 'node:events';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, describe, it} from 'node:test';
import {DeltasVariantType, SESSION_HEADER, VERSION, type ForceSample, type FrequencySettingsSnapshot} from '@kinvent/companion-sdk';
import {runCli, type RunEnv} from '../../src/run.js';
import type {ExitCode} from '../../src/exit.js';
import {DEFAULT_FREQUENCIES, FAKE_DEVICE_ID, FAKE_RIGHT_ID, FakeCompanion, V2_JUMP_RATE, type FakeOptions} from '../doubles/fakeCompanion.js';
import {findRow, parseCsv, sampleRows, summaryValue, values, type Csv} from '../doubles/rfc4180.js';

const SCRATCH = mkdtempSync(join(tmpdir(), 'cli-sample-jump-'));
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

async function run(argv: string[], options: FakeOptions = {}, env: Partial<RunEnv> = {}): Promise<Outcome> {
    const fake = new FakeCompanion(options);
    const signals = new EventEmitter();
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
        stdoutIsTTY: false,
        countdownStepMs: 30,
        liveTickMs: 50,
        cwd: join(SCRATCH, `run-${++runs}`),
        registryPath: join(SCRATCH, `registry-${runs}.json`),
        zeroTiming: {stillWindowMs: 60, zeroStepTimeoutMs: 2000},
        now: () => FIXED,
        ...env,
    });
    assert.equal(signals.listenerCount('SIGINT'), 0, 'the SIGINT listener must be removed on exit');
    return {code, stdout, stderr, fake};
}

/** A scripted terminal: answers in order; records every question. */
function terminal(answers: string[], asked: string[]): RunEnv['makeReader'] {
    return () => ({
        ask: async (prompt: string) => {
            asked.push(prompt);
            return answers.shift();
        },
        close: () => undefined,
    });
}

function savedPath(stdout: string): string {
    const match = /(?:Saved \d+ rows to |Partial data kept: \d+ rows in )(\/\S+\.csv)\n/.exec(stdout);
    assert.ok(match, `no file report in:\n${stdout}`);
    return match[1]!;
}

const readText = (stdout: string): string => readFileSync(savedPath(stdout), 'utf8');
const readCsv = (stdout: string): Csv => parseCsv(readText(stdout));

/** Session hygiene: released once, activity stopped once, the measureStops before it. */
function assertHygiene(fake: FakeCompanion, stops: number): void {
    const commands = fake.commands();
    assert.equal(fake.count('POST', '/session/release'), 1, 'released exactly once');
    assert.equal(fake.count('POST', '/activity/stop'), 1, 'activity stopped exactly once');
    // Floor devices are measured once before the recording, to wait until nothing moves on them (one start, one stop
    // per device); `rezeroes` lists exactly the devices that went through it.
    const still = fake.rezeroes.length;
    assert.equal(commands.filter((entry) => entry.endsWith('/measure/start')).length, still > 0 ? 2 : 1, 'one measureStart per measurement');
    const stopsSent = commands.filter((entry) => entry.endsWith('/measure/stop'));
    assert.equal(stopsSent.length, stops + still, 'one measureStop per device per measurement');
    for (const stop of stopsSent) assert.ok(commands.indexOf(stop) < commands.indexOf('POST /activity/stop'));
}

const puts = (fake: FakeCompanion): unknown[] =>
    fake.requests.filter((request) => request.method === 'PUT' && request.path === '/settings/frequencies').map((request) => request.body);

const rate = (samples: readonly ForceSample[]): string =>
    ((samples.length - 1) / ((samples.at(-1)!.timeStamp - samples[0]!.timeStamp) / 1000)).toFixed(1);

/** The frequencies of the session with both ballistic families already in the jump-protocol mode at `hz`. */
function alreadyJumping(hz: number): FrequencySettingsSnapshot {
    const snapshot = structuredClone(DEFAULT_FREQUENCIES);
    for (const family of snapshot.families) {
        if (family.family === 'deltasMiniBallistic' || family.family === 'deltasXlBallistic') family.current = {rate: hz, mode: 'jumpProtocol'};
    }
    return snapshot;
}

/**
 * The one-device jump file, written out by hand from the samples the fake sent (NOT with the recorder's
 * functions): the one-device layout plus the three jump rows, ONE channel (`forceTotal`).
 */
function expectedJumpFile(samples: readonly ForceSample[], hz: number): string {
    return [
        `"Kinvent Companion SDK sample test","Companion ${VERSION}","companion-sdk ${VERSION}","Devices:","K-Deltas"`,
        '"Session Date","2026-10-07"',
        '"Session Time","10:15:30"',
        '"Configuration"',
        '"Device type","HEXAS"',
        '"Recording time (sec)",1',
        `"Sample rate set (Hz)",${hz}`,
        '"Countdown (sec)",3',
        '"Exercise type","JUMP_ANALYSIS"',
        '"Mode","jump"',
        '"Jump protocol","yes"',
        '"Channels"',
        '"Column","Field","Unit","Unit code"',
        '"CHANNEL_1","forceTotal","kg","KILOGRAM"',
        '',
        '"Raw Channel Data"',
        '"Time at time zero","10:15:30:123"',
        '"","K-Deltas"',
        '"Time (sec)","CHANNEL_1"',
        ...samples.map((sample) => `${String((sample.timeStamp - samples[0]!.timeStamp) / 1000)},${sample.channels[0]!.toFixed(15)}`),
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

const DELTA_1S = ['--device', 'HEXAS', '--single', '--seconds', '1', '--connect-timeout', '5'];
const JUMP = {jump: 'v3'} as const satisfies FakeOptions;

describe('jump: which types', () => {
    for (const type of ['GRIP', 'MUSCLE_TESTER', 'LINK', 'BUBBLE']) {
        it(`--jump is refused for ${type} (exit 1), before any request`, async () => {
            const {code, stderr, fake} = await run(['--device', type, '--seconds', '1', '--jump']);
            assert.equal(code, 1);
            assert.match(stderr, /--jump: only for K-Deltas \(HEXAS\), K-Deltas 3D \(DELTAS_3D\) and K-Plates \(PLATES\); a .+ \(.+\) has no jump test\./);
            assert.equal(fake.requests.length, 0);
        });
    }

    it('--jump is accepted for HEXAS and PLATES; --jump with --normal is a usage error', async () => {
        const deltas = await run([...DELTA_1S, '--jump'], JUMP);
        assert.equal(deltas.code, 0, deltas.stderr);
        assert.match(deltas.stdout, /Device: K-Deltas \(HEXAS\), one K-Delta \(the left one\), jump test\. Recording time: 1 s\./);
        const plates = await run(['--device', 'PLATES', '--single', '--seconds', '1', '--jump'], JUMP);
        assert.equal(plates.code, 0, plates.stderr);
        const both = await run([...DELTA_1S, '--jump', '--normal']);
        assert.equal(both.code, 1);
        assert.match(both.stderr, /--jump and --normal: choose one\./);
        assert.equal(both.fake.requests.length, 0);
    });
});

describe('jump: the two ballistic families (before the prepare)', () => {
    it('both families set to the jump protocol at their current rate, BEFORE the prepare; JUMP_ANALYSIS sent', async () => {
        const {code, stdout, stderr, fake} = await run([...DELTA_1S, '--jump'], JUMP);
        assert.equal(code, 0, stderr);
        assert.deepEqual(puts(fake), [
            {family: 'deltasMiniBallistic', rate: 1000, mode: 'jumpProtocol'},
            {family: 'deltasXlBallistic', rate: 1000, mode: 'jumpProtocol'},
        ]);
        assert.equal(fake.acceptedFrequencyPuts.length, 2, 'the fake (as the companion) accepted both');
        const commands = fake.commands();
        assert.ok(commands.lastIndexOf('PUT /settings/frequencies') < commands.indexOf('POST /activity/prepare'), 'PUTs before the prepare');
        assert.equal(fake.prepareBodies.length, 1);
        assert.equal(fake.prepareBodies[0]!.exerciseType, 'JUMP_ANALYSIS');
        assert.match(stdout, /Jump rate of the K-Deltas set to 1000 Hz, jump protocol/);
        assert.match(stdout, /Jump rate of the K-Deltas XL set to 1000 Hz, jump protocol/);
        assertHygiene(fake, 1);
    });

    it('no PUT for a family that already has the rate in the jump-protocol mode', async () => {
        const {code, stdout, fake} = await run([...DELTA_1S, '--jump'], {...JUMP, frequencies: alreadyJumping(1000)});
        assert.equal(code, 0);
        assert.deepEqual(puts(fake), []);
        assert.match(stdout, /Jump rate of the K-Deltas is already 1000 Hz \(jump protocol\); not changed\./);
        assert.equal(fake.prepareBodies[0]!.exerciseType, 'JUMP_ANALYSIS');
    });

    it('--rate is the jump rate; one family already set → one PUT', async () => {
        const two = await run([...DELTA_1S, '--jump', '--rate', '2000'], JUMP);
        assert.equal(two.code, 0, two.stderr);
        assert.deepEqual(puts(two.fake), [
            {family: 'deltasMiniBallistic', rate: 2000, mode: 'jumpProtocol'},
            {family: 'deltasXlBallistic', rate: 2000, mode: 'jumpProtocol'},
        ]);
        assert.equal(two.fake.count('PUT', '/settings/frequencies'), 2);

        const frequencies = alreadyJumping(1000);
        frequencies.families.find((family) => family.family === 'deltasXlBallistic')!.current = {rate: 2000, mode: 'jumpProtocol'};
        const one = await run([...DELTA_1S, '--jump', '--rate', '2000'], {...JUMP, frequencies});
        assert.deepEqual(puts(one.fake), [{family: 'deltasMiniBallistic', rate: 2000, mode: 'jumpProtocol'}]);
    });

    it('--rate 4000: the K-Deltas XL only; the K-Deltas keeps its current rate (and says so)', async () => {
        const {code, stdout, fake} = await run([...DELTA_1S, '--jump', '--rate', '4000'], JUMP);
        assert.equal(code, 0);
        assert.deepEqual(puts(fake), [
            {family: 'deltasMiniBallistic', rate: 1000, mode: 'jumpProtocol'},
            {family: 'deltasXlBallistic', rate: 4000, mode: 'jumpProtocol'},
        ]);
        assert.match(stdout, /--rate 4000 Hz is offered on the K-Deltas XL only; a K-Deltas jumps at 1000 Hz\./);
    });

    it('a rate no family offers in the jump mode is refused before any PUT (exit 1), naming the jump rates', async () => {
        for (const wanted of ['250', '3000']) {
            const {code, stderr, fake} = await run([...DELTA_1S, '--jump', '--rate', wanted], JUMP);
            assert.equal(code, 1);
            assert.match(stderr, new RegExp(`--rate: ${wanted} Hz is not a jump rate\\. Jump rates: K-Deltas 500, 1000, 2000 Hz; K-Deltas XL 500, 1000, 2000, 4000 Hz\\.`));
            assert.equal(fake.count('PUT', '/settings/frequencies'), 0);
            assert.equal(fake.count('POST', '/activity/prepare'), 0);
            assert.equal(fake.count('POST', '/session/release'), 1);
        }
    });

    it('the fake refuses a mode on a family without one, as the companion does (the double is honest)', async () => {
        const fake = new FakeCompanion();
        // Claim a session first (the first poll mints it), then PUT.
        const poll = await fake.fetch('http://127.0.0.1:8477/poll');
        const {sessionId} = (await poll.json()) as {sessionId: string};
        const answer = async (body: unknown): Promise<number> => {
            const response = await fake.fetch('http://127.0.0.1:8477/settings/frequencies', {
                method: 'PUT',
                headers: {[SESSION_HEADER]: sessionId},
                body: JSON.stringify(body),
            });
            return response.status;
        };
        assert.equal(await answer({family: 'plates', rate: 100, mode: 'jumpProtocol'}), 400);
        assert.equal(await answer({family: 'deltasMiniBallistic', rate: 250, mode: 'jumpProtocol'}), 400);
        assert.equal(await answer({family: 'deltasMiniBallistic', rate: 4000, mode: 'jumpProtocol'}), 400);
        assert.equal(await answer({family: 'deltasXlBallistic', rate: 4000, mode: 'jumpProtocol'}), 204);
    });
});

describe('jump: the file waits for the layout of the start sequence', () => {
    it('V3 K-Deltas: the file has forceTotal (one channel, Mode jump), the first batch included, byte for byte', async () => {
        const {code, stdout, stderr, fake} = await run([...DELTA_1S, '--jump'], JUMP);
        assert.equal(code, 0, stderr);
        const sent = fake.sentByDevice.get(FAKE_DEVICE_ID)!;
        assert.ok(sent.length > 10);
        assert.ok(sent.every((sample) => sample.channels.length === 1), 'the fake sent ONE channel per sample');
        assert.equal(readText(stdout), expectedJumpFile(sent, 1000));
        // The first frame went out before the HTTP answer and before the event: it is the first row.
        const csv = readCsv(stdout);
        assert.deepEqual(values(sampleRows(csv)[0]!), ['0', sent[0]!.channels[0]!.toFixed(15)]);
        assert.equal(summaryValue(csv, 'Rows'), String(sent.length));
    });

    it('both paths settle the head: the first frame before the event (GET /devices asked), and the event first (not asked)', async () => {
        const startIndex = (fake: FakeCompanion): number => fake.requests.findIndex((request) => request.path.endsWith('/measure/start'));
        const devicesAfterStart = (fake: FakeCompanion): number =>
            fake.requests.slice(startIndex(fake)).filter((request) => request.method === 'GET' && request.path === '/devices').length;
        const race = await run([...DELTA_1S, '--jump'], JUMP);
        assert.ok(devicesAfterStart(race.fake) >= 1, 'the frame came first: the companion was asked');
        // The device stays silent for 5 frames: the event (next poll) arrives first.
        const event = await run([...DELTA_1S, '--jump'], {...JUMP, leftFrameDelay: 5});
        assert.equal(event.code, 0);
        assert.equal(devicesAfterStart(event.fake), 0, 'the event came first: nothing asked');
        for (const {stdout, fake} of [race, event]) {
            assert.equal(readText(stdout), expectedJumpFile(fake.sentByDevice.get(FAKE_DEVICE_ID)!, 1000));
        }
    });

    it('the live view shows forceTotal in kg and the set rate of the final configuration', async () => {
        const {stdout} = await run([...DELTA_1S, '--jump', '--rate', '2000'], JUMP);
        // The non-terminal line of the last state.
        const last = stdout.split('\n').filter((line) => line.startsWith('1.0/1.0 s')).at(-1);
        assert.ok(last !== undefined, stdout);
        assert.match(last, /2000 Hz set \(device configuration\)/);
        assert.match(last, /forceTotal +-?\d+\.\d{2} kg/);
        assert.doesNotMatch(last, /force1/);
    });

    it('a terminal: the block redraws with forceTotal once the layout arrives', async () => {
        const {stdout} = await run([...DELTA_1S, '--jump'], JUMP, {stdoutIsTTY: true});
        assert.match(stdout, /\r\u001b\[2K {2}forceTotal +-?\d+\.\d{2} kg\n/);
        assert.match(stdout, /1000 Hz set \(device configuration\)/);
    });

    it('a pair of K-Deltas: both forceTotal, the aligned file with one channel per device', async () => {
        const {code, stdout, stderr, fake} = await run(['--device', 'HEXAS', '--seconds', '1', '--jump', '--pair'], JUMP);
        assert.equal(code, 0, stderr);
        assertHygiene(fake, 2);
        const csv = readCsv(stdout);
        const text = readText(stdout);
        assert.match(text, /\n"Sample rate set \(Hz\)",1000\n"Countdown \(sec\)",3\n/);
        assert.match(text, /\n"Exercise type","JUMP_ANALYSIS"\n"Mode","jump"\n"Jump protocol \(K-Delta Left\)","yes"\n"Jump protocol \(K-Delta Right\)","yes"\n"Channels"\n/);
        assert.match(text, /\n"CHANNEL_1","K-Delta Left","forceTotal","kg","KILOGRAM"\n"CHANNEL_1","K-Delta Right","forceTotal","kg","KILOGRAM"\n"Join",/);
        assert.deepEqual(values(csv[findRow(csv, 'Time (sec)')]!), ['Time (sec)', 'CHANNEL_1', '', 'CHANNEL_1']);
        const rows = sampleRows(csv);
        const left = fake.sentByDevice.get(FAKE_DEVICE_ID)!;
        const right = fake.sentByDevice.get(FAKE_RIGHT_ID)!;
        assert.equal(rows.length, Math.max(left.length, right.length));
        assert.ok(rows.every((row) => row.length === 4));
        assert.deepEqual(values(rows[0]!), ['0', left[0]!.channels[0]!.toFixed(15), '', right[0]!.channels[0]!.toFixed(15)]);
    });

    it('V2: four channels in the samples, the total first; the file has forceTotal only', async () => {
        const {code, stdout, fake} = await run([...DELTA_1S, '--jump'], {jump: 'v2'});
        assert.equal(code, 0);
        const sent = fake.sentByDevice.get(FAKE_DEVICE_ID)!;
        assert.ok(sent.every((sample) => sample.channels.length === 4 && sample.channels.slice(1).every((value) => value === 0)));
        const text = readText(stdout);
        assert.match(text, new RegExp(`\\n"Sample rate set \\(Hz\\)",${V2_JUMP_RATE}\\n`));
        assert.match(text, /\n"Mode","jump"\n"Jump protocol","yes"\n"Channels"\n"Column","Field","Unit","Unit code"\n"CHANNEL_1","forceTotal","kg","KILOGRAM"\n\n/);
        const rows = sampleRows(readCsv(stdout));
        assert.equal(rows.length, sent.length);
        assert.deepEqual(values(rows[1]!), [String((sent[1]!.timeStamp - sent[0]!.timeStamp) / 1000), sent[1]!.channels[0]!.toFixed(15)]);
    });

    it('a V3 plate on a jump analysis: no layout event; the head from the first batch: four cells, Mode normal, Jump protocol no', async () => {
        const {code, stdout, stderr, fake} = await run(['--device', 'PLATES', '--single', '--seconds', '1', '--jump'], {...JUMP, numOfChannels: 4});
        assert.equal(code, 0, stderr);
        assert.equal(fake.prepareBodies[0]!.exerciseType, 'JUMP_ANALYSIS');
        assert.equal(fake.count('PUT', '/settings/frequencies'), 0, 'a K-Plates jump test sets no ballistic family');
        assert.ok(fake.count('GET', '/devices') >= 1, 'the companion was asked once every device sent a batch');
        const text = readText(stdout);
        assert.match(
            text,
            /\n"Sample rate set \(Hz\)",75\n"Countdown \(sec\)",3\n"Exercise type","JUMP_ANALYSIS"\n"Mode","normal"\n"Jump protocol","no"\n"Channels"\n/,
        );
        assert.match(text, /"CHANNEL_4","force4","kg","KILOGRAM"\n/);
        const csv = readCsv(stdout);
        assert.deepEqual(values(csv[findRow(csv, 'Time (sec)')]!), ['Time (sec)', 'CHANNEL_1', 'CHANNEL_2', 'CHANNEL_3', 'CHANNEL_4']);
        assert.equal(sampleRows(csv).length, fake.sentByDevice.get(FAKE_DEVICE_ID)!.length);
    });

    it('a 3D Deltas jump: JUMP_ANALYSIS is sent, no ballistic rate is set, the user is told the nine channels stay', async () => {
        const {code, stdout, stderr, fake} = await run(['--device', 'DELTAS_3D', '--pair', '--seconds', '1', '--jump'], JUMP);
        assert.equal(code, 0, stderr);
        assert.equal(fake.prepareBodies[0]!.exerciseType, 'JUMP_ANALYSIS');
        assert.equal(fake.count('PUT', '/settings/frequencies'), 0, 'a 3D Deltas jump test sets no ballistic family');
        assert.match(stdout, /Device: K-Deltas 3D \(DELTAS_3D\), a pair \(left and right\), jump test\./);
        assert.match(stdout, /Jump test on 3D Deltas: they keep all nine channels and their rate, as in the mobile app\./);
    });

    it('a K-Deltas XL (CLASSIC) jumps at the XL family rate (--rate 4000)', async () => {
        const {code, stdout} = await run([...DELTA_1S, '--jump', '--rate', '4000'], {...JUMP, deltasVariant: DeltasVariantType.CLASSIC});
        assert.equal(code, 0);
        assert.match(readText(stdout), /\n"Sample rate set \(Hz\)",4000\n/);
    });
});

describe('jump: JUMP_ANALYSIS only when jumping, never otherwise', () => {
    it('no run that is not a jump test sends an exerciseType (the fake also refuses one on every other test file)', async () => {
        const normal: Array<[string[], FakeOptions]> = [
            [['--device', 'GRIP', '--seconds', '1'], {}],
            [['--device', 'PLATES', '--seconds', '1'], {numOfChannels: 4}],
            [['--device', 'PLATES', '--single', '--seconds', '1', '--normal'], {numOfChannels: 4}],
            [['--device', 'HEXAS', '--single', '--seconds', '1', '--normal'], {numOfChannels: 4}],
            [['--device', 'DELTAS_3D', '--single', '--seconds', '1'], {}],
            [['--device', 'BUBBLE', '--seconds', '1'], {}],
        ];
        for (const [argv, options] of normal) {
            const {code, stderr, fake} = await run(argv, options);
            assert.equal(code, 0, `${argv.join(' ')}: ${stderr}`);
            assert.equal(fake.prepareBodies.length, 1);
            assert.ok(!('exerciseType' in fake.prepareBodies[0]!), `${argv.join(' ')}: no exerciseType key`);
            assert.equal(fake.count('PUT', '/settings/frequencies'), 0);
        }
    });

    it('--normal on a K-Deltas: the four cells, the file has no jump row', async () => {
        const {code, stdout} = await run([...DELTA_1S, '--normal'], {numOfChannels: 4});
        assert.equal(code, 0);
        const text = readText(stdout);
        assert.doesNotMatch(text, /Exercise type|"Mode"|Jump protocol/);
        assert.match(text, /\n"Sample rate set \(Hz\)",75\n"Countdown \(sec\)",3\n"Channels"\n/);
        assert.match(text, /"CHANNEL_4","force4","kg","KILOGRAM"\n/);
    });
});

describe('jump: the questions at a terminal; --pair', () => {
    it('K-Deltas without --jump/--normal: "Jump test (total force at a high rate)? [y/N]"; y jumps, empty is normal', async () => {
        const asked: string[] = [];
        // `--rate` answers the jump-rate question a K-Deltas jump test asks at a terminal (tested in pair.test.ts).
        const yes = await run(['--device', 'HEXAS', '--seconds', '1', '--single', '--rate', '1000'], JUMP, {makeReader: terminal(['y'], asked)});
        assert.equal(yes.code, 0, yes.stderr);
        assert.deepEqual(asked, ['Jump test (total force at a high rate)? [y/N] ']);
        // At a terminal the K-Deltas are zeroed under a normal plan first; the LAST prepare is the jump test.
        assert.equal(yes.fake.prepareBodies.at(-1)!.exerciseType, 'JUMP_ANALYSIS');

        asked.length = 0;
        const no = await run(['--device', 'HEXAS', '--seconds', '1', '--single'], {}, {makeReader: terminal([''], asked)});
        assert.equal(no.code, 0, no.stderr);
        assert.deepEqual(asked, ['Jump test (total force at a high rate)? [y/N] ']);
        assert.ok(!('exerciseType' in no.fake.prepareBodies[0]!));
    });

    it('not asked with --jump or --normal, nor for a type without a jump protocol; not a terminal: normal', async () => {
        const asked: string[] = [];
        await run(['--device', 'HEXAS', '--seconds', '1', '--single', '--normal'], {}, {makeReader: terminal([], asked)});
        await run(['--device', 'HEXAS', '--seconds', '1', '--single', '--jump', '--rate', '1000'], JUMP, {makeReader: terminal([], asked)});
        await run(['--device', 'GRIP', '--seconds', '1'], {}, {makeReader: terminal([], asked)});
        assert.deepEqual(asked, []);
        const piped = await run(['--device', 'HEXAS', '--seconds', '1', '--single']);
        assert.equal(piped.code, 0);
        assert.ok(!('exerciseType' in piped.fake.prepareBodies[0]!));
    });

    it('--pair: a scripted run at a terminal does not stop at the single question; with --single or a one-sensor type: exit 1', async () => {
        const asked: string[] = [];
        const pair = await run(['--device', 'PLATES', '--seconds', '1', '--pair', '--normal', '--rate', '100'], {}, {makeReader: terminal([], asked)});
        assert.equal(pair.code, 0, pair.stderr);
        assert.deepEqual(asked, []);
        assert.ok(!('isMonopodal' in pair.fake.lastPlan!));
        assert.match(pair.stdout, /a pair \(left and right\)/);

        const both = await run(['--device', 'PLATES', '--seconds', '1', '--pair', '--single']);
        assert.equal(both.code, 1);
        assert.match(both.stderr, /--single and --pair: choose one\./);
        assert.equal(both.fake.requests.length, 0);

        const grip = await run(['--device', 'GRIP', '--seconds', '1', '--pair']);
        assert.equal(grip.code, 1);
        assert.match(grip.stderr, /--pair: only for a sensor pair \(K-Plates, K-Deltas, K-Deltas 3D\); a K-Grip is one sensor\./);
        assert.equal(grip.fake.requests.length, 0);
    });
});
