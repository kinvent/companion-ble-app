/**
 * FOR INTEGRATORS: Terminal plumbing, no SDK call. A program with its own UI does not need this file; skip it on a first read. Keep its one rule if you log: never log the live values.
 *
 * A LOG OF WHAT THE SAMPLE SAID, for support: every message of a run, appended to one file per day under the user's
 * home folder, readable by the user only. The terminal is still the primary output; this only keeps a copy.
 *
 * NOT THE LIVE VALUES. The live view prints force values several times a second; those are the person's sensor data,
 * which belong in the recording and nowhere else. `shouldLog` drops the live-view lines and the terminal's redraw
 * sequences, so the log holds the flow — devices, rates, calibration, errors, the file's path — and no measurement.
 */
import {appendFileSync, chmodSync, mkdirSync} from 'node:fs';
import {homedir} from 'node:os';
import {join} from 'node:path';

/** Where the logs live unless the caller says otherwise. */
export function defaultLogDirectory(): string {
    return join(homedir(), '.kinvent-companion-sample', 'logs');
}

/** The live view's one-line state ("1.0/5.0 s  |  …") and any terminal redraw (carriage return, escape codes). */
const LIVE_LINE = /^\d+\.\d+\/\d+\.\d+ s\s+\|/;

export function shouldLog(text: string): boolean {
    if (text.includes('\r') || text.includes('\u001b')) return false;
    return !LIVE_LINE.test(text.trimStart());
}

export interface CliLog {
    path: string;
    /** Append one write of the terminal, if it is worth keeping. Never throws: a log must not end a run. */
    write(text: string): void;
}

/** Open today's log file (created with mode 0600, in a 0700 folder) and note that a run started. */
export function openCliLog(directory = defaultLogDirectory(), now = new Date()): CliLog | undefined {
    try {
        mkdirSync(directory, {recursive: true, mode: 0o700});
        const day = `${now.getFullYear()}${String(now.getMonth() + 1).padStart(2, '0')}${String(now.getDate()).padStart(2, '0')}`;
        const path = join(directory, `cli-${day}.log`);
        const stamp = (): string => now.toISOString();
        appendFileSync(path, `\n===== run ${stamp()} (${process.platform}, node ${process.version})\n`, {encoding: 'utf8', mode: 0o600});
        chmodSync(path, 0o600);
        return {
            path,
            write: (text) => {
                // Judged on the raw text, THEN each line is prefixed with the time, so a run can be read against the
                // companion's log.
                if (!shouldLog(text)) return;
                try {
                    appendFileSync(path, text.replace(/^(?=.)/gm, () => `${new Date().toISOString().slice(11, 23)} `), {encoding: 'utf8', mode: 0o600});
                } catch {
                    // Nothing: the terminal has the text.
                }
            },
        };
    } catch {
        return undefined;
    }
}
