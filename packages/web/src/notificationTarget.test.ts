import { describe, expect, it } from 'vitest';
import { notificationTarget } from './notificationTarget';
describe('notification navigation', () => {
  it('retains the mobile renderer and exact session query', () => {
    expect(notificationTarget('/?session=ses_123&dir=%2Fworkspace', 'https://carter.example', 'https://carter.example/mobile.html')).toBe('https://carter.example/mobile.html?session=ses_123&dir=%2Fworkspace');
  });
  it('rejects third-party and script destinations', () => {
    for (const raw of ['https://evil.example/', '//evil.example/', 'javascript:alert(1)']) {
      expect(notificationTarget(raw, 'https://carter.example')).toBe('https://carter.example/');
    }
  });
  it('does not force desktop windows into the mobile renderer', () => {
    expect(notificationTarget('/?session=ses_123', 'https://carter.example', 'https://carter.example/')).toBe('https://carter.example/?session=ses_123');
  });
});
