/**
 * A {@link Clock} that moves only when the test says so: `advance(ms)` runs every timer that falls due,
 * in time order, with `now()` set to each timer's own due time.
 */
import type {Clock} from '../../src/timer.js';

interface Pending {
    id: number;
    at: number;
    callback: () => void;
}

export class ManualClock implements Clock {
    private time = 0;
    private nextId = 1;
    private pending: Pending[] = [];

    now(): number {
        return this.time;
    }

    setTimeout(callback: () => void, ms: number): unknown {
        const id = this.nextId++;
        this.pending.push({id, at: this.time + Math.max(0, ms), callback});
        return id;
    }

    clearTimeout(handle: unknown): void {
        this.pending = this.pending.filter((entry) => entry.id !== handle);
    }

    /** Timers not yet run. */
    get waiting(): number {
        return this.pending.length;
    }

    /** Moves time forward by `ms`, running due timers; awaits between them so promise chains settle. */
    async advance(ms: number): Promise<void> {
        const target = this.time + ms;
        for (;;) {
            await flush();
            const due = this.pending.filter((entry) => entry.at <= target).sort((a, b) => a.at - b.at || a.id - b.id)[0];
            if (due === undefined) break;
            this.pending = this.pending.filter((entry) => entry !== due);
            this.time = due.at;
            due.callback();
        }
        this.time = target;
        await flush();
    }
}

/** Lets pending promise reactions run. */
export async function flush(): Promise<void> {
    for (let i = 0; i < 10; i += 1) await Promise.resolve();
}
