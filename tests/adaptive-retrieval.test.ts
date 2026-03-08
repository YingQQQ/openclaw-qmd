import { describe, it, expect } from 'vitest';
import { shouldSkipRetrieval, shouldForceRetrieve } from '../src/adaptive-retrieval.js';

describe('shouldSkipRetrieval', () => {
  it('skips greetings like "你好"', () => {
    expect(shouldSkipRetrieval('你好')).toBe(true);
  });

  it('does not treat slash-prefixed input as an automatic skip', () => {
    expect(shouldSkipRetrieval('/help me remember the deploy issue')).toBe(false);
  });

  it('skips affirmatives like "ok"', () => {
    expect(shouldSkipRetrieval('ok')).toBe(true);
  });

  it('skips pure emoji strings', () => {
    expect(shouldSkipRetrieval('🎉🎉')).toBe(true);
  });

  it('does not skip meaningful CJK text (>= 6 chars)', () => {
    expect(shouldSkipRetrieval('帮我看下这个代码')).toBe(false);
  });

  it('skips short latin text like "hi"', () => {
    expect(shouldSkipRetrieval('hi')).toBe(true);
  });

  it('skips latin text shorter than 15 characters like "abc"', () => {
    expect(shouldSkipRetrieval('abc')).toBe(true);
  });

  it('does not skip long enough latin text', () => {
    expect(shouldSkipRetrieval('write a function that sums two numbers')).toBe(false);
  });

  it('skips heartbeat pings', () => {
    expect(shouldSkipRetrieval('ping')).toBe(true);
  });

  it('respects custom minLength parameter', () => {
    expect(shouldSkipRetrieval('short', 3)).toBe(false);
    expect(shouldSkipRetrieval('ab', 3)).toBe(true);
  });
});

describe('shouldForceRetrieve', () => {
  it('forces retrieval for Chinese memory references', () => {
    expect(shouldForceRetrieve('记得之前讨论的 auth 方案吗')).toBe(true);
  });

  it('forces retrieval for English memory references', () => {
    expect(shouldForceRetrieve('do you remember the API key')).toBe(true);
  });

  it('does not force retrieval for generic requests', () => {
    expect(shouldForceRetrieve('write a function')).toBe(false);
  });

  it('forces retrieval when user says "之前"', () => {
    expect(shouldForceRetrieve('之前说过的那个方案')).toBe(true);
  });

  it('forces retrieval when user says "i told you"', () => {
    expect(shouldForceRetrieve('i told you about the config')).toBe(true);
  });
});
