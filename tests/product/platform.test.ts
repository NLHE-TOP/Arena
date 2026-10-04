import { expect, it } from 'vitest';
import { platformClient } from '../../src/platform.js';

it('isolates client credentials without a global current actor', () => {
  const first = platformClient('http://127.0.0.1:3000', 'first');
  const second = platformClient('http://127.0.0.1:3000', 'second');
  first.setToken('rotated');
  expect(first.getToken()).toBe('rotated');
  expect(second.getToken()).toBe('second');
});
