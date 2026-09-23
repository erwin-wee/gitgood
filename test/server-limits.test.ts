import { describe, expect, it } from 'vitest';
import { auditLine, isMutating, KeyedMutex, mutationKey, RateLimiter } from '../src/server/limits';

describe('isMutating / mutationKey', () => {
  it('flags writes and leaves reads alone', () => {
    expect(isMutating('git.push')).toBe(true);
    expect(isMutating('ai.split.apply')).toBe(true);
    expect(isMutating('repo.commit.details')).toBe(false);
    expect(isMutating('app.settings.get')).toBe(false);
  });

  it('keys a mutation by its repo-path argument, else the method', () => {
    expect(mutationKey('git.push', ['/repos/app', { branch: 'main' }])).toBe('/repos/app');
    expect(mutationKey('settings.import', ['relative/file', 'merge'])).toBe('settings.import');
  });
});

describe('KeyedMutex', () => {
  const flush = async () => {
    for (let i = 0; i < 6; i++) await Promise.resolve();
  };

  it('serializes same-key work: the second call waits for the first', async () => {
    const mutex = new KeyedMutex();
    const started: string[] = [];
    const g1 = Promise.withResolvers<void>();
    const g2 = Promise.withResolvers<void>();
    const p1 = mutex.run('same', async () => { started.push('a'); await g1.promise; });
    const p2 = mutex.run('same', async () => { started.push('b'); await g2.promise; });
    await flush();
    expect(started).toEqual(['a']); // b is blocked behind a
    g1.resolve();
    await p1;
    await flush();
    expect(started).toEqual(['a', 'b']); // a released, b runs
    g2.resolve();
    await p2;
  });

  it('runs different keys concurrently', async () => {
    const mutex = new KeyedMutex();
    const started: string[] = [];
    const gx = Promise.withResolvers<void>();
    const gy = Promise.withResolvers<void>();
    const px = mutex.run('x', async () => { started.push('x'); await gx.promise; });
    const py = mutex.run('y', async () => { started.push('y'); await gy.promise; });
    await flush();
    expect([...started].sort()).toEqual(['x', 'y']); // both in flight
    gx.resolve();
    gy.resolve();
    await Promise.all([px, py]);
  });

  it('propagates and isolates errors without wedging the key', async () => {
    const mutex = new KeyedMutex();
    await expect(mutex.run('k', async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    await expect(mutex.run('k', async () => 'ok')).resolves.toBe('ok');
  });
});
describe('RateLimiter', () => {
  it('allows a burst up to capacity, then blocks until refill', () => {
    let now = 1000;
    const limiter = new RateLimiter(2, 1, () => now); // 2 burst, 1/sec
    expect(limiter.allow('c')).toBe(true);
    expect(limiter.allow('c')).toBe(true);
    expect(limiter.allow('c')).toBe(false); // spent
    now += 1000; // refill one token
    expect(limiter.allow('c')).toBe(true);
    expect(limiter.allow('c')).toBe(false);
  });

  it('tracks clients independently', () => {
    const limiter = new RateLimiter(1, 1, () => 0);
    expect(limiter.allow('a')).toBe(true);
    expect(limiter.allow('b')).toBe(true);
    expect(limiter.allow('a')).toBe(false);
  });
});

describe('auditLine', () => {
  it('renders a stable audit record', () => {
    expect(auditLine('c1', 'git.push', '/repos/app', true)).toBe('[audit] client=c1 method=git.push target=/repos/app outcome=ok');
    expect(auditLine('', 'git.commit', '/r', false)).toBe('[audit] client=- method=git.commit target=/r outcome=error');
  });
});
