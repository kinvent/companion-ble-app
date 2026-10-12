/**
 * Integration: the real CLI flow (`runCli`) with the real SDK client, over a fake companion injected
 * through the SDK's `fetchImpl` / `webSocketImpl` options. The cases: connect to
 * "ready", E1, E2, E3, E3b, E4, E5, the rate rule, Ctrl-C and SIGTERM during the wait, an unexpected
 * error — and on every path the session hygiene: the activity stopped and the session released, once.
 */
import {strict as assert} from 'node:assert';
import {EventEmitter} from 'node:events';
import {mkdtempSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, before, describe, it} from 'node:test';
import {runCli} from '../../src/run.js';
import type {ExitCode} from '../../src/exit.js';
import {FakeCompanion, type FakeOptions} from '../doubles/fakeCompanion.js';

/** Recordings of the runs that reach the recording land here and are deleted after the file's tests. */
const SCRATCH = mkdtempSync(join(tmpdir(), 'cli-sample-connect-'));
after(() => rmSync(SCRATCH, {recursive: true, force: true}));

interface Outcome {
    code: ExitCode;
    stdout: string;
    stderr: string;
    fake: FakeCompanion;
}

async function run(argv: string[], options: FakeOptions | FakeCompanion = {}, signals = new EventEmitter()): Promise<Outcome> {
    const fake = options instanceof FakeCompanion ? options : new FakeCompanion(options);
    let stdout = '';
    let stderr = '';
    const code = await runCli({
        argv,
        stdout: {write: (text) => void (stdout += text)},
        stderr: {write: (text) => void (stderr += text)},
        version: 'test',
        registryPath: join(SCRATCH, 'registry.json'),
        zeroTiming: {stillWindowMs: 60, zeroStepTimeoutMs: 2000},
        makeReader: undefined, // stdin is not a terminal
        signals,
        clientOptions: {fetchImpl: fake.fetch, webSocketImpl: fake.WebSocket, busyPollMs: 5, idlePollMs: 10, activityTailMs: 20},
        keepAliveMs: 40,
        teardownStepTimeoutMs: 1000,
        // A connect that succeeds now records; keep the countdown short (the recording is 1 s).
        countdownStepMs: 10,
        liveTickMs: 50,
        // A run that records writes its file into a scratch folder, never into the package.
        cwd: SCRATCH,
    });
    assert.equal(signals.listenerCount('SIGINT'), 0, 'the SIGINT listener must be removed on exit');
    return {code, stdout, stderr, fake};
}

const GRIP = ['--device', 'GRIP', '--seconds', '1', '--connect-timeout', '5'];

/** The session hygiene every path must satisfy. */
function assertCleanExit(fake: FakeCompanion, expect: {prepared: boolean; claimed: boolean; measured?: boolean}): void {
    assert.equal(fake.count('POST', '/session/release'), expect.claimed ? 1 : 0, 'session released exactly once');
    assert.equal(fake.count('POST', '/activity/stop'), expect.prepared ? 1 : 0, 'activity stopped exactly once');
    const commands = fake.commands();
    if (expect.prepared) {
        assert.ok(commands.lastIndexOf('POST /activity/stop') < commands.lastIndexOf('POST /session/release'), 'stop before release');
    }
    if (expect.measured === true) {
        // A run that reached "ready" records; the sensor is stopped once, before the activity.
        assert.equal(commands.filter((command) => command.endsWith('/measure/start')).length, 1, 'measure started once');
        assert.equal(commands.filter((command) => command.endsWith('/measure/stop')).length, 1, 'measure stopped once');
        assert.ok(commands.findIndex((command) => command.endsWith('/measure/stop')) < commands.lastIndexOf('POST /activity/stop'));
    } else {
        assert.ok(!commands.some((command) => command.includes('/measure/')), 'nothing was measured');
    }
    assert.ok(!commands.includes('POST /reset'), 'never POST /reset');
}

// The SDK writes its own diagnostics to the console; keep the test output readable.
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

