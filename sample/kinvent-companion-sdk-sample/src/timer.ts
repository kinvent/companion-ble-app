/**
 * FOR INTEGRATORS: No SDK call. An injectable clock so the tests drive time by hand; optional for your program.
 *
 * Time for the recording: an injectable clock, the run timer
 * that ends the recording at the requested seconds, and the window that gives the measured rate.
 *
 * Everything takes a {@link Clock}, so a test drives time by hand (`testing/doubles/manualClock.ts`) and
 * the program uses {@link systemClock}: `performance.now()`, which is monotonic, and the platform timers.
 */

export interface Clock {
    /** Milliseconds, monotonic. Only differences are meaningful. */
    now(): number;
    setTimeout(callback: () => void, ms: number): unknown;
    clearTimeout(handle: unknown): void;
}

export const systemClock: Clock = {
    now: () => performance.now(),
    setTimeout: (callback, ms) => setTimeout(callback, ms),
    clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Resolves after `ms`; rejects with `signal.reason` as soon as `signal` aborts. */
export function sleep(clock: Clock, ms: number, signal?: AbortSignal): Promise<void> {
    return new Promise<void>((resolve, reject) => {
        if (signal?.aborted) {
            reject(signal.reason);
            return;
        }
        const onAbort = (): void => {
            clock.clearTimeout(handle);
            reject(signal!.reason);
        };
        const handle = clock.setTimeout(() => {
            signal?.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal?.addEventListener('abort', onAbort, {once: true});
    });
}

/** Calls `callback` every `ms` until the returned function is called. */
export function every(clock: Clock, ms: number, callback: () => void): () => void {
    let handle: unknown;
    let stopped = false;
    const arm = (): void => {
        handle = clock.setTimeout(() => {
            if (stopped) return;
            callback();
            arm();
        }, ms);
    };
    arm();
    return () => {
        stopped = true;
        clock.clearTimeout(handle);
    };
}

/**
 * The recording timer: started once, fires once, at exactly `durationMs` after {@link start}.
 * `elapsedMs` and `remainingMs` are for the live view; both are clamped to `0..durationMs`.
 */
export class RunTimer {
    private startedAt: number | undefined;
    private stoppedAt: number | undefined;
    private handle: unknown;
    private done: Promise<void> | undefined;

    constructor(
        private readonly clock: Clock,
        readonly durationMs: number,
    ) {}

    /** Starts the timer; a second call returns the first call's promise and does not restart it. */
    start(): Promise<void> {
        if (this.done === undefined) {
            this.startedAt = this.clock.now();
            this.done = new Promise<void>((resolve) => {
                this.handle = this.clock.setTimeout(() => {
                    this.stoppedAt ??= this.clock.now();
                    resolve();
                }, this.durationMs);
            });
        }
        return this.done;
    }

    /** Freezes the elapsed time and cancels the timer (an early end). The promise then never resolves. */
    stop(): void {
        if (this.startedAt === undefined || this.stoppedAt !== undefined) return;
        this.stoppedAt = this.clock.now();
        this.clock.clearTimeout(this.handle);
    }

    get started(): boolean {
        return this.startedAt !== undefined;
    }

    get elapsedMs(): number {
        if (this.startedAt === undefined) return 0;
        const end = this.stoppedAt ?? this.clock.now();
        return Math.min(Math.max(end - this.startedAt, 0), this.durationMs);
    }

    get remainingMs(): number {
        return this.durationMs - this.elapsedMs;
    }
}

/** Samples per second over the last `windowMs` (1 s by default): the live view's "measured" rate. */
export class RateWindow {
    private readonly entries: Array<{at: number; count: number}> = [];

    constructor(
        private readonly clock: Clock,
        private readonly windowMs = 1000,
    ) {}

    /** `count` samples arrived now. */
    add(count: number): void {
        this.entries.push({at: this.clock.now(), count});
        this.prune();
    }

    /** Samples per second over the window ending now. */
    rate(): number {
        this.prune();
        const total = this.entries.reduce((sum, entry) => sum + entry.count, 0);
        return (total * 1000) / this.windowMs;
    }

    private prune(): void {
        const from = this.clock.now() - this.windowMs;
        while (this.entries.length > 0 && this.entries[0]!.at <= from) this.entries.shift();
    }
}
