import type { Event, Socket } from 'socket.io';
import { createSocketRateLimiter } from './socket-rate-limiter';

describe('createSocketRateLimiter', () => {
  beforeEach(() => jest.useFakeTimers());
  afterEach(() => jest.useRealTimers());

  it('passes events under the limit, drops the rest, notifies once per window, then resets', () => {
    const emit = jest.fn();
    const limiter = createSocketRateLimiter({ emit } as unknown as Socket, 2, 1000);
    const next = jest.fn();
    const event = ['answer', {}] as Event;

    for (let i = 0; i < 5; i++) limiter(event, next);
    expect(next).toHaveBeenCalledTimes(2);
    expect(emit).toHaveBeenCalledTimes(1);
    expect(emit).toHaveBeenCalledWith('exception', expect.objectContaining({ error: 'RATE_LIMITED' }));

    jest.advanceTimersByTime(1000);
    limiter(event, next);
    expect(next).toHaveBeenCalledTimes(3);
  });
});
