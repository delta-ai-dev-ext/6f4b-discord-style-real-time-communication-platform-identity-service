import { describe, expect, test } from 'bun:test';
import {
  decodeCursor,
  decodeCursorNumber,
  decodeCursorString,
  encodeCursor,
} from '../../src/services/cursor';
import { DomainError } from '../../src/models/errors';

describe('cursor encoding', () => {
  test('round-trips string and number parts', () => {
    const cursor = encodeCursor([1737038400000, 'ab-12']);
    expect(decodeCursor(cursor)).toEqual(['1737038400000', 'ab-12']);
    expect(decodeCursorNumber(cursor, 0)).toBe(1737038400000);
    expect(decodeCursorString(cursor, 1)).toBe('ab-12');
  });

  test('produces url-safe opaque values', () => {
    const cursor = encodeCursor(['a/b+c=', 'd']);
    expect(cursor).not.toContain('/');
    expect(cursor).not.toContain('+');
    expect(cursor).not.toContain('=');
  });

  test.each([
    ['not base64 json', 'not-a-cursor'],
    ['json but not an array', encodeCursor(['x']).slice(0, 2)],
  ])('rejects %s with validation_error', (_name, cursor) => {
    expect(() => decodeCursor(cursor)).toThrow(DomainError);
    try {
      decodeCursor(cursor);
    } catch (error) {
      expect((error as DomainError).code).toBe('validation_error');
    }
  });

  test('rejects a cursor without the requested component', () => {
    const cursor = encodeCursor(['only-one']);
    expect(() => decodeCursorString(cursor, 3)).toThrow(DomainError);
    expect(() => decodeCursorNumber(cursor, 5)).toThrow(DomainError);
  });

  test('rejects non numeric number components', () => {
    const cursor = encodeCursor(['not-a-number']);
    expect(() => decodeCursorNumber(cursor, 0)).toThrow(DomainError);
  });
});
