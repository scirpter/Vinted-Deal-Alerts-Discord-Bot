import { describe, expect, it } from 'vitest';
import { normalizePickupPoint, validatePickupPoint } from '../services/pickup-point-validation.js';

describe('pickup-point-validation', () => {
  it('normalizes and accepts valid coordinate pairs', () => {
    expect(normalizePickupPoint('  52.520008, 13.404954  ')).toBe('52.520008,13.404954');

    const res = validatePickupPoint('  -33.8688,151.2093  ');
    expect(res.isOk()).toBe(true);
    if (res.isErr()) return;
    expect(res.value).toBe('-33.8688,151.2093');
  });

  it('rejects free text, pickup ids, and malformed coordinate values', () => {
    expect(validatePickupPoint('mein abholpunkt').isErr()).toBe(true);
    expect(validatePickupPoint('pickup-123').isErr()).toBe(true);
    expect(validatePickupPoint('geo:52.5,13.4').isErr()).toBe(true);
    expect(validatePickupPoint('52,13,5').isErr()).toBe(true);
    expect(validatePickupPoint('52.5;13.4').isErr()).toBe(true);
  });

  it('rejects out-of-range coordinates', () => {
    expect(validatePickupPoint('91,10').isErr()).toBe(true);
    expect(validatePickupPoint('-90.0001,10').isErr()).toBe(true);
    expect(validatePickupPoint('52.5,181').isErr()).toBe(true);
    expect(validatePickupPoint('52.5,-180.0001').isErr()).toBe(true);
  });
});
