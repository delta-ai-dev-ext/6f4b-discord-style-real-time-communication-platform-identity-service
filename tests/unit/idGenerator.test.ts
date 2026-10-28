import { describe, expect, test } from 'bun:test';
import { CryptoIdGenerator, sequentialIdGenerator } from '../../src/services/idGenerator';

const UUID_V4 = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('id generation', () => {
  test('generates RFC 4122 version 4 uuids from Web Crypto', () => {
    const generator = new CryptoIdGenerator();
    const ids = new Set<string>();

    for (let index = 0; index < 50; index += 1) {
      const id = generator.newId();
      expect(id).toMatch(UUID_V4);
      ids.add(id);
    }

    expect(ids.size).toBe(50);
  });

  test('sequential generator is deterministic for tests', () => {
    const generator = sequentialIdGenerator();
    expect(generator.newId()).toBe('00000000-0000-4000-8000-000000000001');
    expect(generator.newId()).toBe('00000000-0000-4000-8000-000000000002');
  });
});
