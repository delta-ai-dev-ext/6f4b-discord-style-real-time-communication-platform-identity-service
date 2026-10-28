/**
 * PostgreSQL error helpers. Repositories adapters raise driver errors, and the
 * service layer translates the few it can act on into domain errors.
 */

export function isUniqueViolation(error: unknown, constraintName?: string): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const candidate = error as { code?: unknown; constraint?: unknown };
  if (candidate.code !== '23505') return false;
  if (constraintName === undefined) return true;
  return typeof candidate.constraint === 'string' && candidate.constraint === constraintName;
}

export function isForeignKeyViolation(error: unknown): boolean {
  return typeof error === 'object' && error !== null && (error as { code?: unknown }).code === '23503';
}

export function describeError(error: unknown): string {
  if (error instanceof Error) return error.message;
  return String(error);
}
