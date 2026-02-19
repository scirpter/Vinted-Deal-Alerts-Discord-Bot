import { err, ok, type Result } from 'neverthrow';

export type VintedRegion =
  | 'de'
  | 'at'
  | 'fr'
  | 'it'
  | 'es'
  | 'nl'
  | 'pl'
  | 'cz'
  | 'pt';

const REGION_TO_BASE_URL: Record<VintedRegion, string> = {
  de: 'https://www.vinted.de',
  at: 'https://www.vinted.at',
  fr: 'https://www.vinted.fr',
  it: 'https://www.vinted.it',
  es: 'https://www.vinted.es',
  nl: 'https://www.vinted.nl',
  pl: 'https://www.vinted.pl',
  cz: 'https://www.vinted.cz',
  pt: 'https://www.vinted.pt',
};

export function isVintedRegion(value: string): value is VintedRegion {
  return Object.hasOwn(REGION_TO_BASE_URL, value);
}

export function baseUrlForRegion(region: VintedRegion): string {
  return REGION_TO_BASE_URL[region];
}

export function parseRegion(region: string): Result<VintedRegion, Error> {
  if (!isVintedRegion(region)) {
    return err(new Error('Nicht unterstützte Region.'));
  }
  return ok(region);
}
