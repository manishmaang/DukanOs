import { useEffect, useState, type FormEvent } from 'react';
import type { RoleCode, StaffUser } from '@dukanos/shared-types';
import { api, errorMessage } from './api';
const operational: RoleCode[] = ['CASHIER', 'KITCHEN', 'DISPATCH'];
function RolePicker({
  roles,
  onChange,
}: {
  roles: RoleCode[];
  onChange: (roles: RoleCode[]) => void;
}) {
  const privileged = roles.find(
    (role) => role === 'OWNER' || role === 'MANAGER',
  );
  return (
    <fieldset>
      <legend>Staff responsibilities</legend>
      <label>
        Access category
        <select
          value={privileged ?? 'OPERATIONAL'}
          onChange={(event) =>
            onChange(
              event.target.value === 'OPERATIONAL'
                ? ['CASHIER']
                : [event.target.value as RoleCode],
            )
          }
        >
          <option value="OPERATIONAL">Operational staff</option>
          <option value="MANAGER">Manager</option>
          <option value="OWNER">Owner</option>
        </select>
      </label>
      {!privileged && (
        <div className="role-options">
          {operational.map((role) => (
            <label key={role}>
              <input
                type="checkbox"
                checked={roles.includes(role)}
                onChange={(event) =>
                  onChange(
                    event.target.checked
                      ? [...roles, role]
                      : roles.filter((value) => value !== role),
                  )
                }
              />
              {role}
            </label>
          ))}
        </div>
      )}
      <small>
        Choose one privileged role or at least one operational responsibility.
      </small>
    </fieldset>
  );
}
function StaffAccess({
  user,
  onSaved,
}: {
  user: StaffUser;
  onSaved: () => Promise<void>;
}) {
  const [roles, setRoles] = useState(user.roles);
  const [active, setActive] = useState(user.active);
  const [reason, setReason] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function save(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    try {
      await api(`/users/${user.id}/access`, 'PATCH', {
        roles,
        active,
        reason,
        version: user.version,
      });
      await onSaved();
      setReason('');
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <details>
      <summary>
        {user.name} · {user.username} · {user.roles.join(' + ')}
        {!user.active ? ' · Inactive' : ''}
      </summary>
      <form onSubmit={save}>
        <RolePicker roles={roles} onChange={setRoles} />
        <label className="inline">
          <input
            type="checkbox"
            checked={active}
            onChange={(event) => setActive(event.target.checked)}
          />
          Account active
        </label>
        <label>
          Reason for change
          <input
            required
            maxLength={500}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button disabled={busy || !roles.length}>
          {busy ? 'Saving…' : 'Save access'}
        </button>
      </form>
    </details>
  );
}
export function StaffAdmin({
  refreshSession,
}: {
  refreshSession: () => Promise<void>;
}) {
  const [staff, setStaff] = useState<StaffUser[]>([]);
  const [roles, setRoles] = useState<RoleCode[]>(['CASHIER']);
  const [error, setError] = useState('');
  const [message, setMessage] = useState('');
  const [busy, setBusy] = useState(false);
  async function load() {
    setStaff(await api<StaffUser[]>('/users'));
  }
  useEffect(() => {
    void load().catch((error) => setError(errorMessage(error)));
  }, []);
  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = event.currentTarget;
    const data = new FormData(form);
    setBusy(true);
    setError('');
    setMessage('');
    try {
      await api('/users', 'POST', {
        username: data.get('username'),
        name: data.get('name'),
        password: data.get('password'),
        roles,
      });
      form.reset();
      setRoles(['CASHIER']);
      setMessage('Staff account created.');
      await load();
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <>
      <h2>Staff access</h2>
      <p>
        Create staff accounts and assign all responsibilities they perform
        during a shift.
      </p>
      {error && <p role="alert">{error}</p>}
      {message && <p role="status">{message}</p>}
      <form onSubmit={create}>
        <label>
          Name
          <input name="name" required maxLength={100} autoComplete="name" />
        </label>
        <label>
          Username
          <input
            name="username"
            required
            minLength={3}
            maxLength={64}
            pattern="[a-zA-Z0-9][a-zA-Z0-9._\-]{2,63}"
            autoComplete="off"
          />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            required
            minLength={12}
            maxLength={128}
            autoComplete="new-password"
          />
        </label>
        <RolePicker roles={roles} onChange={setRoles} />
        <button disabled={busy || !roles.length}>
          {busy ? 'Creating…' : 'Create staff account'}
        </button>
      </form>
      <h3>Current staff</h3>
      <button
        type="button"
        onClick={() =>
          void load().catch((error) => setError(errorMessage(error)))
        }
      >
        Refresh staff
      </button>
      {staff.map((user) => (
        <StaffAccess
          key={`${user.id}:${user.version}`}
          user={user}
          onSaved={async () => {
            await refreshSession();
            await load();
          }}
        />
      ))}
    </>
  );
}
