import { describe, it, expect } from 'vitest';
import {
  isLowQuality,
  isRefusal,
  isIntrospective,
  isGenericOutput,
  filterLowQuality,
} from '../src/content-guard.js';

describe('isRefusal', () => {
  it('detects English denial', () => {
    expect(isRefusal("I'm sorry, I can't do that")).toBe(true);
  });

  it('detects Chinese denial', () => {
    expect(isRefusal('抱歉我无法完成')).toBe(true);
  });

  it('does not flag normal text', () => {
    expect(isRefusal('I prefer using TypeScript')).toBe(false);
  });
});

describe('isIntrospective', () => {
  it('detects "你是谁"', () => {
    expect(isIntrospective('你是谁')).toBe(true);
  });

  it('detects "who are you"', () => {
    expect(isIntrospective('who are you')).toBe(true);
  });

  it('does not flag normal questions', () => {
    expect(isIntrospective('how do I use git?')).toBe(false);
  });
});

describe('isGenericOutput', () => {
  it('detects "好的"', () => {
    expect(isGenericOutput('好的')).toBe(true);
  });

  it('detects "谢谢"', () => {
    expect(isGenericOutput('谢谢')).toBe(true);
  });

  it('detects "ok"', () => {
    expect(isGenericOutput('ok')).toBe(true);
  });

  it('does not flag meaningful text', () => {
    expect(isGenericOutput('I prefer using TypeScript for this project')).toBe(false);
  });
});

describe('isLowQuality', () => {
  it('flags denial as noise', () => {
    expect(isLowQuality("I'm sorry, I can't do that")).toBe(true);
  });

  it('flags meta question as noise', () => {
    expect(isLowQuality('你是谁')).toBe(true);
  });

  it('flags boilerplate as noise', () => {
    expect(isLowQuality('好的')).toBe(true);
  });

  it('flags "谢谢" as noise', () => {
    expect(isLowQuality('谢谢')).toBe(true);
  });

  it('does not flag meaningful content', () => {
    expect(isLowQuality('I prefer using TypeScript for this project')).toBe(false);
  });
});

describe('filterLowQuality', () => {
  it('filters out noise and keeps meaningful text', () => {
    const input = ['好的', '我喜欢用 vim', '收到'];
    expect(filterLowQuality(input)).toEqual(['我喜欢用 vim']);
  });

  it('returns empty array when all are noise', () => {
    expect(filterLowQuality(['ok', '谢谢', '好的'])).toEqual([]);
  });

  it('does not modify the input array', () => {
    const input = ['好的', '有价值的内容'];
    const copy = [...input];
    filterLowQuality(input);
    expect(input).toEqual(copy);
  });
});
