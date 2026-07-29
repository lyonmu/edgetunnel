import { afterEach, describe, expect, it } from 'vitest';
import { httpsConnect } from '../../../src/networking/proxy-connectors';
import { startTlsServer, writeFragmented, type TcpFixture } from '../../fixtures/tcp-server';

const fixtures: TcpFixture[] = [];
afterEach(async () => {
  await Promise.all(fixtures.splice(0).map((fixture) => fixture.close()));
});

describe('HTTPS CONNECT connector integration', () => {
  it('completes a real TLS 1.2 handshake and relays initial data', async () => {
    let request = '';
    let connected = false;
    let resolveInitial!: (value: Uint8Array) => void;
    const initial = new Promise<Uint8Array>((resolve) => {
      resolveInitial = resolve;
    });
    const fixture = await startTlsServer(async (socket) => {
      for await (const chunk of socket) {
        if (connected) {
          resolveInitial(new Uint8Array(chunk));
          break;
        }
        request += new TextDecoder().decode(chunk);
        if (request.includes('\r\n\r\n')) {
          expect(request).toContain('CONNECT example.com:443 HTTP/1.1');
          expect(request).toContain(`Proxy-Authorization: Basic ${btoa('alice:secret')}`);
          connected = true;
          await writeFragmented(
            socket,
            new TextEncoder().encode('HTTP/1.1 200 Connection Established\r\n\r\nOK'),
            2,
          );
        }
      }
    });
    fixtures.push(fixture);

    const socket = await httpsConnect(
      'example.com',
      443,
      null,
      { hostname: '127.0.0.1', port: fixture.port, username: 'alice', password: 'secret' },
      fixture.connector,
    );
    const reader = socket.readable.getReader();
    const response = new Uint8Array(2);
    let offset = 0;
    while (offset < response.byteLength) {
      const result = await reader.read();
      if (result.done) break;
      response.set(result.value, offset);
      offset += result.value.byteLength;
    }
    expect(response).toEqual(new Uint8Array([79, 75]));
    reader.releaseLock();
    const writer = socket.writable.getWriter();
    await writer.write(new Uint8Array([9, 8]));
    writer.releaseLock();
    await expect(initial).resolves.toEqual(new Uint8Array([9, 8]));
    await socket.close();
  });

  it('rejects CONNECT failures without exposing credentials', async () => {
    const fixture = await startTlsServer(async (socket) => {
      socket.once('data', () => {
        void writeFragmented(
          socket,
          new TextEncoder().encode('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n'),
          3,
        );
      });
    });
    fixtures.push(fixture);

    const promise = httpsConnect(
      'example.com',
      443,
      null,
      { hostname: '127.0.0.1', port: fixture.port, username: 'alice', password: 'secret' },
      fixture.connector,
    );
    await expect(promise).rejects.toThrow('HTTP 407');
    await expect(promise).rejects.not.toThrow(/alice|secret/);
  });
});
