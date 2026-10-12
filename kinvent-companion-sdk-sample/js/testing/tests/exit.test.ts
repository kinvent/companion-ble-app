import {strict as assert} from 'node:assert';
import {EventEmitter} from 'node:events';
import {describe, it} from 'node:test';
import {EXIT, exitCodeForSignal, Interrupted, interruptible, Interrupts, Teardown} from '../../src/exit.js';

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

describe('exit codes', () => {
    it('match the documented exit codes', () => {
        assert.equal(EXIT.OK, 0);
        assert.equal(EXIT.BAD_FLAGS, 1);
        assert.equal(EXIT.ENVIRONMENT, 2);
        assert.equal(EXIT.SESSION, 3);
        assert.equal(EXIT.DEVICE, 4);
        assert.equal(EXIT.DISCONNECTED, 5);
        assert.equal(EXIT.WRITE, 6);
        assert.equal(EXIT.INTERRUPTED, 130);
    });

    it('SIGINT is 130, SIGTERM is 143', () => {
        assert.equal(exitCodeForSignal('SIGINT'), 130);
        assert.equal(exitCodeForSignal('SIGTERM'), 143);
    });
});

describe('Teardown: one-shot', () => {
    it('runs the steps in reverse order, each once, however often run() is called', async () => {
        const order: string[] = [];
        const teardown = new Teardown(1000);
        teardown.add({name: 'release', run: () => void order.push('release')});
        teardown.add({name: 'keep-alive', run: () => void order.push('keep-alive')});
        teardown.add({name: 'activity', run: () => void order.push('activity')});

        const first = teardown.run();
        const second = teardown.run();
        assert.equal(first, second, 'a second run() must return the first teardown, not start one');
        await Promise.all([first, second, teardown.run()]);
        assert.deepEqual(order, ['activity', 'keep-alive', 'release']);
    });

    it('a second run() during a slow step does not run any step twice', async () => {
        let releases = 0;
        const teardown = new Teardown(1000);
        teardown.add({
            name: 'release',
            run: async () => {
                releases += 1;
                await sleep(30);
            },
        });
        const first = teardown.run();
        await sleep(5);
        await teardown.run();
        await first;
        assert.equal(releases, 1);
    });

    it('a failing step is reported and does not stop the next one', async () => {
        const warnings: string[] = [];
        const ran: string[] = [];
        const teardown = new Teardown(1000, (line) => warnings.push(line));
        teardown.add({name: 'release', run: () => void ran.push('release')});
        teardown.add({
            name: 'stop the activity',
            run: () => {
                throw new Error('409 state');
            },
        });
        await teardown.run();
        assert.deepEqual(ran, ['release']);
        assert.equal(warnings.length, 1);
        assert.match(warnings[0]!, /stop the activity.*409 state/);
    });

    it('a step that hangs is abandoned after the step timeout', async () => {
        const warnings: string[] = [];
        const ran: string[] = [];
        const teardown = new Teardown(20, (line) => warnings.push(line));
        teardown.add({name: 'release', run: () => void ran.push('release')});
        teardown.add({name: 'hang', run: () => new Promise<void>(() => undefined)});
        const started = Date.now();
        await teardown.run();
        assert.ok(Date.now() - started < 500);
        assert.deepEqual(ran, ['release']);
        assert.match(warnings[0]!, /"hang" took too long/);
    });

    it('a step added after the teardown started is run at once, once', async () => {
        let count = 0;
        const teardown = new Teardown(1000);
        await teardown.run();
        assert.equal(teardown.started, true);
        teardown.add({name: 'late', run: () => void (count += 1)});
        await sleep(5);
        await teardown.run();
        assert.equal(count, 1);
    });
});

describe('Interrupts', () => {
    it('the first signal aborts and notifies once; a second one only reports a repeat', () => {
        const source = new EventEmitter();
        const repeats: string[] = [];
        const interrupts = new Interrupts(source, (signal) => repeats.push(signal));
        let stops = 0;
        interrupts.onStop(() => (stops += 1));

        source.emit('SIGINT');
        source.emit('SIGINT');
        source.emit('SIGTERM');
        assert.equal(interrupts.received, 'SIGINT');
        assert.equal(interrupts.abortSignal.aborted, true);
        assert.ok(interrupts.abortSignal.reason instanceof Interrupted);
        assert.equal(stops, 1);
        assert.deepEqual(repeats, ['SIGINT', 'SIGTERM']);
        interrupts.dispose();
    });

    it('dispose removes the listeners', () => {
        const source = new EventEmitter();
        const interrupts = new Interrupts(source);
        assert.equal(source.listenerCount('SIGINT'), 1);
        assert.equal(source.listenerCount('SIGTERM'), 1);
        interrupts.dispose();
        assert.equal(source.listenerCount('SIGINT'), 0);
        assert.equal(source.listenerCount('SIGTERM'), 0);
    });

    it('interruptible rejects with Interrupted on the signal and passes a result through otherwise', async () => {
        const source = new EventEmitter();
        const interrupts = new Interrupts(source);
        assert.equal(await interruptible(Promise.resolve(7), interrupts), 7);
        const pending = interruptible(new Promise<never>(() => undefined), interrupts);
        source.emit('SIGTERM');
        await assert.rejects(pending, (error: unknown) => error instanceof Interrupted && error.signal === 'SIGTERM');
        // Already interrupted: a new wait rejects at once.
        await assert.rejects(interruptible(new Promise<never>(() => undefined), interrupts), Interrupted);
        interrupts.dispose();
    });
});
