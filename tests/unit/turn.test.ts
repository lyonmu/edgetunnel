import { describe, expect, it } from 'vitest';
import {
  createTurnStunAttribute,
  createTurnStunMessage,
  parseTurnErrorCode,
} from '../../src/networking/turn';

describe('TURN/STUN wire helpers', () => {
  it('pads attributes to a four-byte boundary', () => {
    const attribute = createTurnStunAttribute(0x0014, new Uint8Array([1, 2, 3]));

    expect(attribute).toEqual(new Uint8Array([0, 0x14, 0, 3, 1, 2, 3, 0]));
  });

  it('creates a message with the STUN cookie and transaction id', () => {
    const transactionId = new Uint8Array(12).fill(7);
    const attribute = createTurnStunAttribute(0x0019, new Uint8Array([6, 0, 0, 0]));
    const message = createTurnStunMessage(0x0003, transactionId, [attribute]);

    expect(message.slice(0, 8)).toEqual(new Uint8Array([0, 3, 0, 8, 0x21, 0x12, 0xa4, 0x42]));
    expect(message.slice(8, 20)).toEqual(transactionId);
    expect(message.slice(20)).toEqual(attribute);
  });

  it('parses a STUN error code attribute', () => {
    expect(parseTurnErrorCode(new Uint8Array([0, 0, 4, 1]))).toBe(401);
    expect(parseTurnErrorCode(undefined)).toBe(0);
  });
});