describe('connect: happy path', () => {
    it('discovers, claims, keeps alive, prepares with NO exerciseType, waits for READY, then tears down (exit 0)', async () => {
        const {code, stdout, stderr, fake} = await run(GRIP);
        assert.equal(code, 0, stderr);
        assert.match(stdout, /Companion .* found at http:\/\/127\.0\.0\.1:8477\./);
        assert.match(stdout, /Switch on your K-Grip\. Waiting for it to connect… \(Ctrl-C to cancel, timeout 5 s\)/);
        assert.match(stdout, /scanning… found K-Grip/);
        assert.match(stdout, /K-Grip: connecting[\s\S]*K-Grip: connected[\s\S]*K-Grip: initializing/);
        assert.match(stdout, /Device ready: K-Grip, GRIP\./);
        assert.match(stdout, /Saved \d+ rows to .*GRIP-\d{8}-\d{6}(-\d+)?\.csv\n/);

        const prepare = fake.requests.find((request) => request.path === '/activity/prepare');
        assert.deepEqual(prepare?.body, {activityCode: 'cli-sample', deviceTypes: ['GRIP'], registered: [], exclude: []});
        assert.ok(!('exerciseType' in (prepare?.body as object)), 'no exerciseType key at all');
        assert.ok(prepare?.session, 'commands carry the session header');

        const commands = fake.commands();
        assert.ok(commands.indexOf('POST /devices/ping') < commands.indexOf('POST /activity/prepare'), 'keep-alive starts before prepare');
        assertCleanExit(fake, {prepared: true, claimed: true, measured: true});
        assert.equal(fake.count('GET', '/settings/frequencies'), 0, 'no rate work without --rate');
        assert.ok(fake.sockets.length >= 1 && fake.sockets.every((socket) => socket.readyState === 3), 'sample sockets closed');
        assert.ok(fake.sockets.every((socket) => !socket.url.includes('fake-session')), 'the token never travels in the URL');
    });

    it('E3b: a 503 while the previous session is released is waited out', async () => {
        const {code, stderr, fake} = await run(GRIP, {busyPolls: 3});
        assert.equal(code, 0, stderr);
        assertCleanExit(fake, {prepared: true, claimed: true, measured: true});
    });
});

describe('connect: errors E1 to E5', () => {
    it('E1: companion not running (connection refused) → exit 2, nothing to release', async () => {
        const {code, stderr, fake} = await run(GRIP, {down: true});
        assert.equal(code, 2);
        assert.match(stderr, /No Kinvent Companion app found on 127\.0\.0\.1:8477–8481\. Start the Kinvent Companion app/);
        assert.equal(fake.count('GET', '/poll'), 0);
        assertCleanExit(fake, {prepared: false, claimed: false});
    });

    it('E1 with --port: the pinned address is named', async () => {
        const {code, stderr} = await run([...GRIP, '--port', '9001'], {down: true});
        assert.equal(code, 2);
        assert.match(stderr, /No Kinvent Companion app found on 127\.0\.0\.1:9001\./);
    });

    it('E2: version mismatch → exit 2, never polls', async () => {
        const {code, stderr, fake} = await run(GRIP, {version: '2000.1.1'});
        assert.equal(code, 2);
        assert.match(stderr, /Companion is 2000\.1\.1, this sample is built for .*\. Use matching versions\./);
        assert.equal(fake.count('GET', '/poll'), 0);
        assertCleanExit(fake, {prepared: false, claimed: false});
    });

    it('E3: the session is held by another client → exit 3, nothing prepared', async () => {
        const {code, stderr, fake} = await run(GRIP, {heldByAnother: true});
        assert.equal(code, 3);
        assert.match(stderr, /Another app is using the sensors/);
        assert.equal(fake.count('POST', '/activity/prepare'), 0);
        assertCleanExit(fake, {prepared: false, claimed: false});
    });

    it('E3b: still 503 after the retry window → E3', async () => {
        const {code, stderr, fake} = await run(GRIP, {busyPolls: 10_000});
        assert.equal(code, 3);
        assert.match(stderr, /Another app is using the sensors/);
        assert.equal(fake.count('POST', '/activity/prepare'), 0);
    });

    it('E4: the preparation failed → exit 4 with step and reason, stopped and released', async () => {
        const {code, stderr, fake} = await run(GRIP, {scenario: 'fail'});
        assert.equal(code, 4);
        assert.match(stderr, /Could not prepare the K-Grip: init – the sensor did not answer\./);
        assertCleanExit(fake, {prepared: true, claimed: true});
    });

    it('E4: the prepare request is refused → exit 4, stopped and released', async () => {
        const {code, stderr, fake} = await run(GRIP, {scenario: 'prepareRefused'});
        assert.equal(code, 4);
        assert.match(stderr, /Could not prepare the K-Grip: deviceTypes\./);
        assertCleanExit(fake, {prepared: true, claimed: true});
    });

    it('E4: the device that became ready is of another type → exit 4', async () => {
        const {code, stderr, fake} = await run(GRIP, {scenario: 'wrongType'});
        assert.equal(code, 4);
        assert.match(stderr, /The companion connected a K-Plates \(PLATES\), not a K-Grip\./);
        assertCleanExit(fake, {prepared: true, claimed: true});
    });

    it('E5: no device in time → exit 4, names what the scan saw, stopped and released', async () => {
        const started = Date.now();
        const {code, stdout, stderr, fake} = await run(['--device', 'GRIP', '--seconds', '5', '--connect-timeout', '1'], {scenario: 'never'});
        assert.equal(code, 4);
        assert.ok(Date.now() - started >= 1000, 'waited the timeout');
        assert.match(stderr, /No K-Grip connected in 1 s\. Is it switched on and charged\? Is it a K-Grip\? Is another app connected to it\?/);
        assert.match(stderr, /Seen nearby: 1 × K-Push\./);
        assert.equal((stdout.match(/scanning… found K-Push/g) ?? []).length, 1, 'one line per sensor, the unknown one is not shown');
        assertCleanExit(fake, {prepared: true, claimed: true});
    });
});

