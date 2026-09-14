import express from 'express';
import cors from 'cors';
import cookieParser from 'cookie-parser';
import path from 'node:path';
import fs from 'node:fs';
import { config } from './lib/config.ts';
import { applySchema, get } from './lib/db.ts';
import { registerAutomationEngine } from './lib/automation.ts';
import { startScheduler } from './jobs/scheduler.ts';
import { authenticate } from './middleware/context.ts';
import { errorHandler, notFoundHandler, ah } from './middleware/errors.ts';
import { rateLimit } from './middleware/rateLimit.ts';
import { authRouter, shapeUser } from './routes/auth.ts';
import { leadsRouter } from './routes/leads.ts';
import { dashboardRouter } from './routes/dashboard.ts';
import { pipelineRouter } from './routes/pipeline.ts';
import { tasksRouter, appointmentsRouter, calendarRouter } from './routes/tasks.ts';
import { quotationsRouter } from './routes/quotations.ts';
import { surveysRouter, documentsRouter } from './routes/surveys.ts';
import { customersRouter, projectsRouter } from './routes/customers.ts';
import { analyticsRouter } from './routes/analytics.ts';
import { settingsRouter } from './routes/settings.ts';
import { automationsRouter } from './routes/automations.ts';
import { notificationsRouter } from './routes/notifications.ts';
import { messagesRouter } from './routes/messages.ts';
import { publicRouter } from './routes/public.ts';
import { dataRouter } from './routes/data.ts';
import { aiRouter } from './routes/ai.ts';
import { onboardingRouter } from './routes/onboarding.ts';
import { getSubscription } from './lib/billing.ts';
import { parseJson } from './lib/db.ts';
import { isAiAvailable } from './lib/ai.ts';
import { syncAllOrgDefaults } from './lib/provision.ts';

applySchema();
// New default templates and automation rules reach existing companies too.
syncAllOrgDefaults();
registerAutomationEngine();

const app = express();
app.set('trust proxy', 1);
app.disable('x-powered-by');

app.use(cors({ origin: config.corsOrigins, credentials: true }));
app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: true, limit: '1mb' }));
app.use(cookieParser());

app.use((_req, res, next) => {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'strict-origin-when-cross-origin');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  next();
});

app.get('/api/health', (_req, res) => {
  res.json({ ok: true, service: 'voltaflow', time: new Date().toISOString() });
});

// --- public, unauthenticated surface --------------------------------------
app.use('/api/public', publicRouter);
app.get('/embed.js', (req, res, next) => { req.url = '/embed.js'; publicRouter(req, res, next); });

// --- authenticated API ----------------------------------------------------
app.use('/api/auth', authRouter);

const api = express.Router();
api.use(authenticate);
api.use(rateLimit({ name: 'api', windowMs: 60_000, max: 600, key: (req) => req.ctx?.user.id ?? req.ip ?? 'anon' }));

/** Everything the client needs to boot: user, org, permissions, plan, taxonomies. */
api.get('/me', ah((req, res) => {
  const org = get<any>('SELECT * FROM organizations WHERE id = ?', [req.ctx.orgId]);
  res.json({
    user: shapeUser(req.ctx.user),
    organization: {
      id: org.id, name: org.name, logo_url: org.logo_url, currency: org.currency,
      services: parseJson<string[]>(org.services, []), vat_rate: org.vat_rate,
      onboarding_done: !!org.onboarding_done, onboarding_step: org.onboarding_step,
      demo_data_loaded: !!org.demo_data_loaded, public_form_token: org.public_form_token,
      timezone: org.timezone, stale_lead_hours: org.stale_lead_hours,
    },
    subscription: getSubscription(req.ctx.orgId),
    ai_available: isAiAvailable(req.ctx.orgId),
    notification_count: get<{ n: number }>(
      'SELECT COUNT(*) AS n FROM notifications WHERE org_id = ? AND user_id = ? AND read_at IS NULL',
      [req.ctx.orgId, req.ctx.user.id],
    )?.n ?? 0,
  });
}));

api.use('/dashboard', dashboardRouter);
api.use('/leads', leadsRouter);
api.use('/pipeline', pipelineRouter);
api.use('/tasks', tasksRouter);
api.use('/appointments', appointmentsRouter);
api.use('/calendar', calendarRouter);
api.use('/quotations', quotationsRouter);
api.use('/surveys', surveysRouter);
api.use('/documents', documentsRouter);
api.use('/customers', customersRouter);
api.use('/projects', projectsRouter);
api.use('/analytics', analyticsRouter);
api.use('/settings', settingsRouter);
api.use('/automations', automationsRouter);
api.use('/notifications', notificationsRouter);
api.use('/messages', messagesRouter);
api.use('/data', dataRouter);
api.use('/ai', aiRouter);
api.use('/onboarding', onboardingRouter);

app.use('/api', api);

// --- static client (production build) -------------------------------------
const clientDir = path.resolve(import.meta.dirname, '../../web/dist');
if (fs.existsSync(clientDir)) {
  app.use(express.static(clientDir, { maxAge: '1h', index: false }));
  app.get(/^(?!\/api).*/, (_req, res) => {
    res.sendFile(path.join(clientDir, 'index.html'));
  });
}

app.use('/api', notFoundHandler);
app.use(errorHandler);

const server = app.listen(config.port, () => {
  console.log(`VoltaFlow API listening on http://localhost:${config.port} (${config.env})`);
  if (fs.existsSync(clientDir)) console.log(`Serving the client from ${clientDir}`);
});

const scheduler = startScheduler();

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    console.log(`\n${signal} received, shutting down.`);
    scheduler.stop();
    server.close(() => process.exit(0));
  });
}

export { app };
