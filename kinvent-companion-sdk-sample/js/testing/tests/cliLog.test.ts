/**
 * The run log (`src/cliLog.ts`): the flow is kept, the live values and the terminal's redraws are not, and a run
 * is never stopped by it.
 */
import {strict as assert} from 'node:assert';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, describe, it} from 'node:test';
import {openCliLog, shouldLog} from '../../src/cliLog.js';

const SCRATCH = mkdtempSync(join(tmpdir(), 'cli-sample-log-'));
after(() => rmSync(SCRATCH, {recursive: true, force: true}));

describe('cli log', () => {
    it('keeps messages, drops the live view and redraws', () => {
        assert.equal(shouldLog('Device: K-Grip (GRIP). Recording time: 10 s.\n'), true);
        assert.equal(shouldLog('Calibration has failed (K-Plate Left: forces were being applied). Please step off the plates.\n'), true);
        assert.equal(shouldLog('1.0/5.0 s  |  75 Hz set (device configuration)  |  75 Hz measured  |  150 samples  |  force1 12.35 kg\n'), false);
        assert.equal(shouldLog('12.0/30.0 s  |  K-Plate Left: 250 Hz set, force1 70.10 kg  |  K-Plate Right: …\n'), false);
        assert.equal(shouldLog('\r\u001b[2K  forceTotal 12.00 kg\n'), false);
    });

    it('writes one dated file per day with a run header and a time on each line', () => {
        const dir = join(SCRATCH, 'logs');
        const log = openCliLog(dir, new Date(2026, 9, 9, 10, 0, 0));
        assert.ok(log);
        assert.match(log.path, /cli-20261009\.log$/);
        log.write('Session claimed.\n');
        log.write('1.0/2.0 s  |  live values\n');
        log.write('Done. 1008 samples in 2.0 s from K-Grip (GRIP), 500.0 Hz measured; no data lost.\n');
        const text = readFileSync(log.path, 'utf8');
        assert.match(text, /^\n===== run 2026-10-09T/m);
        assert.match(text, /^\d\d:\d\d:\d\d\.\d{3} Session claimed\.$/m);
        assert.match(text, /Done\. 1008 samples/);
        assert.doesNotMatch(text, /live values/);
    });

    it('an unwritable folder gives no log, not an error', () => {
        assert.equal(openCliLog(join(SCRATCH, 'file-not-folder', 'x', '\0bad')), undefined);
    });
});
