import type { z } from 'zod';
import { errors } from '../models/errors';
import type { AuthClaims } from '../services/profileService';
import type { TraceContext } from '../observability/trace';

/** Thin-controller request context: verified identity + trace only. */
export type RequestContext = {
  claims: AuthClaims;
  trace: TraceContext;
};

/** Controller output: the transport layer renders `body` with `status`. */
export type ApiResult<T> = {
  status: number;
  body: T;
};

export type ValidationIssue = { path: string; message: string };

/** Validates input at the boundary, mapping failures to `validation_error`. */
export function parseOrThrow<TSchema extends z.ZodType>(
  schema: TSchema,
  value: unknown,
): z.infer<TSchema> {
  const result = schema.safeParse(value);
  if (!result.success) {
    const issues: ValidationIssue[] = result.error.issues.map((issue) => ({
      path: issue.path.join('.'),
      message: issue.message,
    }));
    throw errors.validation(issues);
  }
  return result.data;
}
