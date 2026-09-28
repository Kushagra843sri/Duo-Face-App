import { loadEnv } from '../src/config/env';

describe('loadEnv', () => {
  it('throws a clear error when PORT is missing', () => {
    expect(() => loadEnv({ NODE_ENV: 'test' })).toThrow(/PORT/);
  });

  it('parses a valid environment', () => {
    const env = loadEnv({ NODE_ENV: 'test', PORT: '4000' });

    expect(env).toEqual({ NODE_ENV: 'test', PORT: 4000 });
  });

  it('defaults NODE_ENV to development', () => {
    const env = loadEnv({ PORT: '4000' });

    expect(env.NODE_ENV).toBe('development');
  });
});
