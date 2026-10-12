/**
 * FOR INTEGRATORS: Terminal plumbing, no SDK call. A program with its own UI does not need this file; skip it on a first read.
 *
 * The countdown before the recording: 3, 2, 1, one per step (1 s), then
 * it resolves and the caller sends `measureStart`. Nothing is started and nothing is recorded during it.
 *
 * Abortable: when `signal` aborts (Ctrl-C, the device lost, the session lost) it rejects at once with
 * `signal.reason` and shows no further number.
 */
import {sleep, type Clock} from './timer.js';

export const COUNTDOWN_FROM = 3;
export const COUNTDOWN_STEP_MS = 1000;

export interface CountdownOptions {
    clock: Clock;
    /** Called with 3, then 2, then 1, at 1 s steps. */
    show(remaining: number): void;
    signal?: AbortSignal;
    from?: number;
    stepMs?: number;
}

export async function countdown(options: CountdownOptions): Promise<void> {
    const from = options.from ?? COUNTDOWN_FROM;
    const stepMs = options.stepMs ?? COUNTDOWN_STEP_MS;
    for (let remaining = from; remaining >= 1; remaining -= 1) {
        if (options.signal?.aborted) throw options.signal.reason;
        options.show(remaining);
        await sleep(options.clock, stepMs, options.signal);
    }
}
