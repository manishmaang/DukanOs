import { isAbsolute } from 'node:path';
export function readConfig(env: NodeJS.ProcessEnv = process.env) {
  const mode = env.NODE_ENV ?? 'development';
  if (!['development', 'test', 'production'].includes(mode))
    throw new Error('NODE_ENV must be development, test or production');
  const host = env.HOST ?? '127.0.0.1';
  if (
    mode === 'production' &&
    (host !== '127.0.0.1' ||
      !env.DUKANOS_DATA_DIR ||
      !isAbsolute(env.DUKANOS_DATA_DIR))
  )
    throw new Error(
      'Production requires HOST=127.0.0.1 and an absolute DUKANOS_DATA_DIR',
    );
  const port = Number(env.PORT ?? '3000');
  if (!Number.isInteger(port) || port < 1 || port > 65535)
    throw new Error('PORT must be an integer between 1 and 65535');
  const databaseUrl = env.DATABASE_URL;
  if (!databaseUrl) throw new Error('DATABASE_URL is required');
  let parsed: URL;
  try {
    parsed = new URL(databaseUrl);
  } catch {
    throw new Error('DATABASE_URL must be a PostgreSQL URL');
  }
  if (!['postgres:', 'postgresql:'].includes(parsed.protocol))
    throw new Error('DATABASE_URL must be a PostgreSQL URL');
  if (
    mode === 'production' &&
    (parsed.searchParams.has('host') || parsed.searchParams.has('hostaddr'))
  )
    throw new Error(
      'Production database host must be specified only in the URL authority',
    );
  if (
    mode === 'production' &&
    !['127.0.0.1', 'localhost', '[::1]'].includes(parsed.hostname) &&
    parsed.searchParams.get('sslmode') !== 'verify-full'
  )
    throw new Error(
      'Remote production PostgreSQL requires sslmode=verify-full',
    );
  return { port, host, databaseUrl, production: mode === 'production' };
}
