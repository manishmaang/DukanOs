require('reflect-metadata');
const { Writable } = require('node:stream');
const { createInterface } = require('node:readline/promises');
const {
  DatabaseService,
} = require('../apps/api/dist/database/database.service');
const {
  PasswordManagementService,
} = require('../apps/api/dist/modules/users/password-management.service');
class InputError extends Error {}
function requireLocalDatabase() {
  let url;
  try {
    url = new URL(process.env.DATABASE_URL);
  } catch {
    throw new InputError('Configure a valid local DATABASE_URL first.');
  }
  if (
    !['postgres:', 'postgresql:'].includes(url.protocol) ||
    !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname) ||
    url.searchParams.has('host') ||
    url.searchParams.has('hostaddr')
  )
    throw new InputError(
      'Owner recovery requires a loopback PostgreSQL connection on this machine.',
    );
}
async function readInput() {
  if (process.argv.length !== 2)
    throw new InputError(
      'Do not supply command-line arguments. Use hidden prompts or JSON on stdin.',
    );
  if (!process.stdin.isTTY) {
    let text = '';
    for await (const chunk of process.stdin) {
      text += chunk.toString();
      if (text.length > 8192)
        throw new InputError('Recovery input is too large.');
    }
    try {
      return JSON.parse(text);
    } catch {
      throw new InputError(
        'Supply JSON on stdin with username, newPassword, confirmPassword, and reason.',
      );
    }
  }
  let muted = false;
  const output = new Writable({
    write(chunk, encoding, callback) {
      if (!muted) process.stdout.write(chunk, encoding);
      callback();
    },
  });
  output.isTTY = true;
  output.columns = process.stdout.columns;
  const rl = createInterface({
    input: process.stdin,
    output,
    terminal: true,
    historySize: 0,
  });
  const abort = new AbortController();
  rl.on('SIGINT', () => abort.abort());
  try {
    const username = await rl.question('Owner username: ', {
      signal: abort.signal,
    });
    process.stdout.write('New password (hidden, 12–128 characters): ');
    muted = true;
    const newPassword = await rl.question('', { signal: abort.signal });
    muted = false;
    process.stdout.write('\nConfirm password (hidden): ');
    muted = true;
    const confirmPassword = await rl.question('', { signal: abort.signal });
    muted = false;
    process.stdout.write('\n');
    const reason = await rl.question('Recovery reason: ', {
      signal: abort.signal,
    });
    return { username, newPassword, confirmPassword, reason };
  } catch {
    throw new InputError('Recovery cancelled. No password was changed.');
  } finally {
    muted = false;
    rl.close();
  }
}
async function run() {
  requireLocalDatabase();
  const input = await readInput();
  if (
    !input ||
    typeof input !== 'object' ||
    typeof input.newPassword !== 'string' ||
    input.newPassword !== input.confirmPassword
  )
    throw new InputError(
      'Password confirmation does not match. No account was changed.',
    );
  const db = new DatabaseService();
  try {
    await new PasswordManagementService(db).recoverOwner(
      input.username,
      input.newPassword,
      input.reason,
    );
    console.log(
      'Owner password updated. All owner sessions were revoked. Sign in with the new password.',
    );
  } finally {
    await db.onApplicationShutdown();
  }
}
run().catch((error) => {
  const allowed = new Set([
    'INVALID_PASSWORD',
    'REASON_REQUIRED',
    'INVALID_USERNAME',
    'OWNER_NOT_FOUND',
    'OWNER_INACTIVE',
  ]);
  const detail =
    typeof error?.getResponse === 'function' ? error.getResponse() : undefined;
  console.error(
    error instanceof InputError
      ? error.message
      : allowed.has(detail?.code)
        ? `${detail.code}: ${detail.message}`
        : 'Recovery failed. Check local database connectivity and migrations. No password values are printed.',
  );
  process.exitCode = 1;
});
