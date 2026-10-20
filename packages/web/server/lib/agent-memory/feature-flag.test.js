import { afterEach, describe, expect, test } from 'bun:test';

import { isAgentMemoryFeatureAvailable, isMemoryToolEnabledBySettings } from './feature-flag.js';

const original = process.env.OPENCHAMBER_MEMORY_ENABLE;

afterEach(() => {
  if (original === undefined) delete process.env.OPENCHAMBER_MEMORY_ENABLE;
  else process.env.OPENCHAMBER_MEMORY_ENABLE = original;
});

describe('the feature gate', () => {
  test('is open when the variable is unset, because this build ships it on', () => {
    delete process.env.OPENCHAMBER_MEMORY_ENABLE;
    expect(isAgentMemoryFeatureAvailable()).toBe(true);
  });

  test('opens for the usual truthy spellings', () => {
    for (const value of ['1', 'true', 'TRUE', 'yes', 'on', ' true ']) {
      process.env.OPENCHAMBER_MEMORY_ENABLE = value;
      expect(isAgentMemoryFeatureAvailable()).toBe(true);
    }
  });

  test('closes for the usual falsy spellings', () => {
    for (const value of ['0', 'false', 'no', 'off', ' FALSE ']) {
      process.env.OPENCHAMBER_MEMORY_ENABLE = value;
      expect(isAgentMemoryFeatureAvailable()).toBe(false);
    }
  });

  test('is read per call, so a process started with it set is what decides', () => {
    delete process.env.OPENCHAMBER_MEMORY_ENABLE;
    expect(isAgentMemoryFeatureAvailable()).toBe(true);
    process.env.OPENCHAMBER_MEMORY_ENABLE = '0';
    expect(isAgentMemoryFeatureAvailable()).toBe(false);
  });
});

describe('the stored setting', () => {
  test('is on when the setting is absent', () => {
    expect(isMemoryToolEnabledBySettings(undefined)).toBe(true);
    expect(isMemoryToolEnabledBySettings(null)).toBe(true);
    expect(isMemoryToolEnabledBySettings({})).toBe(true);
  });

  test('is on when the setting says true', () => {
    expect(isMemoryToolEnabledBySettings({ agentMemoryToolEnabled: true })).toBe(true);
  });

  test('is off only when the setting explicitly says false', () => {
    expect(isMemoryToolEnabledBySettings({ agentMemoryToolEnabled: false })).toBe(false);
  });
});
