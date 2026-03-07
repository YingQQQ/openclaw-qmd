import { describe, it, expect } from 'vitest';
import {
  isNoise,
  isDenial,
  isMetaQuestion,
  isBoilerplate,
  filterNoise,
} from '../src/noise-filter.js';

describe('isDenial', () => {
  it('detects English denial', () => {
    expect(isDenial("I'm sorry, I can't do that")).toBe(true);
  });

  it('detects Chinese denial', () => {
    expect(isDenial('抱歉我无法完成')).toBe(true);
  });

  it('does not flag normal text', () => {
    expect(isDenial('I prefer using TypeScript')).toBe(false);
  });
});

describe('isMetaQuestion', () => {
  it('detects "你是谁"', () => {
    expect(isMetaQuestion('你是谁')).toBe(true);
  });

  it('detects "who are you"', () => {
    expect(isMetaQuestion('who are you')).toBe(true);
  });

  it('does not flag normal questions', () => {
    expect(isMetaQuestion('how do I use git?')).toBe(false);
  });
});

describe('isBoilerplate', () => {
  it('detects "好的"', () => {
    expect(isBoilerplate('好的')).toBe(true);
  });

  it('detects "谢谢"', () => {
    expect(isBoilerplate('谢谢')).toBe(true);
  });

  it('detects "ok"', () => {
    expect(isBoilerplate('ok')).toBe(true);
  });

  it('does not flag meaningful text', () => {
    expect(isBoilerplate('I prefer using TypeScript for this project')).toBe(false);
  });
});

describe('isNoise', () => {
  it('flags denial as noise', () => {
    expect(isNoise("I'm sorry, I can't do that")).toBe(true);
  });

  it('flags meta question as noise', () => {
    expect(isNoise('你是谁')).toBe(true);
  });

  it('flags boilerplate as noise', () => {
    expect(isNoise('好的')).toBe(true);
  });

  it('flags "谢谢" as noise', () => {
    expect(isNoise('谢谢')).toBe(true);
  });

  it('does not flag meaningful content', () => {
    expect(isNoise('I prefer using TypeScript for this project')).toBe(false);
  });
});

describe('filterNoise', () => {
  it('filters out noise and keeps meaningful text', () => {
    const input = ['好的', '我喜欢用 vim', '收到'];
    expect(filterNoise(input)).toEqual(['我喜欢用 vim']);
  });

  it('returns empty array when all are noise', () => {
    expect(filterNoise(['ok', '谢谢', '好的'])).toEqual([]);
  });

  it('does not modify the input array', () => {
    const input = ['好的', '有价值的内容'];
    const copy = [...input];
    filterNoise(input);
    expect(input).toEqual(copy);
  });
});
