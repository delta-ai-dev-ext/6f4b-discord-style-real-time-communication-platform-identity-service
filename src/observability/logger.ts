import { createLogger as createWinstonLogger, format, transports, type Logger } from 'winston';

/**
 * Structured JSON logger. Every line carries `timestamp`, `level` and
 * `service`; request-scoped lines additionally carry `route`, `method`,
 * `status_code`, `trace_id` and `error_code`. Secrets (JWTs, Svix signatures)
 * and emails at info level are never logged by the call sites.
 */

export const SERVICE_NAME = 'identity_service';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export type LogContext = {
  route?: string;
  method?: string;
  status_code?: number;
  trace_id?: string;
  error_code?: string;
  [key: string]: unknown;
};

/** Narrow logging port injected into services, repositories and workers. */
export interface LoggerPort {
  debug(message: string, context?: LogContext): void;
  info(message: string, context?: LogContext): void;
  warn(message: string, context?: LogContext): void;
  error(message: string, context?: LogContext): void;
  child(bindings: LogContext): LoggerPort;
}

const redactKeys = new Set([
  'authorization',
  'token',
  'jwt',
  'svix-signature',
  'svix_signature',
  'signing_secret',
  'email',
  'email_address',
]);

export function redact(context: LogContext | undefined): LogContext | undefined {
  if (context === undefined) return undefined;
  const output: LogContext = {};
  for (const [key, value] of Object.entries(context)) {
    if (redactKeys.has(key.toLowerCase())) {
      output[key] = '[redacted]';
      continue;
    }
    output[key] = value;
  }
  return output;
}

export class WinstonLogger implements LoggerPort {
  private readonly logger: Logger;

  constructor(logger: Logger) {
    this.logger = logger;
  }

  debug(message: string, context?: LogContext): void {
    this.logger.debug(message, redact(context));
  }

  info(message: string, context?: LogContext): void {
    this.logger.info(message, redact(context));
  }

  warn(message: string, context?: LogContext): void {
    this.logger.warn(message, redact(context));
  }

  error(message: string, context?: LogContext): void {
    this.logger.error(message, redact(context));
  }

  child(bindings: LogContext): LoggerPort {
    return new WinstonLogger(this.logger.child(bindings));
  }
}

export function createLogger(level: LogLevel = 'info'): LoggerPort {
  const logger = createWinstonLogger({
    level,
    defaultMeta: { service: SERVICE_NAME },
    format: format.combine(
      format.timestamp(),
      format.errors({ stack: true }),
      format.json(),
    ),
    transports: [new transports.Console({ stderrLevels: [] })],
  });

  return new WinstonLogger(logger);
}

/** No-op logger for tests and for optional collaborators. */
export const silentLogger: LoggerPort = {
  debug: () => undefined,
  info: () => undefined,
  warn: () => undefined,
  error: () => undefined,
  child: () => silentLogger,
};
