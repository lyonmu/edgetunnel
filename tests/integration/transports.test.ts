import { describe, expect, it, vi } from 'vitest';
import {
  createFirstPacketReader,
  createRemoteConnWrapper,
  createRemoteWriterProvider,
  createResponseBridge,
} from '../../src/transports/bridge';

describe('TransportBridge', () => {
  it('createResponseBridge enqueues data to controller', () => {
    const enqueued: Uint8Array[] = [];
    const controller = {
      enqueue: vi.fn((chunk: Uint8Array) => enqueued.push(chunk)),
      close: vi.fn(),
    } as any;
    const bridge = createResponseBridge(controller);
    expect(bridge.readyState).toBe(1); // WebSocket.OPEN
    bridge.send(new Uint8Array([1, 2, 3]));
    expect(enqueued.length).toBe(1);
    expect(enqueued[0]).toEqual(new Uint8Array([1, 2, 3]));
  });

  it('createResponseBridge close sets readyState', () => {
    const controller = { enqueue: vi.fn(), close: vi.fn() } as any;
    const bridge = createResponseBridge(controller);
    bridge.close();
    expect(bridge.readyState).toBe(3); // WebSocket.CLOSED
    expect(controller.close).toHaveBeenCalled();
  });

  it('createResponseBridge send after close does nothing', () => {
    const controller = { enqueue: vi.fn(), close: vi.fn() } as any;
    const bridge = createResponseBridge(controller);
    bridge.close();
    bridge.send(new Uint8Array([1]));
    expect(controller.enqueue).not.toHaveBeenCalled();
  });
});

describe('createRemoteConnWrapper', () => {
  it('creates empty wrapper', () => {
    const wrapper = createRemoteConnWrapper();
    expect(wrapper.socket).toBeNull();
    expect(wrapper.connectingPromise).toBeNull();
    expect(wrapper.retryConnect).toBeNull();
  });

  it('reuses one writer until the remote socket changes', () => {
    const wrapper = createRemoteConnWrapper();
    const firstWritable = new WritableStream<Uint8Array>();
    const secondWritable = new WritableStream<Uint8Array>();
    wrapper.socket = { writable: firstWritable } as Socket;
    const provider = createRemoteWriterProvider(wrapper);

    const first = provider.getWriter();
    const repeated = provider.getWriter();
    expect(repeated).toBe(first);
    expect(firstWritable.locked).toBe(true);

    wrapper.socket = { writable: secondWritable } as Socket;
    const second = provider.getWriter();
    expect(second).not.toBe(first);
    expect(firstWritable.locked).toBe(false);
    expect(secondWritable.locked).toBe(true);

    provider.releaseWriter();
    expect(secondWritable.locked).toBe(false);
  });
});

describe('createFirstPacketReader', () => {
  const uuid = '12345678-1234-4234-8234-123456789abc';

  it('waits for a fragmented Trojan first packet', () => {
    const hash = new TextEncoder().encode(
      '23b527d0e092cc9c57db3caf6b67ff9cf0f2391c16fe423c83456659',
    );
    const host = new TextEncoder().encode('example.com');
    const packet = new Uint8Array([
      ...hash,
      0x0d,
      0x0a,
      0x01,
      0x03,
      host.length,
      ...host,
      0x00,
      0x50,
      0x0d,
      0x0a,
      0x01,
    ]);
    const reader = createFirstPacketReader(uuid);

    expect(reader.push(packet.subarray(0, 32))).toEqual({ status: 'need_more' });
    expect(reader.push(packet.subarray(32, 61))).toEqual({ status: 'need_more' });

    const result = reader.push(packet.subarray(61));
    expect(result.status).toBe('ok');
    if (result.status === 'ok') {
      expect(result.packet.protocol).toBe('trojan');
      expect(result.packet.hostname).toBe('example.com');
      expect(result.packet.port).toBe(80);
      expect(result.packet.rawData).toEqual(new Uint8Array([1]));
    }
  });

  it('rejects an invalid accumulated first packet', () => {
    const reader = createFirstPacketReader(uuid);

    expect(reader.push(new Uint8Array(80).fill(0xff))).toEqual({ status: 'invalid' });
  });
});
