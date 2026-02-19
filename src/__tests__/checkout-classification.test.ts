import { describe, expect, it } from 'vitest';
import { classifyCheckoutErrorMessage } from '../services/checkout-classification.js';

describe('classifyCheckoutErrorMessage', () => {
  it('classifies access denied responses', () => {
    const denied = classifyCheckoutErrorMessage(
      'Vinted request failed (403). {"code":106,"message":"Accès refusé ","message_code":"access_denied"}',
    );
    expect(denied).toBe('access_denied');
  });

  it('classifies blocked responses', () => {
    const blocked = classifyCheckoutErrorMessage(
      'Vinted hat die Anfrage blockiert (Anti-Bot/Cloudflare). Bitte warte kurz.',
    );
    expect(blocked).toBe('blocked');
  });

  it('classifies invalid pickup point responses', () => {
    const invalid = classifyCheckoutErrorMessage(
      'Vinted request failed (422). pickup_point is not valid for this listing.',
    );
    expect(invalid).toBe('invalid_pickup_point');
  });

  it('classifies unknown checkout errors as failed', () => {
    const failed = classifyCheckoutErrorMessage('Vinted request failed (500). Internal server error');
    expect(failed).toBe('failed');
  });
});
