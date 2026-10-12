import {strict as assert} from 'node:assert';
import {describe, it} from 'node:test';
import {
    DEFAULT_CONNECT_TIMEOUT_S,
    DEFAULT_HOST,
    DEFAULT_OUT,
    FLAG_HELP,
    parseCliArgs,
    parseSeconds,
    usage,
    type CliOptions,
} from '../../src/args.js';

function ok(argv: string[]): CliOptions {
    const result = parseCliArgs(argv);
    if (!result.ok) assert.fail(`expected success for ${JSON.stringify(argv)}, got: ${result.error}`);
    return result.options;
}

function fails(argv: string[]): string {
    const result = parseCliArgs(argv);
    if (result.ok) assert.fail(`expected failure for ${JSON.stringify(argv)}`);
    return result.error;
}

describe('parseCliArgs: defaults', () => {
    it('no flags gives the defaults', () => {
        assert.deepEqual(ok([]), {
            device: undefined,
            seconds: undefined,
            host: '127.0.0.1',
            port: undefined,
            out: 'recordings',
            connectTimeoutSeconds: 60,
            rate: undefined,
            includeSerial: false,
            single: false,
            pair: false,
            jump: false,
            normal: false,
            help: false,
            helpAll: false,
            forgetDevices: false,
        });
        assert.equal(DEFAULT_HOST, '127.0.0.1');
        assert.equal(DEFAULT_OUT, 'recordings');
        assert.equal(DEFAULT_CONNECT_TIMEOUT_S, 60);
    });
});

describe('parseCliArgs: each flag', () => {
    it('--device is kept as typed (trimmed); validation is the prompt\'s', () => {
        assert.equal(ok(['--device', 'PLATES']).device, 'PLATES');
        assert.equal(ok(['--device', ' grip ']).device, 'grip');
        assert.equal(ok(['--device=LINK']).device, 'LINK');
    });
    it('--seconds', () => {
        assert.equal(ok(['--seconds', '30']).seconds, 30);
        assert.equal(ok(['--seconds', '1']).seconds, 1);
        assert.equal(ok(['--seconds', '3600']).seconds, 3600);
        assert.equal(ok(['--seconds', ' 30 ']).seconds, 30);
    });
    it('--host', () => {
        assert.equal(ok(['--host', 'localhost']).host, 'localhost');
    });
    it('--port', () => {
        assert.equal(ok(['--port', '8477']).port, 8477);
        assert.equal(ok(['--port', '65535']).port, 65535);
    });
    it('--out', () => {
        assert.equal(ok(['--out', '/tmp/x']).out, '/tmp/x');
    });
    it('--connect-timeout', () => {
        assert.equal(ok(['--connect-timeout', '10']).connectTimeoutSeconds, 10);
    });
    it('--rate', () => {
        assert.equal(ok(['--rate', '1000']).rate, 1000);
    });
    it('--include-serial, --help, -h', () => {
        assert.equal(ok(['--include-serial']).includeSerial, true);
        assert.equal(ok(['--help']).help, true);
        assert.equal(ok(['-h']).help, true);
    });
    it('several flags together', () => {
        const o = ok(['--device', 'PLATES', '--seconds', '30', '--port', '8478', '--include-serial']);
        assert.equal(o.device, 'PLATES');
        assert.equal(o.seconds, 30);
        assert.equal(o.port, 8478);
        assert.equal(o.includeSerial, true);
    });
});

