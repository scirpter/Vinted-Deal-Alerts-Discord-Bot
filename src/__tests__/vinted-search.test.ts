import { describe, expect, it } from 'vitest';
import { parseVintedSearchUrl } from '../services/vinted-search.js';

describe('parseVintedSearchUrl', () => {
  it('accepts a vinted URL and suggests label/channel', () => {
    const res = parseVintedSearchUrl({
      searchUrl: 'https://www.vinted.de/catalog?search_text=nike&price_from=10',
    });
    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;
    expect(res.value.suggestedLabel).toContain('nike');
    expect(res.value.suggestedChannelName).toContain('nike');
  });

  it('rejects non-vinted URLs', () => {
    const res = parseVintedSearchUrl({ searchUrl: 'https://example.com' });
    expect(res.isErr()).toBe(true);
  });
});

