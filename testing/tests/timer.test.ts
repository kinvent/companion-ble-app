/**
 * The run timer and the measured-rate window, on an injected clock.
 */
import {strict as assert} from 'node:assert';
import {describe, it} from 'node:test';
import {every, RateWindow, RunTimer, sleep} from '../../src/timer.js';
import {flush, ManualClock} from '../doubles/manualClock.js';

describe('RunTimer', () => {
    it('fires once, at exactly the requested time; elapsed and remaining follow the clock', async () => {
        const clock = new ManualClock();
        const timer = new RunTimer(clock, 5000);
        assert.equal(timer.elapsedMs, 0);
        assert.equal(timer.remainingMs, 5000);
        let fired = 0;
        const done = timer.start().then(() => {
            fired += 1;
        });
        await clock.advance(1250);
        assert.equal(timer.elapsedMs, 1250);
        assert.equal(timer.remainingMs, 3750);
        await clock.advance(3749);
        assert.equal(fired, 0, 'not one millisecond early');
        await clock.advance(1);
        await done;
        assert.equal(fired, 1);
        assert.equal(clock.now(), 5000);
        await clock.advance(10_000);
        assert.equal(timer.elapsedMs, 5000, 'clamped to the duration');
        assert.equal(timer.remainingMs, 0);
        assert.equal(fired, 1, 'fires once');
    });

    it('a second start returns the same promise and does not restart the time', async () => {
        const clock = new ManualClock();
        const timer = new RunTimer(clock, 1000);
        const first = timer.start();
        await clock.advance(600);
        assert.equal(timer.start(), first);
        await clock.advance(400);
        await first;
        assert.equal(clock.waiting, 0, 'only one timer was armed');
    });

    it('stop freezes the elapsed time and cancels the timer (an early end)', async () => {
        const clock = new ManualClock();
        const timer = new RunTimer(clock, 1000);
        let fired = false;
        void timer.start().then(() => {
            fired = true;
        });
        await clock.advance(300);
        timer.stop();
        await clock.advance(5000);
        assert.equal(fired, false);
        assert.equal(timer.elapsedMs, 300);
        assert.equal(clock.waiting, 0);
    });
});

describe('RateWindow', () => {
    it('counts the samples of the last second only', async () => {
        const clock = new ManualClock();
        const rate = new RateWindow(clock);
        assert.equal(rate.rate(), 0, 'zero samples: 0 Hz');
        for (let i = 0; i < 10; i += 1) {
            rate.add(10); // 10 samples every 100 ms: 100 Hz
            await clock.advance(100);
        }
        assert.equal(rate.rate(), 90, 'the batch exactly one second old has left the window');
        rate.add(10);
        assert.equal(rate.rate(), 100);
        await clock.advance(2000);
        assert.equal(rate.rate(), 0, 'silence drops to 0');
    });
});

describe('sleep and every', () => {
    it('sleep resolves after the time and rejects on abort with the reason', async () => {
        const clock = new ManualClock();
        let slept = false;
        const done = sleep(clock, 100).then(() => {
            slept = true;
        });
        await clock.advance(100);
        await done;
        assert.equal(slept, true);

        const controller = new AbortController();
        const pending = sleep(clock, 100, controller.signal);
        controller.abort('stop');
        await assert.rejects(pending, (error) => error === 'stop');
        assert.equal(clock.waiting, 0);
    });

    it('every ticks at the interval until stopped', async () => {
        const clock = new ManualClock();
        let ticks = 0;
        const stop = every(clock, 250, () => {
            ticks += 1;
        });
        await clock.advance(1000);
        assert.equal(ticks, 4);
        stop();
        await clock.advance(1000);
        await flush();
        assert.equal(ticks, 4);
        assert.equal(clock.waiting, 0);
    });
});
