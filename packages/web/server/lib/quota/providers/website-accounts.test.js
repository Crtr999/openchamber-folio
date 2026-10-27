import { expect, test, vi } from 'vitest';

vi.mock('../../website-models/usage-bridge.js', () => ({
  websiteUsageAvailable: () => true,
  requestWebsiteUsage: async () => ({ limits: [{ label: 'Chat', remaining: 4, resetText: '10:38 PM' }, { label: 'Image', remaining: 3, resetText: 'Oct 28 at 4:17 PM' }, { label: 'Web Scrape', remaining: 15, resetText: null }], balance: '\$0.00' }),
}));

import { parseResetText, venice } from './website-accounts.js';

const now = new Date(2026, 9, 27, 15, 40);
test('a clock-only reset is the next time it occurs', () => {
  expect(new Date(parseResetText('at 5:07 PM', now))).toEqual(new Date(2026, 9, 27, 17, 7));
  expect(new Date(parseResetText('10:38 PM', now))).toEqual(new Date(2026, 9, 27, 22, 38));
  expect(new Date(parseResetText('3:00 PM', now))).toEqual(new Date(2026, 9, 28, 15, 0));
});
test('a dated reset reads the month and day', () => {
  expect(new Date(parseResetText('Oct 29 at 5:07 PM', now))).toEqual(new Date(2026, 9, 29, 17, 7));
  expect(new Date(parseResetText('Jan 2 at 9:00 AM', now))).toEqual(new Date(2027, 0, 2, 9, 0));
  expect(parseResetText('soon', now)).toBeNull();
});

test('venice chats and images become rings out of their allowances', async () => {
  const { usage } = await venice.fetchQuota();
  expect(usage.windows.Chat.usedPercent).toBe(60);
  expect(usage.windows.Chat.valueLabel).toContain('4/10 left');
  expect(usage.windows.Image.usedPercent).toBe(80);
  expect(usage.windows['Web Scrape'].usedPercent).toBeNull();
});
