import { describe, expect, it } from 'vitest';
import { XudpDecoder, encodeXudpDatagram, type XudpDatagram } from '../../src/networking/xudp';

const dnsDatagram: XudpDatagram = {
  status: 'new',
  destination: {
    hostname: '1.1.1.1',
    port: 53,
    addressType: 1,
    addressBytes: new Uint8Array([1, 1, 1, 1]),
  },
  globalId: new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]),
  payload: new Uint8Array([0xaa, 0xbb, 0xcc]),
};

describe('XUDP codec', () => {
  it('encodes the upstream Single XUDP New frame layout', () => {
    expect(encodeXudpDatagram(dnsDatagram)).toEqual(
      new Uint8Array([
        0,
        20, // metadata length
        0,
        0, // session ID
        1,
        1,
        2, // New, Opt(D), UDP
        0,
        53,
        1,
        1,
        1,
        1,
        1, // PortThenAddress
        1,
        2,
        3,
        4,
        5,
        6,
        7,
        8, // Global ID
        0,
        3,
        0xaa,
        0xbb,
        0xcc,
      ]),
    );
  });

  it('decodes frames split at every byte boundary', () => {
    const encoded = encodeXudpDatagram(dnsDatagram);

    for (let split = 1; split < encoded.byteLength; split += 1) {
      const decoder = new XudpDecoder();
      expect(decoder.push(encoded.slice(0, split))).toEqual([]);
      expect(decoder.push(encoded.slice(split))).toEqual([dnsDatagram]);
      decoder.finish();
    }
  });

  it('decodes multiple New and Keep frames in one chunk', () => {
    const keep: XudpDatagram = {
      ...dnsDatagram,
      status: 'keep',
      payload: new Uint8Array([9]),
    };
    delete keep.globalId;
    const combined = new Uint8Array([
      ...encodeXudpDatagram(dnsDatagram),
      ...encodeXudpDatagram(keep),
    ]);

    expect(new XudpDecoder().push(combined)).toEqual([dnsDatagram, keep]);
  });

  it('rejects non-UDP, nonzero session ID, oversized and truncated frames', () => {
    const encoded = encodeXudpDatagram(dnsDatagram);
    const nonUdp = new Uint8Array(encoded);
    nonUdp[6] = 1;
    const nonzeroId = new Uint8Array(encoded);
    nonzeroId[3] = 1;

    expect(() => new XudpDecoder().push(nonUdp)).toThrow(/UDP/);
    expect(() => new XudpDecoder().push(nonzeroId)).toThrow(/session/i);
    expect(() => new XudpDecoder(16).push(encoded)).toThrow(/上限/);
    const decoder = new XudpDecoder();
    decoder.push(encoded.slice(0, -1));
    expect(() => decoder.finish()).toThrow(/残缺/);
  });
});
