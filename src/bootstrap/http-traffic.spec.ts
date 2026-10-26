import { Logger } from '@nestjs/common';
import express, { type Request, type Response } from 'express';
import type { AddressInfo } from 'node:net';
import { createServer, request as httpRequest, type Server } from 'node:http';
import { HttpTraffic } from './http-traffic';

jest.mock('@sentry/nestjs', () => ({
  withScope: jest.fn((callback: (scope: unknown) => void) => callback({ setTags: jest.fn(), setExtra: jest.fn() })),
  captureMessage: jest.fn(),
}));

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

describe('HttpTraffic', () => {
  let server: Server;
  let traffic: HttpTraffic;
  let base: string;
  const late: unknown[] = [];

  beforeAll(async () => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'debug').mockImplementation(() => undefined);
    traffic = new HttpTraffic({ requestTimeoutMs: 100, uploadRequestTimeoutMs: 400 });
    const app = express();
    app.use(traffic.middleware);
    app.use((req, _res, next) => {
      (req as Request & { id: string }).id = 'req-1';
      next();
    });
    app.all('/slow/:ms', (req: Request, res: Response) => {
      setTimeout(() => {
        try {
          res.json({ done: true });
        } catch (err) {
          late.push(err);
        }
      }, Number(req.params.ms));
    });
    server = createServer(app);
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  });

  afterAll(async () => {
    jest.restoreAllMocks();
    await new Promise((resolve) => server.close(resolve));
  });

  it('answers a request still running after the timeout with 503 REQUEST_TIMEOUT', async () => {
    const res = await fetch(`${base}/slow/300`);
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({
      success: false,
      errorCode: 9102,
      error: 'REQUEST_TIMEOUT',
      errorMessage: expect.any(String),
      requestId: 'req-1',
    });
    await sleep(300);
    // The handler's late answer is dropped by Express, never sent twice.
    expect(late).toHaveLength(1);
  });

  it('gives multipart uploads the longer upload timeout', async () => {
    const res = await fetch(`${base}/slow/200`, {
      method: 'POST',
      headers: { 'content-type': 'multipart/form-data; boundary=x' },
      body: '--x--',
    });
    expect(res.status).toBe(200);
  });

  it('waits for in-flight requests on drain, then reports idle', async () => {
    const pending = fetch(`${base}/slow/60`);
    await sleep(20);
    expect(traffic.size).toBe(1);
    traffic.beginDrain();
    await expect(traffic.drained(1000)).resolves.toBe(true);
    const res = await pending;
    expect(res.status).toBe(200);
    expect(res.headers.get('connection')).toBe('close');
  });

  it('answers what is still running at the drain deadline with 503', async () => {
    const pending = fetch(`${base}/slow/90`, { headers: {} });
    await sleep(20);
    await expect(traffic.drained(10)).resolves.toBe(false);
    expect(traffic.answerRemaining()).toBe(1);
    const res = await pending;
    expect(res.status).toBe(503);
    expect(((await res.json()) as { error: string }).error).toBe('SERVICE_UNAVAILABLE');
  });

  it('logs a client abort as 499 and forgets the request', async () => {
    await new Promise<void>((resolve) => {
      const req = httpRequest(`${base}/slow/80`);
      req.on('error', () => resolve());
      req.end();
      setTimeout(() => req.destroy(), 20);
    });
    await sleep(30);
    expect(traffic.size).toBe(0);
  });
});
