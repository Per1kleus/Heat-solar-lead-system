import { StrictMode, Suspense, lazy } from 'react';
import { createRoot } from 'react-dom/client';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import './styles/app.css';
import { SessionProvider, useSession } from './lib/session';
import { ToastProvider, LoadingBlock } from './components/ui';
import Layout from './components/Layout';
import Landing from './pages/Landing';
import Login from './pages/Login';
import Signup from './pages/Signup';
import ForgotPassword from './pages/ForgotPassword';
import AcceptInvite from './pages/AcceptInvite';
import PublicForm from './pages/PublicForm';
import PublicQuote from './pages/PublicQuote';
import Dashboard from './pages/Dashboard';
import Leads from './pages/Leads';
import LeadDetail from './pages/LeadDetail';
import Pipeline from './pages/Pipeline';
import Tasks from './pages/Tasks';
import Calendar from './pages/Calendar';
import Quotations from './pages/Quotations';
import QuotationDetail from './pages/QuotationDetail';
import Surveys from './pages/Surveys';
import SurveyDetail from './pages/SurveyDetail';
import Customers from './pages/Customers';
import CustomerDetail from './pages/CustomerDetail';
import Projects from './pages/Projects';
import Notifications from './pages/Notifications';
import Onboarding from './pages/Onboarding';

const Analytics = lazy(() => import('./pages/Analytics'));
const Recovery = lazy(() => import('./pages/Recovery'));
const Automations = lazy(() => import('./pages/Automations'));
const Settings = lazy(() => import('./pages/Settings'));
const ImportLeads = lazy(() => import('./pages/ImportLeads'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (failureCount, error: any) => (error?.status >= 400 && error?.status < 500 ? false : failureCount < 2),
      refetchOnWindowFocus: false,
      staleTime: 30_000,
    },
  },
});

function RequireAuth({ children }: { children: React.ReactNode }) {
  const { user, loading, organization } = useSession();
  const location = useLocation();

  if (loading) {
    return (
      <div className="page" style={{ maxWidth: 640, paddingTop: 60 }}>
        <LoadingBlock rows={3} height={60} />
      </div>
    );
  }
  if (!user) return <Navigate to="/login" state={{ from: location.pathname }} replace />;
  // A brand-new company lands in the setup wizard until it is finished.
  if (organization && !organization.onboarding_done && !location.pathname.startsWith('/app/setup')) {
    return <Navigate to="/app/setup" replace />;
  }
  return <>{children}</>;
}

function PublicOnly({ children }: { children: React.ReactNode }) {
  const { user, loading } = useSession();
  if (loading) return null;
  if (user) return <Navigate to="/app" replace />;
  return <>{children}</>;
}

function App() {
  return (
    <Routes>
      <Route path="/" element={<Landing />} />
      <Route path="/login" element={<PublicOnly><Login /></PublicOnly>} />
      <Route path="/signup" element={<PublicOnly><Signup /></PublicOnly>} />
      <Route path="/forgot-password" element={<ForgotPassword />} />
      <Route path="/accept-invite" element={<AcceptInvite />} />
      <Route path="/f/:token" element={<PublicForm />} />
      <Route path="/q/:token" element={<PublicQuote />} />

      <Route
        path="/app/*"
        element={
          <RequireAuth>
            <Routes>
              <Route path="setup" element={<Onboarding />} />
              <Route
                path="*"
                element={
                  <Layout>
                    <Suspense fallback={<div className="page"><LoadingBlock rows={4} height={70} /></div>}>
                      <Routes>
                        <Route index element={<Dashboard />} />
                        <Route path="leads" element={<Leads />} />
                        <Route path="leads/:id" element={<LeadDetail />} />
                        <Route path="pipeline" element={<Pipeline />} />
                        <Route path="tasks" element={<Tasks />} />
                        <Route path="calendar" element={<Calendar />} />
                        <Route path="quotations" element={<Quotations />} />
                        <Route path="quotations/:id" element={<QuotationDetail />} />
                        <Route path="surveys" element={<Surveys />} />
                        <Route path="surveys/:id" element={<SurveyDetail />} />
                        <Route path="customers" element={<Customers />} />
                        <Route path="customers/:id" element={<CustomerDetail />} />
                        <Route path="projects" element={<Projects />} />
                        <Route path="projects/:id" element={<Projects />} />
                        <Route path="analytics" element={<Analytics />} />
                        <Route path="recovery" element={<Recovery />} />
                        <Route path="automations" element={<Automations />} />
                        <Route path="notifications" element={<Notifications />} />
                        <Route path="import" element={<ImportLeads />} />
                        <Route path="settings/*" element={<Settings />} />
                        <Route path="*" element={<NotFound />} />
                      </Routes>
                    </Suspense>
                  </Layout>
                }
              />
            </Routes>
          </RequireAuth>
        }
      />

      <Route path="*" element={<NotFound public />} />
    </Routes>
  );
}

function NotFound({ public: isPublic }: { public?: boolean }) {
  return (
    <div className={isPublic ? 'auth-shell' : 'page'}>
      <div className="card" style={{ maxWidth: 440, padding: 28, textAlign: 'center' }}>
        <h1 style={{ marginBottom: 6 }}>Page not found</h1>
        <p className="muted">That page does not exist or you no longer have access to it.</p>
        <a className="btn primary" href={isPublic ? '/' : '/app'}>{isPublic ? 'Back to the homepage' : 'Back to the dashboard'}</a>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <BrowserRouter>
        <SessionProvider>
          <ToastProvider>
            <App />
          </ToastProvider>
        </SessionProvider>
      </BrowserRouter>
    </QueryClientProvider>
  </StrictMode>,
);
