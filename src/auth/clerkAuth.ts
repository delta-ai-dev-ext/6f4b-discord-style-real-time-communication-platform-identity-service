import { verifyToken } from '@clerk/backend';
import { errors } from '../models/errors';
import type { AuthClaims } from '../services/profileService';
import { mapClaims, type ClerkJwtPayload } from './claims';

/**
 * Offline Clerk session-JWT verification. Only the published public key
 * (`CLERK_JWT_KEY`) is used — no Backend API secret and no outbound call.
 */
export type VerifyTokenFn = (
  token: string,
  options: { jwtKey: string },
) => Promise<ClerkJwtPayload | undefined>;

export interface TokenVerifier {
  verify(token: string): Promise<AuthClaims>;
}

export class ClerkTokenVerifier implements TokenVerifier {
  private readonly jwtKey: string;
  private readonly verifyFn: VerifyTokenFn;

  constructor(options: { jwtKey: string; verifyFn?: VerifyTokenFn }) {
    this.jwtKey = options.jwtKey;
    this.verifyFn = options.verifyFn ?? (verifyToken as unknown as VerifyTokenFn);
  }

  async verify(token: string): Promise<AuthClaims> {
    if (token.trim() === '') {
      throw errors.unauthorized();
    }

    let payload: ClerkJwtPayload | undefined;
    try {
      payload = await this.verifyFn(token, { jwtKey: this.jwtKey });
    } catch {
      // Never leak verification internals (or the token) to the client.
      throw errors.unauthorized('Session token is invalid or expired.');
    }

    return mapClaims(payload);
  }
}

/** Extracts a bearer token from an `Authorization` header value. */
export function extractBearerToken(headerValue: string | null | undefined): string {
  if (typeof headerValue !== 'string') throw errors.unauthorized();
  const match = /^Bearer\s+(.+)$/i.exec(headerValue.trim());
  const token = match?.[1];
  if (token === undefined || token.trim() === '') throw errors.unauthorized();
  return token.trim();
}
