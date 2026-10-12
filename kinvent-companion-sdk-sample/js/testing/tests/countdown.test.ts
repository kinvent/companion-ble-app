/**
 * The countdown: 3, 2, 1 at 1 s steps on an injected clock, abortable.
 */
import {strict as assert} from 'node:assert';
import {describe, it} from 'node:test';
import {countdown} from '../../src/countdown.js';
import {Interrupted} from '../../src/exit.js';
import {flush, ManualClock} from '../doubles/manualClock.js';

describe('countdown', () => {
    it('shows 3, 2, 1 at 1 s steps and resolves 3 s after the start', async () => {
        const clock = new ManualClock();
        const shown: Array<[number, number]> = [];
        let resolved = false;
        const running = countdown({clock, show: (n) => shown.push([n, clock.now()])}).then(() => {
            resolved = true;
        });
        await flush();
        assert.deepEqual(shown, [[3, 0]]);
        await clock.advance(999);
        assert.deepEqual(shown, [[3, 0]], 'not before the full second');
        await clock.advance(1);
        assert.deepEqual(shown, [
            [3, 0],
            [2, 1000],
        ]);
        await clock.advance(1000);
        assert.equal(resolved, false);
        await clock.advance(999);
        assert.equal(resolved, false, 'the last second is waited out too');
        await clock.advance(1);
        await running;
        assert.equal(resolved, true);
        assert.deepEqual(
            shown.map(([n]) => n),
            [3, 2, 1],
        );
        assert.equal(clock.now(), 3000);
        assert.equal(clock.waiting, 0, 'no timer left behind');
    });

    it('a stop request (Ctrl-C) during it rejects with the reason at once and shows nothing more', async () => {
        const clock = new ManualClock();
        const shown: number[] = [];
        const controller = new AbortController();
        const running = countdown({clock, signal: controller.signal, show: (n) => shown.push(n)});
        await clock.advance(1500);
        const reason = new Interrupted('SIGINT');
        controller.abort(reason);
        await assert.rejects(running, (error) => error === reason);
        await clock.advance(5000);
        assert.deepEqual(shown, [3, 2]);
        assert.equal(clock.waiting, 0, 'the pending step was cancelled');
    });

    it('an already-aborted signal shows nothing', async () => {
        const controller = new AbortController();
        controller.abort(new Interrupted('SIGINT'));
        const shown: number[] = [];
        await assert.rejects(countdown({clock: new ManualClock(), signal: controller.signal, show: (n) => shown.push(n)}), Interrupted);
        assert.deepEqual(shown, []);
    });

    it('takes another step length (the test seam the integration test uses)', async () => {
        const clock = new ManualClock();
        let done = false;
        const running = countdown({clock, stepMs: 10, show: () => undefined}).then(() => {
            done = true;
        });
        await clock.advance(29);
        assert.equal(done, false);
        await clock.advance(1);
        await running;
        assert.equal(done, true);
    });
});
