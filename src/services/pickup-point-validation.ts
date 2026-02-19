import { err, ok, type Result } from 'neverthrow';

const COORDINATE_PART_PATTERN = /^[+-]?\d{1,3}(?:\.\d+)?$/;

export function normalizePickupPoint(input: string): string {
  const trimmed = input.trim();
  const parts = trimmed.split(',');
  if (parts.length !== 2) return trimmed;
  return `${parts[0]!.trim()},${parts[1]!.trim()}`;
}

export function validatePickupPoint(input: string): Result<string, Error> {
  const normalized = normalizePickupPoint(input);
  if (!normalized) {
    return err(new Error('Koordinaten dürfen nicht leer sein.'));
  }

  const parts = normalized.split(',');
  if (parts.length !== 2) {
    return err(
      new Error(
        'Ungültige Koordinaten. Verwende das Format `latitude,longitude` (z. B. `52.520008,13.404954`).',
      ),
    );
  }

  const [latitudeRaw, longitudeRaw] = parts;
  if (!latitudeRaw || !longitudeRaw) {
    return err(
      new Error(
        'Ungültige Koordinaten. Verwende das Format `latitude,longitude` (z. B. `52.520008,13.404954`).',
      ),
    );
  }

  if (!COORDINATE_PART_PATTERN.test(latitudeRaw) || !COORDINATE_PART_PATTERN.test(longitudeRaw)) {
    return err(
      new Error(
        'Ungültige Koordinaten. Erlaubt sind Dezimalzahlen mit Punkt im Format `latitude,longitude`.',
      ),
    );
  }

  const latitude = Number.parseFloat(latitudeRaw);
  const longitude = Number.parseFloat(longitudeRaw);
  if (!Number.isFinite(latitude) || latitude < -90 || latitude > 90) {
    return err(new Error('Latitude muss zwischen -90 und 90 liegen.'));
  }

  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    return err(new Error('Longitude muss zwischen -180 und 180 liegen.'));
  }

  return ok(`${latitudeRaw},${longitudeRaw}`);
}
