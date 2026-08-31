import { describe, expect, it } from 'vitest';
import { buildSocialLinks, readSocialLinks, safeExternalUrl, socialLabel } from '@/lib/profileOptions';

describe('profile options', () => {
  it('migrates legacy Twitter links to X', () => {
    expect(readSocialLinks({ twitter: 'https://twitter.com/cirkle' }).fixed.x).toBe('https://twitter.com/cirkle');
    expect(socialLabel('twitter')).toBe('X');
  });

  it('stores safe custom links with their user-provided labels', () => {
    const links = buildSocialLinks({ website: 'cirkle.world' }, [{ id: '1', label: 'Portfolio', url: 'example.com/me' }]);
    expect(links.website).toBe('https://cirkle.world/');
    expect(links['custom:Portfolio']).toBe('https://example.com/me');
  });

  it('rejects non-http link protocols', () => {
    expect(() => safeExternalUrl('javascript:alert(1)')).toThrow();
  });
});
