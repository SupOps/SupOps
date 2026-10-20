import { StrictMode, Suspense, useEffect } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './styles.css';
import { dismissSplash, registerServiceWorker } from './lib/pwa';
import { api } from './lib/api';
import { useApp } from './lib/store';
import { Layout } from './components/Layout';
import { lazyPage } from './lib/lazyPage';

// Each page is its own file, fetched on first visit, so opening SupOps downloads only
// the shell and the page you land on.
const Login = lazyPage(() => import('./pages/Login'), 'Login');
const Dashboard = lazyPage(() => import('./pages/Dashboard'), 'Dashboard');
const Console = lazyPage(() => import('./pages/Console'), 'Console');
const Call = lazyPage(() => import('./pages/Call'), 'Call');
const Investigate = lazyPage(() => import('./pages/Investigate'), 'Investigate');
const Runs = lazyPage(() => import('./pages/Runs'), 'Runs');
const RunDetail = lazyPage(() => import('./pages/RunDetail'), 'RunDetail');
const Approvals = lazyPage(() => import('./pages/Approvals'), 'Approvals');
const Alerts = lazyPage(() => import('./pages/Alerts'), 'Alerts');
const Observability = lazyPage(() => import('./pages/Observability'), 'Observability');
const IncidentDetail = lazyPage(() => import('./pages/IncidentDetail'), 'IncidentDetail');
const Health = lazyPage(() => import('./pages/Health'), 'Health');
const Users = lazyPage(() => import('./pages/Users'), 'Users');
const Targets = lazyPage(() => import('./pages/Targets'), 'Targets');
const Agents = lazyPage(() => import('./pages/Agents'), 'Agents');
const Knowledge = lazyPage(() => import('./pages/Knowledge'), 'Knowledge');
const Settings = lazyPage(() => import('./pages/Settings'), 'Settings');
const Workflows = lazyPage(() => import('./pages/Workflows'), 'Workflows');
const Learning = lazyPage(() => import('./pages/Learning'), 'Learning');
const Services = lazyPage(() => import('./pages/Services'), 'Services');
const ServiceDetailPage = lazyPage(() => import('./pages/Services'), 'ServiceDetailPage');
const Slos = lazyPage(() => import('./pages/Slos'), 'Slos');
const Synthetics = lazyPage(() => import('./pages/Synthetics'), 'Synthetics');

const queryClient = new QueryClient({
  defaultOptions: { queries: { retry: 1, refetchOnWindowFocus: false } },
});

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { token, user, setUser, signOut } = useApp();
  const location = useLocation();

  // Restore the session on a hard refresh: the token is in localStorage but the
  // profile is not, so confirm it with the server rather than trusting the JWT body.
  useEffect(() => {
    if (!token || user) return;
    api<{ user: NonNullable<typeof user> }>('/auth/me')
      .then((r) => setUser(r.user))
      .catch(() => signOut());
  }, [token, user, setUser, signOut]);

  if (!token) return <Navigate to="/login" state={{ from: location }} replace />;
  return <>{children}</>;
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <Routes>
          <Route
            path="/login"
            element={
              <Suspense fallback={null}>
                <Login />
              </Suspense>
            }
          />
          <Route
            element={
              <RequireAuth>
                <Layout />
              </RequireAuth>
            }
          >
            <Route path="/" element={<Dashboard />} />
            <Route path="/investigate" element={<Investigate />} />
            <Route path="/console" element={<Console />} />
            <Route path="/call" element={<Call />} />
            <Route path="/runs" element={<Runs />} />
            <Route path="/runs/:id" element={<RunDetail />} />
            <Route path="/approvals" element={<Approvals />} />
            <Route path="/alerts" element={<Alerts />} />
            <Route path="/observability" element={<Observability />} />
            <Route path="/observability/incidents/:id" element={<IncidentDetail />} />
            <Route path="/health" element={<Health />} />
            <Route path="/targets" element={<Targets />} />
            <Route path="/agents" element={<Agents />} />
            <Route path="/knowledge" element={<Knowledge />} />
            <Route path="/users" element={<Users />} />
            <Route path="/settings" element={<Settings />} />
            <Route path="/workflows" element={<Workflows />} />
            <Route path="/learning" element={<Learning />} />
            <Route path="/services" element={<Services />} />
            <Route path="/services/:name" element={<ServiceDetailPage />} />
            <Route path="/slos" element={<Slos />} />
            <Route path="/synthetics" element={<Synthetics />} />
          </Route>
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);

registerServiceWorker();
dismissSplash();
