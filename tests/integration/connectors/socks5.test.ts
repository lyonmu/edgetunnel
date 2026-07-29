import { afterEach, describe, expect, it } from 'vitest';
import { socks5Connect } from '../../../src/networking/proxy-connectors';
import { concatBytes } from '../../../src/shared/bytes';
import { startTcpServer, writeFragmented, type TcpFixture } from '../../fixtures/tcp-server';

const fixtures: TcpFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe('SOCKS5 connector integration', () => {
  it('handles fragmented authentication and CONNECT responses before relaying initial data', async () => {
    let received = new Uint8Array();
    let resolveInitial!: () => void;
    const initialReceived = new Promise<void>((resolve) => {
      resolveInitial = resolve;
    });
    const fixture = await startTcpServer(async (socket) => {
      let stage = 0;
      for await (const chunk of socket) {
        received = new Uint8Array(concatBytes(received, new Uint8Array(chunk)));
        if (stage === 0 && received.byteLength >= 4) {
          expect(received.slice(0, 4)).toEqual(new Uint8Array([5, 2, 0, 2]));
          received = received.slice(4);
          stage = 1;
          await writeFragmented(socket, new Uint8Array([5, 2]));
        }
        if (stage === 1 && received.byteLength >= 14) {
          expect(new TextDecoder().decode(received.slice(2, 7))).toBe('alice');
          received = received.slice(14);
          stage = 2;
          await writeFragmented(socket, new Uint8Array([1, 0]));
        }
        if (stage === 2 && received.byteLength >= 18) {
          expect(new TextDecoder().decode(received.slice(5, 16))).toBe('example.com');
          expect(received.slice(16, 18)).toEqual(new Uint8Array([1, 187]));
          received = received.slice(18);
          stage = 3;
          await writeFragmented(socket, new Uint8Array([5, 0, 0, 1, 127, 0, 0, 1, 0, 80]));
        }
        if (stage === 3 && received.byteLength >= 2) {
          expect(received.slice(0, 2)).toEqual(new Uint8Array([9, 8]));
          resolveInitial();
          break;
        }
      }
    });
    fixtures.push(fixture);

    const socket = await socks5Connect(
      'example.com',
      443,
      new Uint8Array([9, 8]),
      { hostname: '127.0.0.1', port: fixture.port, username: 'alice', password: 'secret' },
      fixture.connector,
    );
    await initialReceived;
    await socket.close();
  });

  it('does not include credentials in authentication failures', async () => {
    const fixture = await startTcpServer(async (socket) => {
      let stage = 0;
      for await (const chunk of socket) {
        if (stage === 0 && chunk.length >= 4) {
          stage = 1;
          await writeFragmented(socket, new Uint8Array([5, 2]));
        } else if (stage === 1) {
          await writeFragmented(socket, new Uint8Array([1, 1]));
          break;
        }
      }
    });
    fixtures.push(fixture);

    const promise = socks5Connect(
      'example.com',
      443,
      null,
      { hostname: '127.0.0.1', port: fixture.port, username: 'alice', password: 'secret' },
      fixture.connector,
    );
    await expect(promise).rejects.toThrow('authentication failed');
    await expect(promise).rejects.not.toThrow(/alice|secret/);
  });
});
