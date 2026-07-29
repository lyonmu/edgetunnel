import { afterEach, describe, expect, it } from 'vitest';
import type { Socket as NodeSocket } from 'node:net';
import { buildSstpDataPacket, sstpConnect } from '../../../src/networking/sstp';
import { concatBytes } from '../../../src/shared/bytes';
import { startTcpServer, writeFragmented, type TcpFixture } from '../../fixtures/tcp-server';

const fixtures: TcpFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

function pppConfigure(
  protocol: number,
  code: number,
  id: number,
  options = new Uint8Array(),
): Uint8Array {
  const frame = new Uint8Array(6 + options.byteLength);
  const view = new DataView(frame.buffer);
  view.setUint16(0, protocol);
  frame[2] = code;
  frame[3] = id;
  view.setUint16(4, 4 + options.byteLength);
  frame.set(options, 6);
  return frame;
}

function tcpReply(request: Uint8Array, flags: number, sequence: number): Uint8Array {
  const frame = new Uint8Array(48);
  const view = new DataView(frame.buffer);
  frame.set([0x10, 0, 0x80, 48, 0xff, 3, 0, 0x21, 0x45, 0]);
  view.setUint16(10, 40);
  frame[17] = 6;
  frame.set(request.slice(24, 28), 20);
  frame.set(request.slice(20, 24), 24);
  view.setUint16(28, new DataView(request.buffer, request.byteOffset).getUint16(30));
  view.setUint16(30, new DataView(request.buffer, request.byteOffset).getUint16(28));
  view.setUint32(32, sequence);
  view.setUint32(36, (new DataView(request.buffer, request.byteOffset).getUint32(32) + 1) >>> 0);
  frame[40] = 0x50;
  frame[41] = flags;
  view.setUint16(42, 65_535);
  return frame;
}

async function serveSstp(socket: NodeSocket): Promise<void> {
  let started = false;
  let pending = new Uint8Array();
  socket.on('data', (chunk) => {
    if (!started) return;
    const bytes =
      typeof chunk === 'string' ? new TextEncoder().encode(chunk) : new Uint8Array(chunk);
    pending = new Uint8Array(concatBytes(pending, bytes));
    while (pending.byteLength >= 4) {
      const length = (((pending[2] ?? 0) & 0x0f) << 8) | (pending[3] ?? 0);
      if (length < 4 || pending.byteLength < length) return;
      const packet = pending.slice(0, length);
      pending = pending.slice(length);
      if (
        packet.byteLength >= 48 &&
        packet[6] === 0 &&
        packet[7] === 0x21 &&
        (packet[41]! & 0x02) !== 0
      ) {
        void (async () => {
          await writeFragmented(socket, tcpReply(packet, 0x12, 100), 3);
          await writeFragmented(socket, tcpReply(packet, 0x11, 101), 3);
        })().catch(() => undefined);
      }
    }
  });

  await new Promise<void>((resolve) => socket.once('data', () => resolve()));
  started = true;
  await writeFragmented(socket, new TextEncoder().encode('HTTP/1.1 200 OK\r\n\r\n'), 2);
  const lcpRequest = buildSstpDataPacket(pppConfigure(0xc021, 1, 7));
  const lcpAck = buildSstpDataPacket(pppConfigure(0xc021, 2, 1));
  const ipOption = new Uint8Array([3, 6, 10, 0, 0, 2]);
  const ipcpAck = buildSstpDataPacket(pppConfigure(0x8021, 2, 2, ipOption));
  await writeFragmented(socket, new Uint8Array(concatBytes(lcpRequest, lcpAck, ipcpAck)), 4);
}

describe('SSTP connector integration', () => {
  it('negotiates fragmented HTTP, PPP and tunneled TCP handshakes', async () => {
    const fixture = await startTcpServer(serveSstp);
    fixtures.push(fixture);

    const socket = await sstpConnect(
      { hostname: '127.0.0.1', port: fixture.port },
      '198.51.100.10',
      443,
      fixture.connector,
    );

    expect(socket.readable).toBeInstanceOf(ReadableStream);
    expect(socket.writable).toBeInstanceOf(WritableStream);
    await socket.readable.cancel();
    await socket.close();
  });

  it('rejects HTTP failures without exposing PAP credentials', async () => {
    const fixture = await startTcpServer(async (socket) => {
      socket.once('data', () => {
        void writeFragmented(socket, new TextEncoder().encode('HTTP/1.1 403 Forbidden\r\n\r\n'));
      });
    });
    fixtures.push(fixture);

    const promise = sstpConnect(
      { hostname: '127.0.0.1', port: fixture.port, username: 'alice', password: 'secret' },
      '198.51.100.10',
      443,
      fixture.connector,
    );
    await expect(promise).rejects.toThrow('403');
    await expect(promise).rejects.not.toThrow(/alice|secret/);
  });
});