describe('connect: --rate', () => {
    it('equal to current: no PUT', async () => {
        const {code, stdout, fake} = await run([...GRIP, '--rate', '75']);
        assert.equal(code, 0);
        assert.equal(fake.count('GET', '/settings/frequencies'), 1);
        assert.equal(fake.count('PUT', '/settings/frequencies'), 0);
        assert.match(stdout, /already 75 Hz; not changed/);
    });

    it('different and offered: one PUT before prepare', async () => {
        const {code, fake} = await run([...GRIP, '--rate', '150']);
        assert.equal(code, 0);
        const puts = fake.requests.filter((request) => request.method === 'PUT' && request.path === '/settings/frequencies');
        assert.deepEqual(
            puts.map((request) => request.body),
            [{family: 'gripMuscleLink', rate: 150}],
        );
        const commands = fake.commands();
        assert.ok(commands.indexOf('PUT /settings/frequencies') < commands.indexOf('POST /activity/prepare'));
    });

    it('not offered: exit 1 before any change, released, nothing prepared', async () => {
        const {code, stderr, fake} = await run([...GRIP, '--rate', '80']);
        assert.equal(code, 1);
        assert.match(stderr, /80 Hz is not offered\. Valid rates for the K-Grip: 75, 150 Hz\./);
        assert.equal(fake.count('PUT', '/settings/frequencies'), 0);
        assertCleanExit(fake, {prepared: false, claimed: true});
    });
});

describe('connect: signals and unexpected errors', () => {
    async function interruptDuringWait(signal: 'SIGINT' | 'SIGTERM'): Promise<Outcome> {
        const signals = new EventEmitter();
        const fake = new FakeCompanion({scenario: 'never', releaseDelayMs: 80});
        const pending = run(['--device', 'GRIP', '--seconds', '5', '--connect-timeout', '30'], fake, signals);
        // Wait until the plan reached the companion, then press Ctrl-C twice: the second press lands
        // while the teardown is still releasing (releaseDelayMs) and must not start a second one.
        const started = Date.now();
        for (;;) {
            await new Promise((resolve) => setTimeout(resolve, 10));
            if (Date.now() - started > 5000) assert.fail('prepare never sent');
            if (fake.count('POST', '/activity/prepare') === 1) break;
        }
        signals.emit(signal);
        await new Promise((resolve) => setTimeout(resolve, 20));
        signals.emit(signal);
        return await pending;
    }

    it('Ctrl-C during the wait: stopped, released once, exit 130, nothing else; a second Ctrl-C is not a second teardown', async () => {
        const {code, stderr, fake} = await interruptDuringWait('SIGINT');
        assert.equal(code, 130);
        assert.match(stderr, /Stopped\. Nothing was recorded\./);
        assert.match(stderr, /Already stopping; please wait\./);
        assertCleanExit(fake, {prepared: true, claimed: true});
    });

    it('SIGTERM during the wait: the same clean-up, exit 143', async () => {
        const {code, fake} = await interruptDuringWait('SIGTERM');
        assert.equal(code, 143);
        assertCleanExit(fake, {prepared: true, claimed: true});
    });

    it('an unexpected error (an unreadable companion answer) still stops and releases, exit 70', async () => {
        const {code, stderr, fake} = await run(GRIP, {devicesBroken: true});
        assert.equal(code, 70);
        assert.match(stderr, /Unexpected error/);
        assertCleanExit(fake, {prepared: true, claimed: true});
    });

    it('no terminal and no --device: exit 1 with the flag named, nothing contacted', async () => {
        const {code, stderr, fake} = await run(['--seconds', '5']);
        assert.equal(code, 1);
        assert.match(stderr, /--device is required when the input is not a terminal/);
        assert.equal(fake.requests.length, 0);
    });

    it('a --device the prompt refuses: exit 1, nothing contacted', async () => {
        const {code, stderr, fake} = await run(['--device', 'KPOWER', '--seconds', '5']);
        assert.equal(code, 1);
        assert.match(stderr, /KPOWER is not offered by this sample/);
        assert.equal(fake.requests.length, 0);
    });
});
