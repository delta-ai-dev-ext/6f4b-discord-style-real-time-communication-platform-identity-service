import type { IdGeneratorPort } from '../repositories/ports';

/**
 * UUID v4 from the Web Crypto API (`crypto.getRandomValues`), as required by
 * the engineering guide — the `uuid` npm package is forbidden.
 */
export class CryptoIdGenerator implements IdGeneratorPort {
  newId(): string {
    const bytes = new Uint8Array(16);
    crypto.getRandomValues(bytes);
    // version 4 + RFC 4122 variant
    const byte6 = bytes[6] as number;
    const byte8 = bytes[8] as number;
    bytes[6] = (byte6 & 0x0f) | 0x40;
    bytes[8] = (byte8 & 0x3f) | 0x80;

    const hex: string[] = [];
    for (const byte of bytes) {
      hex.push(byte.toString(16).padStart(2, '0'));
    }
    const value = hex.join('');
    return `${value.slice(0, 8)}-${value.slice(8, 12)}-${value.slice(12, 16)}-${value.slice(16, 20)}-${value.slice(20)}`;
  }
}

export const cryptoIdGenerator = new CryptoIdGenerator();

/** Deterministic ids for tests. */
export function sequentialIdGenerator(prefix = '00000000-0000-4000-8000-'): IdGeneratorPort {
  let counter = 0;
  return {
    newId: () => {
      counter += 1;
      return `${prefix}${counter.toString(12).padStart(12, '0')}`;
    },
  };
}
