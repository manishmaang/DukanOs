import { OperationalAudioProvider } from './OperationalAudio';
import { useVisualViewport } from './useVisualViewport';
import { Dispatch } from './Dispatch';
import { Kitchen } from './Kitchen';
import { MenuAdmin, MenuPreview } from './Menu';
import { ChangePassword, StaffPasswordResets } from './PasswordManagement';
import {
  StrictMode,
  useCallback,
  useEffect,
  useRef,
  useState,
  type FormEvent,
} from 'react';
import { createRoot } from 'react-dom/client';
import {
  HashRouter,
  NavLink,
  Route,
  Routes,
  useLocation,
  useNavigate,
} from 'react-router-dom';
import type { AuthenticatedUser } from '@dukanos/shared-types';
import { allowedWorkspaces } from './workspaces';
import { api, ApiFailure, errorMessage } from './api';
import { StaffAdmin } from './StaffAdmin';
import './styles.css';
function Login({ onLogin }: { onLogin: (user: AuthenticatedUser) => void }) {
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const data = new FormData(event.currentTarget);
    setError('');
    setBusy(true);
    try {
      onLogin(
        await api<AuthenticatedUser>('/auth/login', 'POST', {
          username: data.get('username'),
          password: data.get('password'),
        }),
      );
    } catch (error) {
      setError(errorMessage(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <section>
      <h1>Staff sign in</h1>
      <p>Use your restaurant staff account.</p>
      <form onSubmit={submit}>
        <label>
          Username
          <input
            name="username"
            autoComplete="username"
            required
            minLength={3}
            maxLength={64}
          />
        </label>
        <label>
          Password
          <input
            name="password"
            type="password"
            autoComplete="current-password"
            required
            maxLength={128}
          />
        </label>
        {error && <p role="alert">{error}</p>}
        <button disabled={busy}>{busy ? 'Signing in…' : 'Sign in'}</button>
      </form>
    </section>
  );
}
function App() {
  useVisualViewport();
  const location = useLocation();
  const navigate = useNavigate();
  const [user, setUser] = useState<AuthenticatedUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const sessionRequest = useRef(0);
  const refreshSession = useCallback(async () => {
    const request = ++sessionRequest.current;
    try {
      const current = await api<AuthenticatedUser>('/auth/me');
      if (request !== sessionRequest.current) return;
      setUser(current);
      setError('');
    } catch (error) {
      if (request !== sessionRequest.current) return;
      if (error instanceof ApiFailure && error.status === 401) {
        setUser(null);
        setError('');
      } else setError(errorMessage(error));
    } finally {
      if (request === sessionRequest.current) setLoading(false);
    }
  }, []);
  useEffect(() => {
    void refreshSession();
    const focus = () => void refreshSession();
    window.addEventListener('focus', focus);
    const timer = window.setInterval(focus, 30000);
    return () => {
      window.removeEventListener('focus', focus);
      window.clearInterval(timer);
    };
  }, [refreshSession]);
  async function logout() {
    try {
      await api('/auth/logout', 'POST');
      for (const key of Object.keys(sessionStorage))
        if (key.startsWith('dukanos-alerts:')) sessionStorage.removeItem(key);
      sessionRequest.current++;
      setUser(null);
    } catch (error) {
      if (error instanceof ApiFailure && error.status === 401) {
        sessionRequest.current++;
        setUser(null);
      } else setError(errorMessage(error));
    }
  }
  const links = user ? allowedWorkspaces(user) : [];
  return (
    <div className="layout">
      <header>
        <strong>DukanOS</strong>
        {user && (
          <div>
            <span>
              {user.name} · {user.roles.join(' + ')}
            </span>{' '}
            <button onClick={() => void logout()}>Sign out</button>
          </div>
        )}
      </header>
      {error && <p role="alert">{error}</p>}
      {notice && <p role="status">{notice}</p>}
      {loading ? (
        <p role="status">Checking your session…</p>
      ) : !user ? (
        <Login
          onLogin={(current) => {
            sessionRequest.current++;
            setError('');
            setNotice('');
            setUser(current);
          }}
        />
      ) : (
        <OperationalAudioProvider key={user.id} permissions={user.permissions}>
          <label className="workspace-switcher">
            Workspace
            <select
              aria-label="Workspace"
              value={
                [
                  '/',
                  '/account/password',
                  ...links.map((l) => l.path),
                ].includes(location.pathname)
                  ? location.pathname
                  : ''
              }
              onChange={(event) => navigate(event.target.value)}
            >
              <option value="" disabled>
                Choose workspace
              </option>
              <option value="/">Overview</option>
              {links.map((link) => (
                <option key={link.path} value={link.path}>
                  {link.label}
                </option>
              ))}
              <option value="/account/password">Change Password</option>
            </select>
          </label>
          <nav aria-label="Workspaces">
            <NavLink to="/" end>
              Overview
            </NavLink>
            {links.map((link) => (
              <NavLink key={link.path} to={link.path}>
                {link.label}
              </NavLink>
            ))}
            <NavLink to="/account/password">Change Password</NavLink>
          </nav>
          <main>
            <Routes>
              <Route
                path="/account/password"
                element={
                  <ChangePassword
                    onChanged={() => {
                      sessionRequest.current++;
                      setUser(null);
                      setError('');
                      setNotice(
                        'Password changed. Sign in again with your new password.',
                      );
                    }}
                  />
                }
              />

              <Route
                path="/"
                element={
                  <section>
                    <h1>Welcome, {user.name}</h1>
                    <p>
                      Choose a workspace above. You can switch screens without
                      signing out.
                    </p>
                  </section>
                }
              />
              {links.map((link) => (
                <Route
                  key={link.path}
                  path={link.path}
                  element={
                    link.path === '/dispatch' ? (
                      <Dispatch
                        canCollect={user.permissions.includes(
                          'payments.collect',
                        )}
                        key={user.id}
                        canComplete={user.permissions.includes(
                          'dispatch.complete',
                        )}
                      />
                    ) : link.path === '/kitchen' ? (
                      <Kitchen
                        userId={user.id}
                        canReadTimers={user.permissions.includes(
                          'kitchen.timers.read',
                        )}
                        canManageTimers={user.permissions.includes(
                          'kitchen.timers.manage',
                        )}
                        key={user.id}
                        canUpdate={user.permissions.includes('kitchen.update')}
                        canManageAvailability={user.permissions.includes(
                          'menu.availability.manage',
                        )}
                      />
                    ) : link.path === '/menu' ? (
                      <MenuAdmin />
                    ) : link.path === '/pos' &&
                      user.permissions.includes('menu.read') ? (
                      <MenuPreview
                        canReadReminders={user.permissions.includes(
                          'bills.reminders.read',
                        )}
                        canManageReminders={user.permissions.includes(
                          'bills.reminders.manage',
                        )}
                        canReadBills={user.permissions.includes('bills.read')}
                        canCollectPayments={user.permissions.includes(
                          'payments.collect',
                        )}
                        canManageBills={user.permissions.includes(
                          'bills.manage',
                        )}
                        key={user.id}
                        userId={user.id}
                        canCreateOrders={user.permissions.includes(
                          'orders.create',
                        )}
                        canManageAvailability={user.permissions.includes(
                          'menu.availability.manage',
                        )}
                      />
                    ) : (
                      <section>
                        <h1>{link.label}</h1>
                        {link.path === '/admin' &&
                        (user.permissions.includes('users.manage') ||
                          user.permissions.includes('menu.manage') ||
                          user.permissions.includes('users.password.reset')) ? (
                          <>
                            {user.permissions.includes('users.manage') && (
                              <StaffAdmin refreshSession={refreshSession} />
                            )}
                            {user.permissions.includes(
                              'users.password.reset',
                            ) && <StaffPasswordResets />}
                            {user.permissions.includes('menu.manage') && (
                              <p>
                                Manage dishes, prices and availability in the{' '}
                                <NavLink to="/menu">Menu workspace</NavLink>.
                              </p>
                            )}
                          </>
                        ) : (
                          <p className="notice">
                            This workspace is under construction. Operational
                            features are not available yet.
                          </p>
                        )}
                      </section>
                    )
                  }
                />
              ))}
              <Route
                path="*"
                element={
                  <section>
                    <h1>Workspace unavailable</h1>
                    <p>Choose one of your permitted workspaces above.</p>
                  </section>
                }
              />
            </Routes>
          </main>
        </OperationalAudioProvider>
      )}
      <footer>Single-location restaurant workspace</footer>
    </div>
  );
}
createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <HashRouter>
      <App />
    </HashRouter>
  </StrictMode>,
);
