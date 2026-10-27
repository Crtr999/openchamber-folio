import { describe, expect, test } from 'bun:test';
import { WEBSITE_SIDEBAR_IDS, isWebsiteSidebarId, mergeSidebarItemOrder } from './sidebarItemOrder';

describe('mergeSidebarItemOrder', () => {
  test('an empty or missing saved order keeps projects, then the website rows', () => {
    expect(mergeSidebarItemOrder(['project-a', 'project-b'], [])).toEqual(['project-a', 'project-b', ...WEBSITE_SIDEBAR_IDS]);
    expect(mergeSidebarItemOrder(['project-a'], undefined)).toEqual(['project-a', ...WEBSITE_SIDEBAR_IDS]);
  });

  test('keeps a saved mix, drops unknown ids, and appends missing projects then websites', () => {
    expect(mergeSidebarItemOrder(
      ['project-a', 'project-b', 'project-c'],
      ['project-b', 'website:chatgpt', 'gone', 'project-a', 'website:chatgpt'],
    )).toEqual([
      'project-b',
      'website:chatgpt',
      'project-a',
      'project-c',
      'website:claude',
      'website:venice',
      'website:gemini',
    ]);
  });

  test('recognizes only the four website sidebar ids', () => {
    expect(isWebsiteSidebarId('website:claude')).toBe(true);
    expect(isWebsiteSidebarId('project-a')).toBe(false);
  });
});
