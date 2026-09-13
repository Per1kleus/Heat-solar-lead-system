import { Router } from 'express';
import { z } from 'zod';
import { all, get, insert, parseJson, run } from '../lib/db.ts';
import { ah } from '../middleware/errors.ts';
import { requirePermission } from '../middleware/context.ts';
import { newId, randomToken, sha256 } from '../lib/ids.ts';
import { nowIso } from '../lib/time.ts';
import { hashPassword } from '../lib/auth.ts';
import { nextAvatarColor } from '../lib/provision.ts';
import { assertSeatAllowance } from '../lib/billing.ts';
import { badRequest } from '../lib/errors.ts';
import { seedDemoData } from '../db/demo.ts';
import { getIntegration } from '../lib/messaging.ts';

export const onboardingRouter = Router();

export const ONBOARDING_STEPS = [
  { key: 'company', title: 'Company information', description: 'Your name, logo and details as they appear on every quotation.' },
  { key: 'services', title: 'What you install', description: 'Only the relevant technical questions are then shown on leads and forms.' },
  { key: 'team', title: 'Add your team', description: 'Salespeople, a sales manager and your installation technicians.' },
  { key: 'pipeline', title: 'Configure your pipeline', description: 'Stages and the win probability each one carries.' },
  { key: 'communication', title: 'Connect communication', description: 'Email first, then WhatsApp and telephony when you are ready.' },
  { key: 'form', title: 'Create your lead form', description: 'A form for your website that drops enquiries straight into the pipeline.' },
  { key: 'import', title: 'Import existing leads', description: 'Bring your current spreadsheet in so nothing is left behind.' },
  { key: 'automation', title: 'Follow-up sequence', description: 'Check the rules that make sure no lead is forgotten.' },
  { key: 'ready', title: 'Dashboard ready', description: 'You are set up. Load sample data if you want to explore first.' },
];

onboardingRouter.get('/', ah((req, res) => {
  const org = get<any>('SELECT * FROM organizations WHERE id = ?', [req.ctx.orgId]);
  const users = all<any>(
    "SELECT id, first_name, last_name, email, role, status FROM users WHERE org_id = ? ORDER BY created_at", [req.ctx.orgId],
  );
  const stages = all<any>('SELECT * FROM pipeline_stages WHERE org_id = ? AND is_active = 1 ORDER BY position', [req.ctx.orgId]);
  const rules = all<any>('SELECT id, name, description, trigger_type, is_active FROM automation_rules WHERE org_id = ? ORDER BY created_at', [req.ctx.orgId]);
  const leadCount = get<{ n: number }>('SELECT COUNT(*) AS n FROM leads WHERE org_id = ? AND deleted_at IS NULL', [req.ctx.orgId])?.n ?? 0;

  res.json({
    steps: ONBOARDING_STEPS,
    current_step: org.onboarding_step,
    complete: !!org.onboarding_done,
    company: { ...org, services: parseJson<string[]>(org.services, []) },
    users: users.map((u) => ({ ...u, full_name: `${u.first_name} ${u.last_name}` })),
    stages,
    automation_rules: rules.map((r) => ({ ...r, is_active: !!r.is_active })),
    integrations: {
      email: getIntegration(req.ctx.orgId, 'smtp')?.status ?? 'disconnected',
      whatsapp: getIntegration(req.ctx.orgId, 'whatsapp_cloud')?.status ?? 'disconnected',
      ai: getIntegration(req.ctx.orgId, 'anthropic')?.status ?? 'disconnected',
    },
    lead_count: leadCount,
    demo_data_loaded: !!org.demo_data_loaded,
    form_token: org.public_form_token,
  });
}));

onboardingRouter.post('/step', requirePermission('settings:write'), ah((req, res) => {
  const { step, complete } = z.object({
    step: z.number().int().min(0).max(ONBOARDING_STEPS.length - 1),
    complete: z.boolean().optional(),
  }).parse(req.body);
  run('UPDATE organizations SET onboarding_step = ?, onboarding_done = ?, updated_at = ? WHERE id = ?', [
    step, complete ? 1 : 0, nowIso(), req.ctx.orgId,
  ]);
  res.json({ ok: true, current_step: step, complete: Boolean(complete) });
}));

/** Bulk-invite the team during onboarding without leaving the wizard. */
onboardingRouter.post('/team', requirePermission('users:write'), ah((req, res) => {
  const { members } = z.object({
    members: z.array(z.object({
      first_name: z.string().min(1),
      last_name: z.string().default(''),
      email: z.string().email(),
      role: z.enum(['admin', 'sales_manager', 'salesperson', 'technician']),
      password: z.string().min(10).optional(),
    })).min(1),
  }).parse(req.body);

  const created: any[] = [];
  const skipped: { email: string; reason: string }[] = [];
  for (const member of members) {
    const email = member.email.trim().toLowerCase();
    if (get('SELECT 1 FROM users WHERE email = ?', [email])) {
      skipped.push({ email, reason: 'Someone already uses that email address.' });
      continue;
    }
    try {
      assertSeatAllowance(req.ctx.orgId);
    } catch (err) {
      skipped.push({ email, reason: err instanceof Error ? err.message : 'Seat limit reached.' });
      continue;
    }
    const id = newId('usr');
    const now = nowIso();
    const inviteToken = member.password ? null : randomToken(24);
    insert('users', {
      id, org_id: req.ctx.orgId, email,
      password_hash: hashPassword(member.password ?? randomToken(24)),
      first_name: member.first_name, last_name: member.last_name,
      avatar_color: nextAvatarColor(req.ctx.orgId), role: member.role,
      status: member.password ? 'active' : 'invited',
      invite_token: inviteToken ? sha256(inviteToken) : null,
      created_at: now, updated_at: now,
    });
    created.push({
      id, email, first_name: member.first_name, last_name: member.last_name, role: member.role,
      invite_link: inviteToken ? `/accept-invite?token=${inviteToken}` : null,
    });
  }
  res.status(201).json({
    created, skipped,
    email_connected: getIntegration(req.ctx.orgId, 'smtp')?.status === 'connected',
    note: getIntegration(req.ctx.orgId, 'smtp')?.status === 'connected'
      ? 'Invitations can be emailed from your connected mailbox.'
      : 'Email is not connected yet, so share each invite link with your colleague directly.',
  });
}));

onboardingRouter.post('/demo-data', requirePermission('settings:write'), ah((req, res) => {
  const existing = get<{ n: number }>('SELECT COUNT(*) AS n FROM leads WHERE org_id = ?', [req.ctx.orgId])?.n ?? 0;
  if (existing > 0) {
    const org = get<{ demo_data_loaded: number }>('SELECT demo_data_loaded FROM organizations WHERE id = ?', [req.ctx.orgId]);
    if (org?.demo_data_loaded) throw badRequest('Sample data is already loaded. Remove it first from Settings.');
  }
  const result = seedDemoData(req.ctx.orgId, req.ctx.user.id);
  res.json({ ok: true, ...result });
}));
