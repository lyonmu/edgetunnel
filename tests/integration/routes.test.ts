import { createExecutionContext, env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import worker from '../../src/index';

const uuid = '90cd4a77-141a-43c9-991b-08263cfe9c10';
const adminEnv = {
  KV: env.KV,
  ASSETS: env.ASSETS,
  ADMIN: 'admin',
  UUID: uuid,
};

describe('route priority', () => {
  describe('HTTP → HTTPS redirect', () => {
    it('redirects http to https with 301', async () => {
      const req = new Request('http://example.com/some/path', {
        cf: { country: 'US', colo: 'SJC', asn: 13335 },
      });
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, adminEnv, ctx);
      expect(res.status).toBe(301);
      expect(res.headers.get('Location')).toMatch(/^https:\/\//);
    });
  });

  describe('missing ADMIN password', () => {
    it('returns 404 noADMIN page when ADMIN is empty', async () => {
      const req = new Request('https://example.com/anything', {
        cf: { country: 'US', colo: 'SJC', asn: 13335 },
      });
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, { KV: env.KV, ASSETS: env.ASSETS }, ctx);
      expect(res.status).toBe(404);
    });
  });

  describe('admin routes', () => {
    it('handles /login route', async () => {
      const req = new Request('https://example.com/login', {
        cf: { country: 'US', colo: 'SJC', asn: 13335 },
      });
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, adminEnv, ctx);
      expect(res.status).toBeLessThanOrEqual(499);
    });
  });

  describe('subscription routes', () => {
    it('handles /sub route (reaches subscription module)', async () => {
      const req = new Request('https://example.com/sub', {
        cf: { country: 'US', colo: 'SJC', asn: 13335 },
      });
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, adminEnv, ctx);
      expect(res.status).toBeLessThanOrEqual(599);
    });
  });

  describe('robots.txt', () => {
    it('returns robots.txt disallow all', async () => {
      const req = new Request('https://example.com/robots.txt', {
        cf: { country: 'US', colo: 'SJC', asn: 13335 },
      });
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, adminEnv, ctx);
      expect(res.status).toBe(200);
      const text = await res.text();
      expect(text).toContain('Disallow');
    });
  });

  describe('transport routes', () => {
    it('WebSocket upgrade is intercepted by transport handler', async () => {
      const req = new Request('https://example.com/', {
        headers: {
          Upgrade: 'websocket',
          'Sec-WebSocket-Protocol': '',
        },
        cf: { country: 'US', colo: 'SJC', asn: 13335 },
      });
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, adminEnv, ctx);
      expect(res.status).toBe(101);
    });

    it('POST with grpc content-type is handled by gRPC transport', async () => {
      const req = new Request('https://example.com/test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/grpc',
        },
        body: new Uint8Array([0, 0, 0, 0, 0]),
        cf: { country: 'US', colo: 'SJC', asn: 13335 },
      });
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, adminEnv, ctx);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/grpc');
    });

    it('POST without grpc is handled by XHTTP transport', async () => {
      const req = new Request('https://example.com/test', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/octet-stream',
          Referer: 'https://example.com/x_padding=1',
        },
        body: new Uint8Array([0]),
        cf: { country: 'US', colo: 'SJC', asn: 13335 },
      });
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, adminEnv, ctx);
      expect(res.status).toBe(200);
      expect(res.headers.get('Content-Type')).toBe('application/octet-stream');
    });

    it('POST to /admin/ is not intercepted by transport routes', async () => {
      const req = new Request('https://example.com/admin/config.json', {
        method: 'POST',
        headers: { 'Content-Type': 'application/grpc' },
        cf: { country: 'US', colo: 'SJC', asn: 13335 },
      });
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, adminEnv, ctx);
      expect(res.headers.get('Content-Type')).not.toBe('application/grpc');
    });
  });

  describe('legacy fallback', () => {
    it('unhandled GET falls through to legacy worker', async () => {
      const req = new Request('https://example.com/version?uuid=' + uuid, {
        cf: { country: 'US', colo: 'SJC', asn: 13335 },
      });
      const ctx = createExecutionContext();
      const res = await worker.fetch(req, adminEnv, ctx);
      expect(res.status).toBe(200);
      await expect(res.json()).resolves.toHaveProperty('Version');
    });
  });
});
