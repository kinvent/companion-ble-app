#!/usr/bin/env node
/**
 * FOR INTEGRATORS: Program plumbing, no SDK call: it connects `runCli` (`run.ts`) to the real terminal (questions on stdin,
 * output, signals) and keeps a copy of the messages in a log. Your own program replaces this file.
 *
 * Entry point of the Kinvent companion SDK sample. Builds the environment from
 * `process` and runs {@link runCli} (`run.ts`), which holds the whole flow.
 */
import {readFileSync} from 'node:fs';
import {openCliLog} from './cliLog.js';
import {runCli} from './run.js';
import {terminalReader} from './prompts.js';

function sampleVersion(): string {
    // dist/cli.js -> ../package.json. Read at run time so the banner always shows the manifest's
    // version.
    const manifest = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as {
        version?: unknown;
    };
    return typeof manifest.version === 'string' ? manifest.version : 'unknown';
}

// A reader that stops early (`| head`) closes the pipe; writing on is EPIPE, which is not an error of ours.
for (const stream of [process.stdout, process.stderr]) {
    stream.on('error', (error: NodeJS.ErrnoException) => {
        if (error.code !== 'EPIPE') throw error;
    });
}

// A copy of every message (never the live values) under the user's home folder, for support; see `cliLog.ts`.
const log = openCliLog();
const tee = (stream: NodeJS.WriteStream) => ({
    write: (text: string): void => {
        stream.write(text);
        log?.write(text);
    },
});
if (log !== undefined) process.stdout.write(`Log: ${log.path}\n`);

const code = await runCli({
    argv: process.argv.slice(2),
    stdout: tee(process.stdout),
    stderr: tee(process.stderr),
    version: sampleVersion(),
    makeReader: process.stdin.isTTY ? (onInterrupt) => terminalReader(process.stdin, process.stdout, onInterrupt) : undefined,
    signals: process,
    stdoutIsTTY: process.stdout.isTTY === true,
    // E9: a second Ctrl-C while the recording is being closed ends the process at once.
    exit: (exitCode) => process.exit(exitCode),
});
process.exitCode = code;
// Everything the run started has been stopped by its teardown, so the process ends on its own. This
// timer does not keep it alive (`unref`); it only ends a process that something unexpected still holds.
setTimeout(() => process.exit(code), 2000).unref();
