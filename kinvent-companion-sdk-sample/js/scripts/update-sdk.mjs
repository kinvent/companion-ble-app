#!/usr/bin/env node
/**
 * npm run update-sdk
 *
 * Makes a new Kinvent SDK file take effect. Use it after you replace `vendor/kinvent-companion-sdk.tgz` with a
 * newer file from Kinvent.
 *
 * Why it is needed: the file name stays the same, so a plain `npm install` does not see a change. npm keeps the old
 * SDK in `node_modules/`, and `package-lock.json` still records the bytes of the old file. Then npm either stops with
 * `EINTEGRITY`, or it keeps the old SDK without any message.
 *
 * What it does, on macOS, Linux and Windows:
 *   1. stops with a clear message if `vendor/kinvent-companion-sdk.tgz` is missing (and deletes nothing);
 *   2. deletes `node_modules/` and `package-lock.json`, if they are there;
 *   3. runs `npm install`;
 *   4. prints the SDK version that is now installed (from `node_modules/@kinvent/companion-sdk/package.json`).
 *
 * Plain Node.js, no dependencies. Exit code 0 on success, 1 on any error.
 */
import {spawnSync} from 'node:child_process';
import {existsSync, readFileSync, realpathSync, rmSync} from 'node:fs';
import {dirname, join, resolve} from 'node:path';
import {fileURLToPath} from 'node:url';

/** The SDK file, relative to the project folder. */
export const SDK_FILE = join('vendor', 'kinvent-companion-sdk.tgz');
/** The manifest of the installed SDK, relative to the project folder. */
export const INSTALLED_MANIFEST = join('node_modules', '@kinvent', 'companion-sdk', 'package.json');
/** What is deleted before `npm install`, in this order. */
export const REMOVED = Object.freeze(['node_modules', 'package-lock.json']);

/** The project folder: the parent of `scripts/`. */
export const PROJECT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** The message when the SDK file is missing. */
export function missingFileMessage() {
    return (
        `update-sdk: ${SDK_FILE} is missing. Nothing was changed.\n` +
        'Copy the Kinvent SDK file you received (for example kinvent-companion-sdk-<version>.tgz) into the vendor folder ' +
        'as kinvent-companion-sdk.tgz, then run npm run update-sdk again.'
    );
}

/**
 * How to start `npm install`. Under `npm run`, npm sets `npm_execpath` to its own JavaScript file: run that file with
 * this Node.js (no shell, the same on every system). Without it, start `npm` (on Windows `npm.cmd`, which needs a
 * shell).
 */
export function npmCommand(env = process.env, platform = process.platform, nodePath = process.execPath) {
    const execPath = env.npm_execpath;
    if (typeof execPath === 'string' && /\.[cm]?js$/i.test(execPath)) {
        return {command: nodePath, args: [execPath, 'install'], shell: false};
    }
    const windows = platform === 'win32';
    return {command: windows ? 'npm.cmd' : 'npm', args: ['install'], shell: windows};
}

/** The version of the installed SDK, or `undefined` when it is not installed or cannot be read. */
export function installedSdkVersion(root) {
    try {
        const version = JSON.parse(readFileSync(join(root, INSTALLED_MANIFEST), 'utf8')).version;
        return typeof version === 'string' ? version : undefined;
    } catch {
        return undefined;
    }
}

/** Runs the update in `root`. Returns the exit code. */
export function updateSdk({root = PROJECT_ROOT, env = process.env, platform = process.platform, run = spawnSync, log = console.log, error = console.error} = {}) {
    if (!existsSync(join(root, SDK_FILE))) {
        error(missingFileMessage());
        return 1;
    }
    const before = installedSdkVersion(root);
    for (const name of REMOVED) {
        const path = join(root, name);
        if (!existsSync(path)) continue;
        log(`update-sdk: deleting ${name}`);
        rmSync(path, {recursive: true, force: true});
    }
    log('update-sdk: running npm install');
    const {command, args, shell} = npmCommand(env, platform);
    const result = run(command, args, {cwd: root, stdio: 'inherit', shell});
    if (result.error !== undefined || result.status !== 0) {
        const why = result.error !== undefined ? result.error.message : `exit code ${result.status}`;
        error(`update-sdk: npm install failed (${why}). Read the npm message above, fix it, then run npm run update-sdk again.`);
        return 1;
    }
    const after = installedSdkVersion(root);
    if (after === undefined) {
        error(`update-sdk: npm install finished, but ${INSTALLED_MANIFEST} cannot be read. Is ${SDK_FILE} a Kinvent SDK file?`);
        return 1;
    }
    log(`update-sdk: installed @kinvent/companion-sdk ${after}${before !== undefined && before !== after ? ` (before: ${before})` : ''}`);
    log(`update-sdk: use the Kinvent Companion app of version ${after}, then run npm run build.`);
    return 0;
}

// realpathSync on both sides: a temporary or linked folder (macOS /var -> /private/var) must still count.
const isEntryPoint = () => {
    try {
        return process.argv[1] !== undefined && realpathSync(process.argv[1]) === realpathSync(fileURLToPath(import.meta.url));
    } catch {
        return false;
    }
};

if (isEntryPoint()) process.exitCode = updateSdk();
