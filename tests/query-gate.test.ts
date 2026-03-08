import { describe, it, expect } from 'vitest';
import { canSkipLookup, mustLookup } from '../src/query-gate.js';

describe('canSkipLookup', () => {
  it('skips greetings like "你好"', () => {
    expect(canSkipLookup('你好')).toBe(true);
  });

  it('does not treat slash-prefixed input as an automatic skip', () => {
    expect(canSkipLookup('/help me remember the deploy issue')).toBe(false);
  });

  it('skips affirmatives like "ok"', () => {
    expect(canSkipLookup('ok')).toBe(true);
  });

  it('skips pure emoji strings', () => {
    expect(canSkipLookup('🎉🎉')).toBe(true);
  });

  it('does not skip meaningful CJK text (>= 6 chars)', () => {
    expect(canSkipLookup('帮我看下这个代码')).toBe(false);
  });

  it('skips short latin text like "hi"', () => {
    expect(canSkipLookup('hi')).toBe(true);
  });

  it('skips latin text shorter than 15 characters like "abc"', () => {
    expect(canSkipLookup('abc')).toBe(true);
  });

  it('does not skip long enough latin text', () => {
    expect(canSkipLookup('write a function that sums two numbers')).toBe(false);
  });

  it('skips heartbeat pings', () => {
    expect(canSkipLookup('ping')).toBe(true);
  });

  it('respects custom minLength parameter', () => {
    expect(canSkipLookup('short', 3)).toBe(false);
    expect(canSkipLookup('ab', 3)).toBe(true);
  });
});

describe('mustLookup', () => {
  it('forces retrieval for Chinese memory references', () => {
    expect(mustLookup('记得之前讨论的 auth 方案吗')).toBe(true);
  });

  it('forces retrieval for English memory references', () => {
    expect(mustLookup('do you remember the API key')).toBe(true);
  });

  it('does not force retrieval for generic requests', () => {
    expect(mustLookup('write a function')).toBe(false);
  });

  it('forces retrieval when user says "之前"', () => {
    expect(mustLookup('之前说过的那个方案')).toBe(true);
  });

  it('forces retrieval when user says "i told you"', () => {
    expect(mustLookup('i told you about the config')).toBe(true);
  });
});
