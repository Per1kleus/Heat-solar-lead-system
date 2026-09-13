import { Router } from 'express';
import { z } from 'zod';
import { all, get, insert } from '../lib/db.ts';
import { ah } from '../middleware/errors.ts';
import { requirePermission } from '../middleware/context.ts';
import { getIntegration, sendMessage } from '../lib/messaging.ts';
import { loadLead, logActivity, rescoreLead } from '../lib/leads.ts';
import { assertVisible } from './leads.ts';
import { badRequest } from '../lib/errors.ts';
import { newId } from '../lib/ids.ts';
import { nowIso } from '../lib/time.ts';

export const messagesRouter = Router();

/** Which channels this organisation can actually use right now. */
messagesRouter.get('/channels', ah((req, res) => {
  const smtp = getIntegration(req.ctx.orgId, 'smtp');
  const whatsapp = getIntegration(req.ctx.orgId, 'whatsapp_cloud');
  const telephony = getIntegration(req.ctx.orgId, 'telephony');
  res.json({
    channels: [
      {
        key: 'email', label: 'Email',
        connected: smtp?.status === 'connected',
        status: smtp?.status ?? 'disconnected',
        error: smtp?.last_error ?? null,
        hint: 'Connect your mailbox in Settings → Communication to send email from VoltaFlow.',
      },
      {
        key: 'whatsapp', label: 'WhatsApp',
        connected: whatsapp?.status === 'connected',
        status: whatsapp?.status ?? 'disconnected',
        error: whatsapp?.last_error ?? null,
        hint: 'WhatsApp is not connected. Connect WhatsApp Business in Settings → Communication to enable this feature.',
      },
      {
        key: 'phone', label: 'Phone',
        // Click-to-call always works through the device; the integration only adds
        // automatic call logging.
        connected: true,
        status: telephony?.status ?? 'disconnected',
        error: null,
        hint: telephony?.status === 'connected'
          ? 'Calls are logged automatically by your telephony provider.'
          : 'Calls open on your device and are logged manually. Connect a telephony provider for automatic logging.',
      },
    ],
  });
}));

messagesRouter.get('/', requirePermission('messages:read'), ah((req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const where = ['m.org_id = ?'];
  const params: any[] = [req.ctx.orgId];
  if (q.lead_id) { where.push('m.lead_id = ?'); params.push(q.lead_id); }
  if (q.channel) { where.push('m.channel = ?'); params.push(q.channel); }
  if (q.status) { where.push('m.status = ?'); params.push(q.status); }
  if (!req.ctx.seesAll()) {
    where.push('(m.user_id = ? OR m.lead_id IN (SELECT id FROM leads WHERE owner_id = ?))');
    params.push(req.ctx.user.id, req.ctx.user.id);
  }
  res.json({
    messages: all(
      `SELECT m.*, l.first_name AS lead_first_name, l.last_name AS lead_last_name,
              u.first_name AS user_first_name, u.last_name AS user_last_name
       FROM messages m
       LEFT JOIN leads l ON l.id = m.lead_id
       LEFT JOIN users u ON u.id = m.user_id
       WHERE ${where.join(' AND ')} ORDER BY m.created_at DESC LIMIT ?`,
      [...params, Math.min(Number(q.limit ?? 100), 300)],
    ),
  });
}));

messagesRouter.post('/send', requirePermission('messages:send'), ah(async (req, res) => {
  const body = z.object({
    lead_id: z.string(),
    channel: z.enum(['email', 'whatsapp']),
    to: z.string().optional(),
    subject: z.string().optional(),
    body: z.string().min(1, 'Write a message first.'),
    purpose: z.enum(['operational', 'marketing']).default('operational'),
  }).parse(req.body);

  const lead = loadLead(req.ctx.orgId, body.lead_id);
  assertVisible(req, lead);
  const to = body.to ?? (body.channel === 'email' ? lead.email : lead.phone);
  if (!to) throw badRequest(`This lead has no ${body.channel === 'email' ? 'email address' : 'phone number'} on file.`);

  const result = await sendMessage({
    orgId: req.ctx.orgId,
    channel: body.channel,
    leadId: lead.id,
    customerId: lead.customer_id,
    to,
    subject: body.subject ?? null,
    body: body.body,
    purpose: body.purpose,
    userId: req.ctx.user.id,
  });

  if (!result.sent) {
    // The message row is kept with status "blocked"/"failed" so the timeline shows
    // the attempt and the reason — nothing is reported as delivered.
    return res.status(409).json({
      error: { code: 'not_sent', message: result.reason ?? 'The message could not be sent.' },
      message_id: result.messageId,
    });
  }
  rescoreLead(req.ctx.orgId, lead.id);
  res.status(201).json({
    ok: true,
    message: get('SELECT * FROM messages WHERE id = ?', [result.messageId]),
  });
}));

/**
 * Click-to-call: returns the tel: target and opens a pending call the
 * salesperson closes with an outcome. Nothing claims a call happened until
 * the outcome is logged.
 */
messagesRouter.post('/call', requirePermission('messages:send'), ah((req, res) => {
  const body = z.object({ lead_id: z.string() }).parse(req.body);
  const lead = loadLead(req.ctx.orgId, body.lead_id);
  assertVisible(req, lead);
  if (!lead.phone) throw badRequest('This lead has no phone number on file.');
  const telephony = getIntegration(req.ctx.orgId, 'telephony');
  res.json({
    tel: `tel:${lead.phone.replace(/\s+/g, '')}`,
    whatsapp: `https://wa.me/${lead.phone.replace(/[^\d]/g, '')}`,
    auto_logging: telephony?.status === 'connected',
    note: telephony?.status === 'connected'
      ? 'Your telephony provider will log this call automatically.'
      : 'Log the outcome when the call ends so the timeline stays complete.',
  });
}));

/** Records an inbound message that arrived outside VoltaFlow. */
messagesRouter.post('/inbound', requirePermission('messages:send'), ah((req, res) => {
  const body = z.object({
    lead_id: z.string(),
    channel: z.enum(['email', 'whatsapp', 'sms', 'phone']),
    body: z.string().min(1),
    subject: z.string().optional(),
    occurred_at: z.string().optional(),
  }).parse(req.body);
  const lead = loadLead(req.ctx.orgId, body.lead_id);
  assertVisible(req, lead);

  const id = newId('msg');
  insert('messages', {
    id, org_id: req.ctx.orgId, lead_id: lead.id, customer_id: lead.customer_id,
    channel: body.channel, direction: 'inbound', from_address: lead.email ?? lead.phone,
    subject: body.subject ?? null, body: body.body, purpose: 'operational',
    status: 'received', user_id: req.ctx.user.id, created_at: nowIso(),
  });
  logActivity({
    orgId: req.ctx.orgId, leadId: lead.id, type: body.channel, direction: 'inbound',
    title: `${body.channel === 'phone' ? 'Inbound call' : 'Reply received'} from ${lead.first_name}`,
    body: body.body, meta: { message_id: id }, userId: req.ctx.user.id,
    occurredAt: body.occurred_at, isCustomerTouch: true,
  });
  rescoreLead(req.ctx.orgId, lead.id);
  res.status(201).json({ message: get('SELECT * FROM messages WHERE id = ?', [id]) });
}));
