import { describe, expect, it } from 'vitest';
import { readSettings } from '../src/settings.js';

describe('readSettings', () => {
  it('reads the new names', () => {
    expect(readSettings({ HONEYTAR_URL: 'https://x.example/fn', HONEYTAR_SECRET: 's'.repeat(20), HONEYTAR_TARPIT_MS: '30000' })).toEqual({ url: 'https://x.example/fn', secret: 's'.repeat(20), tarpitMs: '30000' });
  });
  it('still accepts the older names, so an existing deployment keeps working', () => {
    expect(readSettings({ HONEYPOT_URL: 'https://old.example/fn', HONEYPOT_SECRET: 'o'.repeat(20), TARPIT_MS: '5000' })).toEqual({ url: 'https://old.example/fn', secret: 'o'.repeat(20), tarpitMs: '5000' });
  });
  it('prefers the new name, and treats an empty value as unset', () => {
    expect(readSettings({ HONEYTAR_URL: 'https://new.example', HONEYPOT_URL: 'https://old.example' }).url).toBe('https://new.example');
    expect(readSettings({ HONEYTAR_URL: '  ', HONEYPOT_URL: 'https://old.example' }).url).toBe('https://old.example');
    expect(readSettings({})).toEqual({ url: undefined, secret: undefined, tarpitMs: undefined });
  });
});
