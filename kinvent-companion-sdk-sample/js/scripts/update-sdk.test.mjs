/**
 * Tests of `scripts/update-sdk.mjs`. They need no network and no real npm: a small stand-in for npm (a JavaScript
 * file passed as `npm_execpath`) writes the installed SDK manifest with the version found in the SDK file.
 * Every file is written in a temporary folder and deleted at the end.
 */
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {dirname, join} from 'node:path';
import {fileURLToPath} from 'node:url';
import {after, describe, it} from 'node:test';

import {INSTALLED_MANIFEST, SDK_FILE, installedSdkVersion, missingFileMessage, npmCommand, updateSdk} from './update-sdk.mjs';

const SCRIPT = join(dirname(fileURLToPath(import.meta.url)), 'update-sdk.mjs');
const scratch = mkdtempSync(join(tmpdir(), 'update-sdk-test-'));
after(() => rmSync(scratch, {recursive: true, force: true}));

// The stand-in for npm: it records its arguments and "installs" the SDK by writing its manifest, with the
// version written in the (not real) SDK file. It fails when the SDK file says "fail".
const FAKE_NPM = join(scratch, 'fake-npm.cjs');
writeFileSync(
    FAKE_NPM,
    [
        "const fs = require('node:fs');",
        "const path = require('node:path');",
        "fs.writeFileSync('npm-args.txt', process.argv.slice(2).join(' '));",
        "const version = fs.readFileSync(path.join('vendor', 'kinvent-companion-sdk.tgz'), 'utf8').trim();",
        "if (version === 'fail') process.exit(3);",
        "if (version === 'empty') process.exit(0);",
        "const dir = path.join('node_modules', '@kinvent', 'companion-sdk');",
        'fs.mkdirSync(dir, {recursive: true});',
        "fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({name: '@kinvent/companion-sdk', version}));",
        '',
    ].join('\n'),
);

let count = 0;
/** A project folder: `sdk` is the text of the SDK file (or null for no file); `old` installs an old SDK and a lockfile. */
function project({sdk = '2.0.0', old = true} = {}) {
    const root = join(scratch, `project-${(count += 1)}`);
    mkdirSync(join(root, 'scripts'), {recursive: true});
    copyFileSync(SCRIPT, join(root, 'scripts', 'update-sdk.mjs'));
    if (sdk !== null) {
        mkdirSync(join(root, 'vendor'), {recursive: true});
        writeFileSync(join(root, SDK_FILE), sdk);
    }
    if (old) {
        mkdirSync(dirname(join(root, INSTALLED_MANIFEST)), {recursive: true});
        writeFileSync(join(root, INSTALLED_MANIFEST), JSON.stringify({version: '1.0.0'}));
        writeFileSync(join(root, 'package-lock.json'), '{"lockfileVersion": 3}\n');
    }
    return root;
}

/** Runs the script (in its own scripts/ folder) in `root` as `npm run update-sdk` would, with the stand-in npm. */
function runScript(root) {
    return spawnSync(process.execPath, [join(root, 'scripts', 'update-sdk.mjs')], {
        cwd: root,
        encoding: 'utf8',
        env: {...process.env, npm_execpath: FAKE_NPM},
    });
}

describe('update-sdk: as a program', () => {
    it('deletes node_modules and package-lock.json, runs npm install, and prints the new SDK version', () => {
        const root = project({sdk: '2.0.0'});
        const result = runScript(root);
        assert.equal(result.status, 0, result.stderr);
        assert.equal(readFileSync(join(root, 'npm-args.txt'), 'utf8'), 'install');
        assert.equal(installedSdkVersion(root), '2.0.0');
        assert.equal(existsSync(join(root, 'package-lock.json')), false, 'the old lockfile is deleted (the stand-in writes none)');
        assert.match(result.stdout, /deleting node_modules/);
        assert.match(result.stdout, /deleting package-lock\.json/);
        assert.match(result.stdout, /installed @kinvent\/companion-sdk 2\.0\.0 \(before: 1\.0\.0\)/);
        assert.match(result.stdout, /Kinvent Companion app of version 2\.0\.0/);
    });

    it('works in a project that was never installed', () => {
        const root = project({sdk: '2.0.0', old: false});
        const result = runScript(root);
        assert.equal(result.status, 0, result.stderr);
        assert.doesNotMatch(result.stdout, /deleting/);
        assert.match(result.stdout, /installed @kinvent\/companion-sdk 2\.0\.0\n/);
    });

    it('refuses when the SDK file is missing, and deletes nothing', () => {
        const root = project({sdk: null});
        const result = runScript(root);
        assert.equal(result.status, 1);
        assert.match(result.stderr, /kinvent-companion-sdk\.tgz is missing\. Nothing was changed\./);
        assert.equal(installedSdkVersion(root), '1.0.0');
        assert.equal(existsSync(join(root, 'package-lock.json')), true);
        assert.equal(existsSync(join(root, 'npm-args.txt')), false, 'npm was not started');
    });

    it('fails with exit code 1 when npm install fails', () => {
        const result = runScript(project({sdk: 'fail'}));
        assert.equal(result.status, 1);
        assert.match(result.stderr, /npm install failed \(exit code 3\)/);
    });

    it('fails when npm install leaves no SDK behind', () => {
        const result = runScript(project({sdk: 'empty'}));
        assert.equal(result.status, 1);
        assert.match(result.stderr, /cannot be read/);
    });
});

describe('update-sdk: its parts', () => {
    it('under npm run, starts npm through its own JavaScript file, with no shell', () => {
        assert.deepEqual(npmCommand({npm_execpath: '/x/npm-cli.js'}, 'win32', '/node'), {command: '/node', args: ['/x/npm-cli.js', 'install'], shell: false});
    });

    it('without npm_execpath, starts npm (npm.cmd with a shell on Windows)', () => {
        assert.deepEqual(npmCommand({}, 'linux'), {command: 'npm', args: ['install'], shell: false});
        assert.deepEqual(npmCommand({}, 'darwin'), {command: 'npm', args: ['install'], shell: false});
        assert.deepEqual(npmCommand({}, 'win32'), {command: 'npm.cmd', args: ['install'], shell: true});
    });

    it('the missing-file message says what to do', () => {
        assert.match(missingFileMessage(), /Copy the Kinvent SDK file you received .* as kinvent-companion-sdk\.tgz, then run npm run update-sdk again\./);
    });

    it('reports a start error of npm', () => {
        const root = project({sdk: '2.0.0'});
        const errors = [];
        const code = updateSdk({root, env: {}, run: () => ({error: new Error('spawn npm ENOENT'), status: null}), log: () => {}, error: (m) => errors.push(m)});
        assert.equal(code, 1);
        assert.match(errors.join('\n'), /npm install failed \(spawn npm ENOENT\)/);
    });
});
