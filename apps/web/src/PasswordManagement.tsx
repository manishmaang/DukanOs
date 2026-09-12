import { useEffect, useState, type FormEvent } from 'react';
import type { PasswordResetTarget } from '@dukanos/shared-types';
import { api, errorMessage } from './api';
export function ChangePassword({ onChanged }: { onChanged: () => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const currentPassword = String(data.get('currentPassword') ?? '');
    const newPassword = String(data.get('newPassword') ?? '');
    const confirmation = String(data.get('confirmation') ?? '');
    form.reset();
    setError('');
    if (newPassword !== confirmation) {
      setError('New password and confirmation must match.');
      return;
    }
    setBusy(true);
    try {
      await api('/auth/change-password', 'POST', {
        currentPassword,
        newPassword,
      });
      onChanged();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h1>Change password</h1>
      <p>
        All your devices will be signed out after this change. Sign in again
        with your new password.
      </p>
      <form onSubmit={submit}>
        <fieldset disabled={busy}>
          <legend>Your password</legend>
          <label>
            Current password
            <input
              name="currentPassword"
              type="password"
              autoComplete="current-password"
              required
              maxLength={128}
            />
          </label>
          <label>
            New password
            <input
              name="newPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={128}
            />
          </label>
          <label>
            Confirm new password
            <input
              name="confirmation"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={128}
            />
          </label>
        </fieldset>
        {error && <p role="alert">{error}</p>}
        <button disabled={busy}>
          {busy ? 'Changing…' : 'Change password and sign out'}
        </button>
      </form>
    </section>
  );
}
function ResetPassword({
  target,
  onReset,
}: {
  target: PasswordResetTarget;
  onReset: () => Promise<void>;
}) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    const newPassword = String(data.get('newPassword') ?? '');
    const confirmation = String(data.get('confirmation') ?? '');
    const reason = String(data.get('reason') ?? '');
    form.reset();
    setError('');
    if (newPassword !== confirmation) {
      setError('New password and confirmation must match.');
      return;
    }
    setBusy(true);
    try {
      await api(`/users/${target.id}/password-reset`, 'POST', {
        newPassword,
        reason,
        version: target.version,
      });
      await onReset();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details>
      <summary>
        Reset password · {target.name} ({target.username}) ·{' '}
        {target.roles.join(' + ')}
        {!target.active ? ' · Inactive' : ''}
      </summary>
      <p>
        Resets this staff member’s password and signs out all their devices.
        Account activation stays unchanged.
      </p>
      <form onSubmit={submit}>
        <fieldset disabled={busy}>
          <legend>New staff password</legend>
          <label>
            New password
            <input
              name="newPassword"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={128}
            />
          </label>
          <label>
            Confirm new password
            <input
              name="confirmation"
              type="password"
              autoComplete="new-password"
              required
              minLength={12}
              maxLength={128}
            />
          </label>
          <label>
            Administrative reason
            <input name="reason" required maxLength={500} />
          </label>
        </fieldset>
        {error && <p role="alert">{error}</p>}
        <button disabled={busy}>
          {busy ? 'Resetting…' : 'Reset password'}
        </button>
      </form>
    </details>
  );
}
export function StaffPasswordResets() {
  const [targets, setTargets] = useState<PasswordResetTarget[]>([]);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  async function load() {
    setTargets(
      await api<PasswordResetTarget[]>('/users/password-reset-targets'),
    );
    setError('');
  }
  useEffect(() => {
    void load().catch((error) => setError(errorMessage(error)));
  }, []);
  return (
    <>
      <h2>Staff password resets</h2>
      <p>
        Only accounts you are permitted to reset appear here. Use Change
        Password for your own account.
      </p>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <button
        type="button"
        onClick={() =>
          void load().catch((error) => setError(errorMessage(error)))
        }
      >
        Refresh reset list
      </button>
      {!targets.length && !error && <p>No eligible staff accounts.</p>}
      {targets.map((target) => (
        <ResetPassword
          key={`${target.id}:${target.version}`}
          target={target}
          onReset={async () => {
            setMessage('Password reset. The staff member must sign in again.');
            await load();
          }}
        />
      ))}
    </>
  );
}
