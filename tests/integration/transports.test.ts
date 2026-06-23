import { describe, expect, it, vi } from 'vitest';
import { createResponseBridge, parseFirstPacket, createRemoteConnWrapper } from '../../src/transports/bridge';
import { createGrpcBridge } from '../../src/transports/grpc';

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
});
