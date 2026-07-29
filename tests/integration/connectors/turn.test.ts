import { afterEach, describe, expect, it } from 'vitest';
import type { Socket as NodeSocket } from 'node:net';
import {
  createTurnStunAttribute,
  createTurnStunMessage,
  turnConnect,
} from '../../../src/networking/turn';
import { concatBytes } from '../../../src/shared/bytes';
import { startTcpServer, writeFragmented, type TcpFixture } from '../../fixtures/tcp-server';

const fixtures: TcpFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

function socketReader(socket: NodeSocket) {
  let pending = new Uint8Array();
  const chunks: Uint8Array[] = [];
  let wake: (() => void) | null = null;
  socket.on('data', (chunk) => {
    chunks.push(
      typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk),
    );
    wake?.();
    wake = null;
  });
  const readExact = async (length: number): Promise<Uint8Array> => {
    while (pending.byteLength < length) {
      if (!chunks.length) await new Promise<void>((resolve) => (wake = resolve));
      const chunk = chunks.shift();
      if (chunk) pending = new Uint8Array(concatBytes(pending, chunk));
    }
    const value = pending.slice(0, length);
    pending = pending.slice(length);
    return value;
  };
  return {
    async stun() {
      const header = await readExact(20);
      const length = ((header[2] ?? 0) << 8) | (header[3] ?? 0);
      return new Uint8Array(concatBytes(header, await readExact(length)));
    },
    readExact,
  };
}

function response(type: number, request: Uint8Array, attributes: Uint8Array[] = []) {
  return createTurnStunMessage(type, request.slice(8, 20), attributes);
}

describe('TURN TCP connector integration', () => {
  it('establishes control and data connections across fragmented STUN responses', async () => {
    let connection = 0;
    let resolveRelay!: (value: Uint8Array) => void;
    const relayed = new Promise<Uint8Array>((resolve) => {
      resolveRelay = resolve;
    });
    const fixture = await startTcpServer(async (socket) => {
      connection += 1;
      const reader = socketReader(socket);
      if (connection === 1) {
        const allocate = await reader.stun();
        expect(new DataView(allocate.buffer).getUint16(0)).toBe(0x0003);
        await writeFragmented(socket, response(0x0103, allocate));

        const permission = await reader.stun();
        const connect = await reader.stun();
        expect(new DataView(permission.buffer).getUint16(0)).toBe(0x0008);
        expect(new DataView(connect.buffer).getUint16(0)).toBe(0x000a);
        const connectionId = createTurnStunAttribute(0x002a, new Uint8Array([1, 2, 3, 4]));
        await writeFragmented(
          socket,
          new Uint8Array(
            concatBytes(response(0x0108, permission), response(0x010a, connect, [connectionId])),
          ),
          3,
        );
      } else {
        const bind = await reader.stun();
        expect(new DataView(bind.buffer).getUint16(0)).toBe(0x000b);
        await writeFragmented(socket, response(0x010b, bind), 2);
        resolveRelay(await reader.readExact(2));
      }
    });
    fixtures.push(fixture);

    const socket = await turnConnect(
      { hostname: '127.0.0.1', port: fixture.port },
      '198.51.100.10',
      443,
      fixture.connector,
    );
    const writer = socket.writable.getWriter();
    await writer.write(new Uint8Array([9, 8]));
    writer.releaseLock();
    await expect(relayed).resolves.toEqual(new Uint8Array([9, 8]));
    await socket.close();
  });

  it('returns bounded errors without credential values', async () => {
    const fixture = await startTcpServer(async (socket) => {
      const reader = socketReader(socket);
      const allocate = await reader.stun();
      const error = createTurnStunAttribute(0x0009, new Uint8Array([0, 0, 4, 3]));
      await writeFragmented(socket, response(0x0113, allocate, [error]));
    });
    fixtures.push(fixture);

    const promise = turnConnect(
      { hostname: '127.0.0.1', port: fixture.port, username: 'alice', password: 'secret' },
      '198.51.100.10',
      443,
      fixture.connector,
    );
    await expect(promise).rejects.toThrow('403');
    await expect(promise).rejects.not.toThrow(/alice|secret/);
  });
});
