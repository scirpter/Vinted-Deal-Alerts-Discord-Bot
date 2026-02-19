import { err, ok, type Result } from 'neverthrow';

export function parseVintedSearchUrl(input: {
  searchUrl: string;
}): Result<{ suggestedLabel: string; suggestedChannelName: string }, Error> {
  let url: URL;
  try {
    url = new URL(input.searchUrl);
  } catch {
    return err(new Error('Ungültige Vinted-Such-URL.'));
  }

  if (!url.hostname.includes('vinted.')) {
    return err(new Error('Die Such-URL muss eine vinted.*-URL sein.'));
  }

  const searchText = url.searchParams.get('search_text')?.trim();
  const label = searchText ? `Vinted: ${searchText}` : 'Vinted-Abo';
  const channelName = searchText ? `vinted-${searchText}` : 'vinted-angebote';

  return ok({
    suggestedLabel: label.slice(0, 90),
    suggestedChannelName: channelName.slice(0, 90),
  });
}
