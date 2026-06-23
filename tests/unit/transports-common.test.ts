import { describe, expect, it } from 'vitest';
import { decodeEarlyData, isValidWSEarlyData, buildGrpcFrame, parseGrpcFrames } from '../../src/transports/common';

describe('decodeEarlyData', () => {
  it('decodes valid base64url', () => {
    const input = btoa(String.fromCharCode(0x01, 0x02, 0x03)).replace(/\+/g, '-').replace(/\//g, '_');
    const result = decodeEarlyData(input, null);
    expect(result).not.toBeNull();
    expect(result!.byteLength).toBe(3);
  });

  it('returns null for invalid base64', () => {
    expect(decodeEarlyData('!!!invalid!!!', null)).toBeNull();
  });

  it('returns null for empty string', () => {
    expect(decodeEarlyData('', null)).toBeNull();
  });
});

describe('buildGrpcFrame', () => {
  it('builds a gRPC frame with correct structure', () => {
    const payload = new Uint8Array([1, 2, 3]);
    const frame = buildGrpcFrame(payload);
    // gRPC length prefix: bytes 0-3 = 0, byte 4 = protobufLen
    expect(frame[0]).toBe(0);
    // protobufLen = 1 (tag 0x0a) + 1 (varint 3) + 3 (payload) = 5
    const protobufLen = ((frame[1] << 24) >>> 0) | (frame[2] << 16) | (frame[3] << 8) | frame[4];
    expect(protobufLen).toBe(5);
    // protobuf field tag
    expect(frame[5]).toBe(0x0a);
    // varint length
    expect(frame[6]).toBe(3);
    // payload
    expect(frame[7]).toBe(1);
    expect(frame[8]).toBe(2);
    expect(frame[9]).toBe(3);
  });
});

describe('parseGrpcFrames', () => {
  it('parses a single gRPC frame', () => {
    const payload = new Uint8Array([0x0a, 0x02, 0xaa, 0xbb]);
    const grpcLen = payload.length;
    const frame = new Uint8Array([
      0, (grpcLen >>> 24) & 0xff, (grpcLen >>> 16) & 0xff, (grpcLen >>> 8) & 0xff, grpcLen & 0xff,
      ...payload,
    ]);
    const { frames, remainder } = parseGrpcFrames(frame);
    expect(frames.length).toBe(1);
    expect(frames[0]).toEqual(payload);
    expect(remainder.byteLength).toBe(0);
  });

  it('returns incomplete frame as remainder', () => {
    const incomplete = new Uint8Array([0, 0, 0, 0, 10, 0x0a, 0x02]);
    const { frames, remainder } = parseGrpcFrames(incomplete);
    expect(frames.length).toBe(0);
    expect(remainder).toEqual(incomplete);
  });

  it('parses multiple frames', () => {
    const p1 = new Uint8Array([0x0a, 0x01, 0x11]);
    const p2 = new Uint8Array([0x0a, 0x01, 0x22]);
    const f1 = new Uint8Array([0, 0, 0, 0, p1.length, ...p1]);
    const f2 = new Uint8Array([0, 0, 0, 0, p2.length, ...p2]);
    const combined = new Uint8Array([...f1, ...f2]);
    const { frames, remainder } = parseGrpcFrames(combined);
    expect(frames.length).toBe(2);
    expect(frames[0]).toEqual(p1);
    expect(frames[1]).toEqual(p2);
    expect(remainder.byteLength).toBe(0);
  });
});
