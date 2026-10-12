/**
 * FOR INTEGRATORS: README.md section 5.12. The pattern worth copying is `Teardown`: register the undo step BEFORE the
 * call that needs it (release before claim, stop before prepare), then run every step once, in reverse, on
 * every exit path.
 *
 * Exit codes, the one-shot teardown and the signal handling.
 *
 * THE RULE THIS FILE EXISTS FOR: whatever ends the program — success, an error, Ctrl-C, SIGTERM, an
 * unexpected exception — the activity the sample prepared is stopped and the session it claimed is
 * released, each EXACTLY ONCE. A second signal while that is running does not start a second teardown.
 */

/** 130 for Ctrl-C (SIGINT) and 143 for SIGTERM: 128 + the signal number, the shell convention. */
export const EXIT = {
    OK: 0,
    /** E10, and a missing answer when stdin is not a terminal. */
    BAD_FLAGS: 1,
    /** E1, E2, and the runtime check at start-up (Node.js version). */
    ENVIRONMENT: 2,
    /** E3, E3b. */
    SESSION: 3,
    /** E4, E5, and E11 (the device type has no stream descriptor). */
    DEVICE: 4,
    /** E6, E7. */
    DISCONNECTED: 5,
    /** E8. */
    WRITE: 6,
    /** An unexpected exception: a defect of the sample, not a user error. */
    INTERNAL: 70,
    /** Ctrl-C, Ctrl-D at a question. */
    INTERRUPTED: 130,
    TERMINATED: 143,
} as const;

export type ExitCode = (typeof EXIT)[keyof typeof EXIT];

/** An expected end of the program, with the code and the sentence for the user. */
export class CliExit extends Error {
    constructor(
        readonly code: ExitCode,
        message: string,
    ) {
        super(message);
        this.name = 'CliExit';
    }
}

/** One teardown step. A step that throws or hangs does not stop the steps after it. */
export interface TeardownStep {
    name: string;
    run(): Promise<void> | void;
}

/** How long one step may take before the teardown moves on. Bounded so Ctrl-C can never hang the exit. */
export const DEFAULT_STEP_TIMEOUT_MS = 3000;

/**
 * Steps registered as resources are acquired, run in REVERSE order (last acquired, first released),
 * each at most once, and the whole teardown at most once: a second `run()` returns the first one's
 * promise.
 */
export class Teardown {
    private readonly steps: TeardownStep[] = [];
    private running: Promise<void> | undefined;

    constructor(
        private readonly stepTimeoutMs: number = DEFAULT_STEP_TIMEOUT_MS,
        private readonly warn: (line: string) => void = () => undefined,
    ) {}

    /** Whether the teardown has started. A step added after that is run at once, on its own. */
    get started(): boolean {
        return this.running !== undefined;
    }

    add(step: TeardownStep): void {
        if (this.running !== undefined) {
            // Acquired while the program was already on its way out: give it back now, once.
            void this.runStep(step);
            return;
        }
        this.steps.push(step);
    }

    run(): Promise<void> {
        if (this.running === undefined) {
            this.running = this.runAll();
        }
        return this.running;
    }

    private async runAll(): Promise<void> {
        while (this.steps.length > 0) {
            await this.runStep(this.steps.pop()!);
        }
    }

    private async runStep(step: TeardownStep): Promise<void> {
        let timer: ReturnType<typeof setTimeout> | undefined;
        const timeout = new Promise<'timeout'>((resolve) => {
            timer = setTimeout(() => resolve('timeout'), this.stepTimeoutMs);
        });
        try {
            const outcome = await Promise.race([Promise.resolve().then(() => step.run()), timeout]);
            if (outcome === 'timeout') this.warn(`Clean-up step "${step.name}" took too long; continuing.`);
        } catch (error) {
            this.warn(`Clean-up step "${step.name}" failed: ${error instanceof Error ? error.message : String(error)}`);
        } finally {
            clearTimeout(timer);
        }
    }
}

/** What `process` offers for signals; a test passes an `EventEmitter`. */
export interface SignalSource {
    on(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
    off(signal: 'SIGINT' | 'SIGTERM', listener: () => void): unknown;
}

export type StopSignal = 'SIGINT' | 'SIGTERM';

/**
 * Turns the first SIGINT or SIGTERM into a stop request. Every later signal is reported through
 * `onRepeat` and does nothing else: the teardown the first one started is already running.
 */
export class Interrupts {
    private signal: StopSignal | undefined;
    private readonly listeners: Array<() => void> = [];
    private readonly controller = new AbortController();
    private readonly handlers: Record<StopSignal, () => void>;

    constructor(
        private readonly source: SignalSource,
        private readonly onRepeat: (signal: StopSignal) => void = () => undefined,
    ) {
        this.handlers = {
            SIGINT: () => this.trigger('SIGINT'),
            SIGTERM: () => this.trigger('SIGTERM'),
        };
        source.on('SIGINT', this.handlers.SIGINT);
        source.on('SIGTERM', this.handlers.SIGTERM);
    }

    /** The first signal received, or `undefined`. */
    get received(): StopSignal | undefined {
        return this.signal;
    }

    /** Aborted on the first signal. */
    get abortSignal(): AbortSignal {
        return this.controller.signal;
    }

    /** Called on the first signal only. */
    onStop(listener: () => void): void {
        this.listeners.push(listener);
    }

    /** The same as receiving SIGINT: used for Ctrl-C typed at a readline question. */
    trigger(signal: StopSignal): void {
        if (this.signal !== undefined) {
            this.onRepeat(signal);
            return;
        }
        this.signal = signal;
        this.controller.abort(new Interrupted(signal));
        for (const listener of this.listeners) listener();
    }

    /** Rejects with {@link Interrupted} on the first signal; never resolves otherwise. */
    asPromise(): Promise<never> {
        return new Promise<never>((_resolve, reject) => {
            if (this.controller.signal.aborted) {
                reject(this.controller.signal.reason);
                return;
            }
            this.controller.signal.addEventListener('abort', () => reject(this.controller.signal.reason), {once: true});
        });
    }

    dispose(): void {
        this.source.off('SIGINT', this.handlers.SIGINT);
        this.source.off('SIGTERM', this.handlers.SIGTERM);
    }
}

/** The program was asked to stop by a signal. */
export class Interrupted extends Error {
    constructor(readonly signal: StopSignal) {
        super(`Stopped by ${signal}.`);
        this.name = 'Interrupted';
    }
}

/** The exit code for a stop signal. */
export function exitCodeForSignal(signal: StopSignal): ExitCode {
    return signal === 'SIGTERM' ? EXIT.TERMINATED : EXIT.INTERRUPTED;
}

/** Waits for `promise`, or rejects with {@link Interrupted} as soon as a stop signal arrives. */
export function interruptible<T>(promise: Promise<T>, interrupts: Interrupts): Promise<T> {
    const stop = interrupts.asPromise();
    // The losing side of the race must not become an unhandled rejection.
    stop.catch(() => undefined);
    promise.catch(() => undefined);
    return Promise.race([promise, stop]);
}
