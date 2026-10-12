/**
 * The parts: the flags, the jump question, the jump-rate rule of both ballistic
 * families, the final layout of a configuration, and the recorder's deferred head. Every value is synthetic.
 */
import {strict as assert} from 'node:assert';
import {existsSync, mkdtempSync, readFileSync, rmSync, statSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {after, describe, it} from 'node:test';
import {
    DeviceType,
    RawDataProtocolType,
    StreamUnit,
    streamLayoutOf,
    type ForceSample,
    type FrequencySettingsSnapshot,
    type StreamField,
} from '@kinvent/companion-sdk';
import {parseCliArgs} from '../../src/args.js';
import {BALLISTIC_FAMILIES, decideJumpRates, jumpRatesOf} from '../../src/companion.js';
import {finalLayoutOf} from '../../src/measure.js';
import {askJump, canJump, InputClosed, jumpRefusedMessage, type LineReader} from '../../src/prompts.js';
import {jumpLines, Recorder, type FinalLayout, type RecordingFacts} from '../../src/recorder.js';
import {DEFAULT_FREQUENCIES} from '../doubles/fakeCompanion.js';

const SCRATCH = mkdtempSync(join(tmpdir(), 'cli-sample-jump-parts-'));
after(() => rmSync(SCRATCH, {recursive: true, force: true}));
let folders = 0;

const FIXED = new Date(2026, 9, 7, 10, 15, 30, 123).getTime();

function scripted(answers: Array<string | undefined>): LineReader & {asked: string[]} {
    const queue = [...answers];
    const asked: string[] = [];
    return {
        asked,
        ask(prompt: string): Promise<string | undefined> {
            asked.push(prompt);
            if (queue.length === 0) throw new Error(`no scripted answer left for: ${prompt}`);
            return Promise.resolve(queue.shift());
        },
    };
}
const sink = (): {write(text: string): void; text: string} => {
    const out = {text: '', write: (t: string) => void (out.text += t)};
    return out;
};

describe('Flags', () => {
    const ok = (argv: string[]) => {
        const result = parseCliArgs(argv);
        if (!result.ok) assert.fail(result.error);
        return result.options;
    };
    it('--jump, --normal, --pair set their option; absent is false', () => {
        assert.equal(ok(['--jump']).jump, true);
        assert.equal(ok(['--normal']).normal, true);
        assert.equal(ok(['--pair']).pair, true);
        assert.deepEqual([ok([]).jump, ok([]).normal, ok([]).pair], [false, false, false]);
    });
    it('opposite answers together are a usage error', () => {
        assert.deepEqual(parseCliArgs(['--jump', '--normal']), {ok: false, error: '--jump and --normal: choose one.'});
        assert.deepEqual(parseCliArgs(['--single', '--pair']), {ok: false, error: '--single and --pair: choose one.'});
    });
    it('they take no value', () => {
        for (const flag of ['--jump=yes', '--normal=1', '--pair=no']) assert.equal(parseCliArgs([flag]).ok, false);
    });
});

describe('The jump question', () => {
    it('offered for the three floor types, as in the mobile app', () => {
        const offered = (Object.values(DeviceType) as DeviceType[]).filter(canJump);
        assert.deepEqual(offered.sort(), [DeviceType.HEXAS, DeviceType.PLATES, DeviceType.DELTAS_3D].sort());
        assert.match(jumpRefusedMessage(DeviceType.GRIP), /K-Grip \(GRIP\) has no jump test\.$/);
    });
    it('a flag answers it; not a jump type or no terminal: normal, nothing asked', async () => {
        const reader = scripted([]);
        assert.equal(await askJump('jump', DeviceType.HEXAS, {reader, out: sink()}), true);
        assert.equal(await askJump('normal', DeviceType.PLATES, {reader, out: sink()}), false);
        assert.equal(await askJump(undefined, DeviceType.GRIP, {reader, out: sink()}), false);
        assert.equal(await askJump(undefined, DeviceType.HEXAS, {reader: undefined, out: sink()}), false);
        assert.deepEqual(reader.asked, []);
    });
    it('at a terminal: y jumps, empty is normal, anything else asks again, Ctrl-D ends', async () => {
        const out = sink();
        const reader = scripted(['maybe', 'Y']);
        assert.equal(await askJump(undefined, DeviceType.HEXAS, {reader, out}), true);
        assert.deepEqual(reader.asked, ['Jump test (total force at a high rate)? [y/N] ', 'Jump test (total force at a high rate)? [y/N] ']);
        assert.equal(out.text, 'Please type y or n.\n');
        assert.equal(await askJump(undefined, DeviceType.PLATES, {reader: scripted(['']), out: sink()}), false);
        await assert.rejects(askJump(undefined, DeviceType.PLATES, {reader: scripted([undefined]), out: sink()}), InputClosed);
    });
});

describe('The jump rates of both ballistic families', () => {
    const snapshot = (): FrequencySettingsSnapshot => structuredClone(DEFAULT_FREQUENCIES);
    it('both families, in that order; why both is documented beside the list', () => {
        assert.deepEqual([...BALLISTIC_FAMILIES], ['deltasMiniBallistic', 'deltasXlBallistic']);
    });
    it('jump rates are the jumpProtocol options only; 4000 on the XL', () => {
        const families = snapshot().families;
        assert.deepEqual(jumpRatesOf(families.find((f) => f.family === 'deltasMiniBallistic')!, false), [500, 1000, 2000]);
        assert.deepEqual(jumpRatesOf(families.find((f) => f.family === 'deltasXlBallistic')!, false), [500, 1000, 2000, 4000]);
    });
    it('no --rate: each at its current rate, both sent (the mode differs); already set: none sent', () => {
        const fresh = decideJumpRates(snapshot(), undefined);
        assert.deepEqual(fresh, {
            kind: 'ok',
            plans: [
                {family: 'deltasMiniBallistic', rate: 1000, send: true, from: 'current'},
                {family: 'deltasXlBallistic', rate: 1000, send: true, from: 'current'},
            ],
            notes: [],
        });
        const set = snapshot();
        for (const f of set.families) if (f.family.endsWith('Ballistic')) f.current = {rate: 1000, mode: 'jumpProtocol'};
        const again = decideJumpRates(set, undefined);
        assert.ok(again.kind === 'ok' && again.plans.every((plan) => !plan.send));
        // Same rate, other mode: sent.
        const other = decideJumpRates(set, 2000);
        assert.ok(other.kind === 'ok' && other.plans.every((plan) => plan.send && plan.rate === 2000 && plan.from === '--rate'));
    });
    it('--rate 4000: the XL only, the K-Deltas keeps its current rate and a note says so', () => {
        const decision = decideJumpRates(snapshot(), 4000);
        assert.equal(decision.kind, 'ok');
        if (decision.kind !== 'ok') return;
        assert.deepEqual(decision.plans.map((plan) => [plan.family, plan.rate, plan.from]), [
            ['deltasMiniBallistic', 1000, 'current'],
            ['deltasXlBallistic', 4000, '--rate'],
        ]);
        assert.deepEqual(decision.notes, ['--rate 4000 Hz is offered on the K-Deltas XL only; a K-Deltas jumps at 1000 Hz.']);
    });
    it('refused: a rate no family offers in the jump mode; a current rate that is not a jump rate; a family missing', () => {
        assert.deepEqual(decideJumpRates(snapshot(), 300), {
            kind: 'refuse',
            message: '--rate: 300 Hz is not a jump rate. Jump rates: K-Deltas 500, 1000, 2000 Hz; K-Deltas XL 500, 1000, 2000, 4000 Hz.',
        });
        const low = snapshot();
        low.families.find((f) => f.family === 'deltasMiniBallistic')!.current = {rate: 250, mode: 'default'};
        const refused = decideJumpRates(low, undefined);
        assert.equal(refused.kind, 'refuse');
        assert.match(refused.kind === 'refuse' ? refused.message : '', /the K-Deltas rate is 250 Hz, which is not a jump rate \(500, 1000, 2000 Hz\)\. Pass --rate/);
        // With --rate the current rate does not matter.
        assert.equal(decideJumpRates(low, 500).kind, 'ok');
        const none = snapshot();
        none.families = none.families.filter((f) => f.family !== 'deltasXlBallistic');
        assert.deepEqual(decideJumpRates(none, undefined), {kind: 'refuse', message: '--jump: the companion offers no jump-protocol rate setting (deltasXlBallistic).'});
    });
});

describe('The final layout of a configuration', () => {
    const FOUR: StreamField[] = [0, 1, 2, 3].map((index) => ({index, name: `force${index + 1}`, unit: StreamUnit.KILOGRAM}));
    it('V3 jump: forceTotal, mode jump, the rate, jump protocol yes', () => {
        const configuration = {capabilities: {baselineErrorCheck: false}, timeSynced: null, protocolType: RawDataProtocolType.V3_JUMP_PROTOCOL, numOfChannels: 1, samplingFrequency: 2000};
        assert.deepEqual(finalLayoutOf({deviceType: DeviceType.HEXAS}, configuration, {fields: FOUR, setRateHz: 75}), {
            fields: [{index: 0, name: 'forceTotal', unit: StreamUnit.KILOGRAM}],
            sampleRateHz: 2000,
            mode: 'jump',
            jumpProtocol: true,
        });
    });
    it('V3 force (a V3 plate): the four cells, mode null (normal), jump protocol no; the stream layout is read first', () => {
        const base = {capabilities: {baselineErrorCheck: false}, timeSynced: null, protocolType: RawDataProtocolType.V3_FORCE, numOfChannels: 4};
        const configuration = {...base, stream: streamLayoutOf(DeviceType.PLATES, base)!};
        const layout = finalLayoutOf({deviceType: DeviceType.PLATES}, configuration, {fields: [], setRateHz: 75});
        assert.deepEqual(layout, {fields: FOUR, sampleRateHz: 75, mode: null, jumpProtocol: false});
    });
    it('no configuration: what is known, mode and protocol unknown', () => {
        assert.deepEqual(finalLayoutOf({deviceType: DeviceType.HEXAS}, undefined, {fields: FOUR, setRateHz: 75}), {
            fields: FOUR,
            sampleRateHz: 75,
            mode: undefined,
            jumpProtocol: undefined,
        });
    });
});

describe('The recorder: the head waits for the final layout', () => {
    const FOUR: StreamField[] = [0, 1, 2, 3].map((index) => ({index, name: `force${index + 1}`, unit: StreamUnit.KILOGRAM}));
    const TOTAL: FinalLayout = {fields: [{index: 0, name: 'forceTotal', unit: StreamUnit.KILOGRAM}], sampleRateHz: 1000, mode: 'jump', jumpProtocol: true};
    const facts = (over: Partial<RecordingFacts> = {}): RecordingFacts => ({
        sampleVersion: 's',
        companionVersion: 'c',
        sdkVersion: 'k',
        deviceType: 'HEXAS',
        deviceTitle: 'K-Deltas',
        seconds: 1,
        sampleRateHz: 75,
        countdownSeconds: 3,
        fields: FOUR,
        jump: {devices: [{mode: undefined, jumpProtocol: undefined}]},
        ...over,
    });
    const recorder = (now: () => number = () => FIXED): Recorder => new Recorder({folder: `f${++folders}`, cwd: SCRATCH, now});
    const s = (timeStamp: number, channels: number[]): ForceSample => ({timeStamp, isTimeStampFromEpoch: false, channels});

    it('open writes nothing; batches wait; settleLayout writes the head from the final layout, then the batches', async () => {
        let clock = FIXED;
        const rec = recorder(() => clock);
        const path = await rec.open(facts());
        assert.ok(existsSync(path));
        assert.equal(statSync(path).size, 0, 'nothing written before the layout is final');
        assert.equal(rec.headPending, true);
        await rec.append([s(0, [10.5]), s(1, [11])]);
        clock = FIXED + 7; // the time zero is the arrival of the first batch, not the time of the settle
        await rec.settleLayout([TOTAL]);
        assert.equal(rec.headPending, false);
        await rec.append([s(2, [12.25])]);
        await rec.settleLayout([undefined]); // once only
        await rec.end('time end');
        assert.equal(
            readFileSync(path, 'utf8'),
            [
                '"Kinvent Companion CLI sample s","Companion c","companion-sdk k","Devices:","K-Deltas"',
                '"Session Date","2026-10-07"',
                '"Session Time","10:15:30"',
                '"Configuration"',
                '"Device type","HEXAS"',
                '"Recording time (sec)",1',
                '"Sample rate set (Hz)",1000',
                '"Countdown (sec)",3',
                '"Exercise type","JUMP_ANALYSIS"',
                '"Mode","jump"',
                '"Jump protocol","yes"',
                '"Channels"',
                '"Column","Field","Unit","Unit code"',
                '"CHANNEL_1","forceTotal","kg","KILOGRAM"',
                '',
                '"Raw Channel Data"',
                '"Time at time zero","10:15:30:123"',
                '"","K-Deltas"',
                '"Time (sec)","CHANNEL_1"',
                '0,10.500000000000000',
                '0.001,11.000000000000000',
                '0.002,12.250000000000000',
                '',
                '"Summary"',
                '"Rows",3',
                '"Sample rate measured (Hz)",1000.0',
                '"Samples lost",0',
                '"Gaps",0',
                '"End reason","time end"',
                '',
            ].join('\n'),
        );
    });

    it('ended before the layout was final: the head from what is known, mode and protocol "unknown", the batches kept', async () => {
        const rec = recorder();
        const path = await rec.open(facts());
        await rec.append([s(0, [1, 2, 3, 4])]);
        const result = await rec.end('Ctrl-C');
        assert.equal(result.rows, 1);
        const text = readFileSync(path, 'utf8');
        assert.match(text, /\n"Sample rate set \(Hz\)",75\n"Countdown \(sec\)",3\n"Exercise type","JUMP_ANALYSIS"\n"Mode","unknown"\n"Jump protocol","unknown"\n"Channels"\n/);
        assert.match(text, /"Time \(sec\)","CHANNEL_1","CHANNEL_2","CHANNEL_3","CHANNEL_4"\n0,1\.000000000000000,2\.000000000000000,3\.000000000000000,4\.000000000000000\n/);
    });

    it('two devices: one Mode row when they agree, else one per device; Jump protocol per device; columns from the final fields', async () => {
        const rec = recorder();
        const devices = [
            {title: 'K-Delta Left', fields: FOUR, sampleRateHz: 75},
            {title: 'K-Delta Right', fields: FOUR, sampleRateHz: 75},
        ];
        const path = await rec.open(facts({devices, jump: {devices: devices.map(() => ({mode: undefined, jumpProtocol: undefined}))}}));
        await rec.append([s(0, [5])], 0);
        await rec.append([s(0, [6])], 1);
        await rec.settleLayout([TOTAL, {...TOTAL, mode: null, jumpProtocol: false, fields: FOUR, sampleRateHz: 75}]);
        await rec.end('time end');
        const text = readFileSync(path, 'utf8');
        assert.match(
            text,
            /\n"Sample rate set \(Hz\) \(K-Delta Left\)",1000\n"Sample rate set \(Hz\) \(K-Delta Right\)",75\n"Countdown \(sec\)",3\n"Exercise type","JUMP_ANALYSIS"\n"Mode \(K-Delta Left\)","jump"\n"Mode \(K-Delta Right\)","normal"\n"Jump protocol \(K-Delta Left\)","yes"\n"Jump protocol \(K-Delta Right\)","no"\n"Channels"\n/,
        );
        assert.match(text, /\n"Time \(sec\)","CHANNEL_1","","CHANNEL_1","CHANNEL_2","CHANNEL_3","CHANNEL_4"\n0,5\.000000000000000,"",6\.000000000000000,,,\n/);
    });

    it('jumpLines: one device without titles; agreeing devices share one Mode row', () => {
        assert.deepEqual(jumpLines({devices: [{mode: 'jump', jumpProtocol: true}]}), ['"Exercise type","JUMP_ANALYSIS"', '"Mode","jump"', '"Jump protocol","yes"']);
        assert.deepEqual(jumpLines({devices: [{mode: null, jumpProtocol: false}, {mode: null, jumpProtocol: false}]}, ['A', 'B']), [
            '"Exercise type","JUMP_ANALYSIS"',
            '"Mode","normal"',
            '"Jump protocol (A)","no"',
            '"Jump protocol (B)","no"',
        ]);
    });

    it('without facts.jump nothing waits: the preamble is written at open', async () => {
        const rec = recorder();
        const path = await rec.open(facts({jump: undefined}));
        assert.equal(rec.headPending, false);
        assert.match(readFileSync(path, 'utf8'), /^"Kinvent Companion CLI sample s".*\n[\s\S]*"Raw Channel Data"\n$/);
        await rec.end('time end');
    });
});
