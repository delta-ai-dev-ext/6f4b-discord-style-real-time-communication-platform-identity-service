import { defineConfig } from 'drizzle-kit';

/**
 * drizzle-kit configuration.
 *
 * Reads `DATABASE_URL` straight from the process environment (instead of
 * importing `src/config.ts`) so schema generation works without a full,
 * validated runtime configuration.
 */
export default defineConfig({
  dialect: 'postgresql',
  schema: './src/db/schema.ts',
  out: './drizzle',
  dbCredentials: {
    url: process.env.DATABASE_URL ?? 'postgresql://postgres:postgres@localhost:5432/identity_service',
  },
  strict: true,
  verbose: true,
});
