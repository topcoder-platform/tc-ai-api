import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
    _resetLetsTalkClassificationConfigCache,
    DEFAULT_LETS_TALK_CLASSES,
    DISPOSABLE_MAIL_DOMAINS,
    FREE_MAIL_DOMAINS,
    getLetsTalkClassificationConfig,
    isDomainListed,
} from './lets-talk-classification.config';

const ENV_KEYS = [
    'LETS_TALK_CLASSES_JSON',
    'LETS_TALK_MAX_MESSAGE_CHARS',
    'LETS_TALK_MIN_CONFIDENCE',
    'LETS_TALK_CLASSIFIER_MAX_RETRIES',
    'LETS_TALK_CLASSIFIER_MAX_PROCESSOR_RETRIES',
    'LETS_TALK_CLASSIFY_MAX_ATTEMPTS',
    'LETS_TALK_CLASSIFIER_MAX_OUTPUT_TOKENS',
];

describe('lets-talk-classification.config — getLetsTalkClassificationConfig', () => {
    let savedEnv: Record<string, string | undefined>;

    beforeEach(() => {
        savedEnv = {};
        for (const key of ENV_KEYS) {
            savedEnv[key] = process.env[key];
            delete process.env[key];
        }
        _resetLetsTalkClassificationConfigCache();
    });

    afterEach(() => {
        for (const key of ENV_KEYS) {
            if (savedEnv[key] === undefined) delete process.env[key];
            else process.env[key] = savedEnv[key];
        }
        _resetLetsTalkClassificationConfigCache();
    });

    it('returns the defaults with an empty environment, without throwing', () => {
        const config = getLetsTalkClassificationConfig();
        expect(config.classIds).toEqual([
            'JUNK',
            'COMMUNITY_OPPORTUNITY',
            'COMMUNITY_SKILLS',
            'COMMUNITY_SUPPORT',
            'COMMUNITY_GENERAL',
            'WIPRO_QUERIES',
            'SALES_LEAD',
        ]);
        expect(config.classes).toEqual(DEFAULT_LETS_TALK_CLASSES);
        expect(config).toMatchObject({
            maxMessageChars: 5000,
            minConfidence: 0.5,
            maxTransportRetries: 2,
            maxProcessorRetries: 2,
            maxAttempts: 2,
            maxOutputTokens: 1024,
        });
    });

    it('overrides the class set with a valid LETS_TALK_CLASSES_JSON', () => {
        process.env.LETS_TALK_CLASSES_JSON = JSON.stringify([
            { id: 'SPAM', description: 'Unwanted.' },
            { id: 'PARTNER_INQUIRY', description: 'Wants to partner.', examples: ['"Let us co-market."'] },
        ]);
        const config = getLetsTalkClassificationConfig();
        expect(config.classIds).toEqual(['SPAM', 'PARTNER_INQUIRY']);
        expect(config.classes[1].examples).toEqual(['"Let us co-market."']);
    });

    it('accepts the defaults themselves as LETS_TALK_CLASSES_JSON — the starting point for a custom set', () => {
        process.env.LETS_TALK_CLASSES_JSON = JSON.stringify(DEFAULT_LETS_TALK_CLASSES);
        expect(getLetsTalkClassificationConfig().classes).toEqual(DEFAULT_LETS_TALK_CLASSES);
    });

    it.each([
        ['not JSON', '{oops', /not valid JSON/],
        ['duplicate ids', JSON.stringify([{ id: 'A', description: 'x' }, { id: 'A', description: 'y' }]), /duplicate class id "A"/],
        ['a lowercase id', JSON.stringify([{ id: 'junk', description: 'x' }, { id: 'B', description: 'y' }]), /UPPER_SNAKE_CASE/],
        ['too few classes', JSON.stringify([{ id: 'A', description: 'x' }]), /LETS_TALK_CLASSES_JSON/],
        [
            'too many classes',
            JSON.stringify(Array.from({ length: 21 }, (_, i) => ({ id: `C${i}`, description: 'x' }))),
            /LETS_TALK_CLASSES_JSON/,
        ],
        ['an empty description', JSON.stringify([{ id: 'A', description: ' ' }, { id: 'B', description: 'y' }]), /0\.description/],
        ['an unknown key', JSON.stringify([{ id: 'A', description: 'x', colour: 'red' }, { id: 'B', description: 'y' }]), /LETS_TALK_CLASSES_JSON/],
        ['a non-array', JSON.stringify({ id: 'A' }), /LETS_TALK_CLASSES_JSON/],
    ])('fails fast on %s', (_label, value, message) => {
        process.env.LETS_TALK_CLASSES_JSON = value;
        expect(() => getLetsTalkClassificationConfig()).toThrow(message);
    });

    it('parses the numeric knobs and rejects malformed values', () => {
        process.env.LETS_TALK_MAX_MESSAGE_CHARS = '2000';
        process.env.LETS_TALK_MIN_CONFIDENCE = '0.65';
        process.env.LETS_TALK_CLASSIFIER_MAX_PROCESSOR_RETRIES = '0';
        expect(getLetsTalkClassificationConfig()).toMatchObject({
            maxMessageChars: 2000,
            minConfidence: 0.65,
            maxProcessorRetries: 0,
        });

        for (const [key, bad] of [
            ['LETS_TALK_MAX_MESSAGE_CHARS', '0'],
            ['LETS_TALK_MAX_MESSAGE_CHARS', 'abc'],
            ['LETS_TALK_MIN_CONFIDENCE', '1.5'],
            ['LETS_TALK_CLASSIFY_MAX_ATTEMPTS', '0'],
            ['LETS_TALK_CLASSIFIER_MAX_RETRIES', '-1'],
        ] as const) {
            for (const k of ENV_KEYS) delete process.env[k];
            _resetLetsTalkClassificationConfigCache();
            process.env[key] = bad;
            expect(() => getLetsTalkClassificationConfig(), `${key}=${bad}`).toThrow(new RegExp(key));
        }
    });

    it('memoises until reset', () => {
        expect(getLetsTalkClassificationConfig().maxMessageChars).toBe(5000);
        process.env.LETS_TALK_MAX_MESSAGE_CHARS = '10';
        expect(getLetsTalkClassificationConfig().maxMessageChars).toBe(5000);
        _resetLetsTalkClassificationConfigCache();
        expect(getLetsTalkClassificationConfig().maxMessageChars).toBe(10);
    });
});

describe('lets-talk-classification.config — isDomainListed', () => {
    it('matches the domain and its parent domains, case-insensitively', () => {
        expect(isDomainListed('gmail.com', FREE_MAIL_DOMAINS)).toBe(true);
        expect(isDomainListed('GMAIL.COM', FREE_MAIL_DOMAINS)).toBe(true);
        expect(isDomainListed('eu.mailinator.com', DISPOSABLE_MAIL_DOMAINS)).toBe(true);
    });

    it('does not match look-alikes or bare TLDs', () => {
        expect(isDomainListed('notgmail.com', FREE_MAIL_DOMAINS)).toBe(false);
        expect(isDomainListed('acme.es', FREE_MAIL_DOMAINS)).toBe(false);
        expect(isDomainListed('com', FREE_MAIL_DOMAINS)).toBe(false);
    });
});