describe('parseCliArgs: validation failures', () => {
    const RANGE_SECONDS = '--seconds: Please type a number from 1 to 3600.';
    const WHOLE = (flag: string) => `--${flag}: Please type a whole number.`;

    for (const bad of ['0', '3601', '99999999999999999999']) {
        it(`--seconds ${bad} is out of range`, () => assert.equal(fails(['--seconds', bad]), RANGE_SECONDS));
    }
    for (const bad of ['abc', '-1', '+5', '1.5', '1e3', '0x10', '', ' ']) {
        it(`--seconds ${JSON.stringify(bad)} is not a whole number`, () =>
            assert.equal(fails([`--seconds=${bad}`]), WHOLE('seconds')));
    }
    it('--port out of range', () => {
        assert.equal(fails(['--port', '0']), '--port: Please type a number from 1 to 65535.');
        assert.equal(fails(['--port', '65536']), '--port: Please type a number from 1 to 65535.');
    });
    it('--port not a number', () => assert.equal(fails(['--port', 'http']), WHOLE('port')));
    it('--connect-timeout out of range and not a number', () => {
        assert.equal(fails(['--connect-timeout', '0']), '--connect-timeout: Please type a number from 1 to 3600.');
        assert.equal(fails(['--connect-timeout', '2s']), WHOLE('connect-timeout'));
    });
    it('--rate not a positive whole number', () => {
        assert.equal(fails(['--rate', '0']), '--rate: Please type a number from 1 to 100000.');
        assert.equal(fails(['--rate', '100.5']), WHOLE('rate'));
    });
    it('empty strings for text flags', () => {
        assert.equal(fails(['--device=']), '--device: must not be empty.');
        assert.equal(fails(['--host', ' ']), '--host: must not be empty.');
        assert.equal(fails(['--out=']), '--out: must not be empty.');
    });
    it('unknown flag', () => assert.match(fails(['--nope']), /Unknown option '--nope'/));
    it('positional argument', () => assert.match(fails(['PLATES']), /Unexpected argument 'PLATES'/));
    it('missing value', () => assert.match(fails(['--seconds']), /--seconds/));
});

describe('parseSeconds (shared with the seconds prompt)', () => {
    it('accepts 1, 30, 3600 and " 30 "', () => {
        assert.equal(parseSeconds('1'), 1);
        assert.equal(parseSeconds('30'), 30);
        assert.equal(parseSeconds('3600'), 3600);
        assert.equal(parseSeconds(' 30 '), 30);
    });
    it('refuses 0, -1, 3601, 1.5, 1e3, abc, empty', () => {
        assert.equal(parseSeconds('0'), 'Please type a number from 1 to 3600.');
        assert.equal(parseSeconds('3601'), 'Please type a number from 1 to 3600.');
        for (const bad of ['-1', '1.5', '1e3', 'abc', '']) {
            assert.equal(parseSeconds(bad), 'Please type a whole number.', bad);
        }
    });
});

describe('usage', () => {
    it('--help-all names every flag plus --include-serial', () => {
        const text = usage(undefined, true);
        for (const flag of [
            '--device',
            '--seconds',
            '--host',
            '--port',
            '--out',
            '--connect-timeout',
            '--rate',
            '--include-serial',
            '--single',
            '--pair',
            '--jump',
            '--normal',
            '--help',
            '--help-all',
            '--forget-devices',
        ]) {
            assert.ok(text.includes(flag), flag);
        }
        assert.equal(FLAG_HELP.length, 15);
    });

    it('--help shows only the main flags, and says where the rest are', () => {
        const text = usage();
        for (const flag of ['--device', '--seconds', '--out', '--help', '--help-all']) assert.ok(text.includes(flag), flag);
        for (const flag of ['--host', '--port', '--connect-timeout', '--rate', '--include-serial', '--single', '--pair', '--jump', '--normal', '--forget-devices']) {
            assert.ok(!text.includes(flag), flag);
        }
        assert.match(text, /Main flags \(--help-all lists every flag\):/);
        assert.match(text, /asks for the device type, single sensor or pair/);
    });

    it('--help-all parses', () => {
        assert.equal(ok(['--help-all']).helpAll, true);
        assert.equal(ok([]).helpAll, false);
    });

    it('Says a sensor pair can be recorded, and what --single does', () => {
        const text = usage(undefined, true);
        assert.match(text, /from one Kinvent sensor or a sensor pair/);
        assert.match(text, /--single +K-Plates, K-Deltas, K-Deltas 3D: record one sensor \(the left one\) instead of the pair\./);
    });
});

describe('parseCliArgs: --single', () => {
    it('--single sets single; absent is a pair', () => {
        assert.equal(ok(['--single']).single, true);
        assert.equal(ok(['--device', 'PLATES']).single, false);
    });
    it('--single takes no value', () => assert.match(fails(['--single=yes']), /single/));
});
