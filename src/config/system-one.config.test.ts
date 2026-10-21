import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { _resetSystemOneConfigCache, getSystemOneConfig, visionModels } from './system-one.config';

const SYS1_ENV_KEYS = [
    'SYS1_PROVIDER',
    'SYS1_OLLAMA_BASE_URL',
    'OLLAMA_API_URL',
    'SYS1_MODEL',
    'SYS1_ALLOWED_MODELS',
    'SYS1_TIMEOUT_MS',
    'SYS1_KEEP_ALIVE',
];

describe('system-one.config — getSystemOneConfig', () => {
    let savedEnv: Record<string, string | undefined>;

    beforeEach(() => {
        savedEnv = {};
        for (const key of SYS1_ENV_KEYS) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
        }
        _resetSystemOneConfigCache();
    });

    afterEach(() => {
        for (const key of SYS1_ENV_KEYS) {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
        }
        _resetSystemOneConfigCache();
    });

    it('returns the defaults with an empty environment, without throwing', () => {
        expect(getSystemOneConfig()).toEqual({
            provider: 'ollama',
            ollamaBaseUrl: undefined,
            defaultModel: 'nimble',
            allowedModels: ['nimble'],
            timeoutMs: 30_000,
            keepAlive: undefined,
        });
    });

    it('uses OLLAMA_API_URL by default and lets SYS1_OLLAMA_BASE_URL override it', () => {
        process.env.OLLAMA_API_URL = 'http://shared:11434/';
        expect(getSystemOneConfig().ollamaBaseUrl).toBe('http://shared:11434');

        _resetSystemOneConfigCache();
        process.env.SYS1_OLLAMA_BASE_URL = 'http://sys1:11434';
        expect(getSystemOneConfig().ollamaBaseUrl).toBe('http://sys1:11434');
    });

    it('always allows SYS1_MODEL and dedupes the allowlist', () => {
        process.env.SYS1_MODEL = 'tev1';
        process.env.SYS1_ALLOWED_MODELS = ' clef-flash , tev1,,nimble ';
        expect(getSystemOneConfig()).toMatchObject({
            defaultModel: 'tev1',
            allowedModels: ['tev1', 'clef-flash', 'nimble'],
        });
    });

    it('normalises SYS1_PROVIDER', () => {
        process.env.SYS1_PROVIDER = ' Ollama ';
        expect(getSystemOneConfig().provider).toBe('ollama');
    });

    it.each([
        ['300', 300],
        ['-1', -1],
        ['0', 0],
        ['5m', '5m'],
        ['  ', undefined],
    ])('parses SYS1_KEEP_ALIVE=%j as %j', (raw, expected) => {
        process.env.SYS1_KEEP_ALIVE = raw;
        expect(getSystemOneConfig().keepAlive).toBe(expected);
    });

    it('parses SYS1_TIMEOUT_MS and rejects a non-positive or non-integer value', () => {
        process.env.SYS1_TIMEOUT_MS = '1500';
        expect(getSystemOneConfig().timeoutMs).toBe(1500);

        for (const bad of ['abc', '0', '-5', '1.5']) {
            _resetSystemOneConfigCache();
            process.env.SYS1_TIMEOUT_MS = bad;
            expect(() => getSystemOneConfig()).toThrow(/SYS1_TIMEOUT_MS/);
        }
    });

    it('memoises until reset', () => {
        expect(getSystemOneConfig().defaultModel).toBe('nimble');
        process.env.SYS1_MODEL = 'tev1';
        expect(getSystemOneConfig().defaultModel).toBe('nimble');
        _resetSystemOneConfigCache();
        expect(getSystemOneConfig().defaultModel).toBe('tev1');
    });
});

describe('system-one.config — visionModels', () => {
    it('picks the Clef family, with or without a namespace or tag', () => {
        expect(visionModels(['nimble', 'clef-flash', 'library/clef:latest', 'tev1'])).toEqual([
            'clef-flash',
            'library/clef:latest',
        ]);
    });
});
