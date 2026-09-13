import { Router } from 'express';
import { z } from 'zod';
import fs from 'node:fs';
import { all, get, run } from '../lib/db.ts';
import { ah } from '../middleware/errors.ts';
import { requirePermission } from '../middleware/context.ts';
import {
  createQuotation, loadQuotation, markSent, setQuotationStatus, updateQuotation, computeTotals,
} from '../lib/quotations.ts';
import { renderQuotationPdf } from '../lib/pdf.ts';
import { sendMessage, getIntegration } from '../lib/messaging.ts';
import { render } from '../lib/render.ts';
import { forbidden, notFound, badRequest } from '../lib/errors.ts';
import { nowIso } from '../lib/time.ts';
import { readIdempotent, writeIdempotent } from '../lib/idempotency.ts';
import { audit } from '../lib/audit.ts';

export const quotationsRouter = Router();

const itemSchema = z.object({
  category: z.string().default('equipment'),
  name: z.string().min(1, 'Every line needs a description.'),
  description: z.string().nullish(),
  quantity: z.number().positive('Quantity must be greater than zero.'),
  unit: z.string().default('pcs'),
  unit_price: z.number().nonnegative(),
  discount_pct: z.number().min(0).max(100).default(0),
  is_optional: z.boolean().default(false),
  position: z.number().int().optional(),
});

const quoteSchema = z.object({
  lead_id: z.string().nullish(),
  customer_id: z.string().nullish(),
  project_id: z.string().nullish(),
  title: z.string().min(1, 'Give the quotation a title.'),
  description: z.string().nullish(),
  items: z.array(itemSchema).min(1, 'Add at least one line.'),
  discount_type: z.enum(['amount', 'percent']).default('amount'),
  discount_value: z.number().min(0).default(0),
  vat_rate: z.number().min(0).max(100).optional(),
  valid_until: z.string().nullish(),
  terms: z.string().nullish(),
  notes: z.string().nullish(),
});

quotationsRouter.get('/', requirePermission('quotes:read:own', 'quotes:read:all'), ah((req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const where = ['q.org_id = ?'];
  const params: any[] = [req.ctx.orgId];
  if (!req.ctx.can('quotes:read:all')) { where.push('q.owner_id = ?'); params.push(req.ctx.user.id); }
  else if (q.owner_id) { where.push('q.owner_id = ?'); params.push(q.owner_id); }
  if (q.status) {
    const statuses = q.status.split(',').filter(Boolean);
    where.push(`q.status IN (${statuses.map(() => '?').join(',')})`);
    params.push(...statuses);
  }
  if (q.lead_id) { where.push('q.lead_id = ?'); params.push(q.lead_id); }
  if (q.search) {
    const term = `%${q.search.toLowerCase()}%`;
    where.push('(lower(q.number) LIKE ? OR lower(q.title) LIKE ? OR lower(l.first_name) LIKE ? OR lower(l.last_name) LIKE ?)');
    params.push(term, term, term, term);
  }

  const rows = all<any>(
    `SELECT q.*, l.first_name AS lead_first_name, l.last_name AS lead_last_name, l.temperature,
            u.first_name AS owner_first_name, u.last_name AS owner_last_name
     FROM quotations q LEFT JOIN leads l ON l.id = q.lead_id LEFT JOIN users u ON u.id = q.owner_id
     WHERE ${where.join(' AND ')} ORDER BY q.created_at DESC LIMIT ?`,
    [...params, Math.min(Number(q.limit ?? 100), 300)],
  );

  const buckets = all<{ status: string; n: number; total: number }>(
    `SELECT q.status, COUNT(*) AS n, COALESCE(SUM(q.total), 0) AS total FROM quotations q
     LEFT JOIN leads l ON l.id = q.lead_id
     WHERE ${where.join(' AND ')} GROUP BY q.status`,
    params,
  );

  res.json({
    quotations: rows.map((r) => ({
      ...r,
      customer_name: r.lead_first_name ? `${r.lead_first_name} ${r.lead_last_name}` : 'Unknown',
      owner_name: r.owner_first_name ? `${r.owner_first_name} ${r.owner_last_name}` : null,
      days_since_sent: r.sent_at ? Math.floor((Date.now() - new Date(r.sent_at).getTime()) / 86400000) : null,
      is_expired: r.valid_until ? new Date(r.valid_until) < new Date() : false,
    })),
    buckets,
    awaiting_value: buckets
      .filter((b) => ['sent', 'viewed', 'awaiting_response'].includes(b.status))
      .reduce((sum, b) => sum + b.total, 0),
  });
}));

quotationsRouter.post('/preview-totals', requirePermission('quotes:write'), ah((req, res) => {
  const body = z.object({
    items: z.array(itemSchema),
    discount_type: z.enum(['amount', 'percent']).default('amount'),
    discount_value: z.number().min(0).default(0),
    vat_rate: z.number().min(0).max(100).default(24),
  }).parse(req.body);
  res.json(computeTotals(body.items, body));
}));

quotationsRouter.post('/', requirePermission('quotes:write'), ah((req, res) => {
  const idempotencyKey = req.headers['idempotency-key'] as string | undefined;
  const cached = readIdempotent<any>(req.ctx.orgId, idempotencyKey);
  if (cached) return res.status(201).json(cached);

  const body = quoteSchema.parse(req.body);
  if (body.lead_id && !req.ctx.seesAll()) {
    const lead = get<{ owner_id: string }>('SELECT owner_id FROM leads WHERE id = ? AND org_id = ?', [
      body.lead_id, req.ctx.orgId,
    ]);
    if (!lead) throw notFound('That lead no longer exists.');
    if (lead.owner_id !== req.ctx.user.id) throw forbidden('This lead belongs to another salesperson.');
  }
  const quote = createQuotation({
    orgId: req.ctx.orgId,
    userId: req.ctx.user.id,
    leadId: body.lead_id,
    customerId: body.customer_id,
    projectId: body.project_id,
    title: body.title,
    description: body.description,
    items: body.items,
    discount_type: body.discount_type,
    discount_value: body.discount_value,
    vat_rate: body.vat_rate,
    valid_until: body.valid_until,
    terms: body.terms,
    notes: body.notes,
  });
  const payload = { quotation: quote };
  writeIdempotent(req.ctx.orgId, idempotencyKey, 'POST /quotations', payload);
  res.status(201).json(payload);
}));

quotationsRouter.get('/:id', requirePermission('quotes:read:own', 'quotes:read:all'), ah((req, res) => {
  const quote = loadQuotation(req.ctx.orgId, req.params.id);
  assertQuoteAccess(req, quote);
  res.json({
    quotation: quote,
    tasks: all(
      "SELECT * FROM tasks WHERE org_id = ? AND quotation_id = ? AND status = 'open' ORDER BY due_at",
      [req.ctx.orgId, quote.id],
    ),
    messages: all(
      'SELECT id, channel, status, subject, error, sent_at, created_at FROM messages WHERE org_id = ? AND quotation_id = ? ORDER BY created_at DESC',
      [req.ctx.orgId, quote.id],
    ),
  });
}));

quotationsRouter.patch('/:id', requirePermission('quotes:write'), ah((req, res) => {
  const quote = loadQuotation(req.ctx.orgId, req.params.id);
  assertQuoteAccess(req, quote);
  const body = quoteSchema.partial().parse(req.body);
  res.json({ quotation: updateQuotation(req.ctx.orgId, quote.id, req.ctx.user.id, body) });
}));

quotationsRouter.get('/:id/pdf', requirePermission('quotes:read:own', 'quotes:read:all'), ah(async (req, res) => {
  const quote = loadQuotation(req.ctx.orgId, req.params.id);
  assertQuoteAccess(req, quote);
  const path = await renderQuotationPdf(req.ctx.orgId, quote.id);
  res.setHeader('Content-Type', 'application/pdf');
  res.setHeader('Content-Disposition', `inline; filename="${quote.number}.pdf"`);
  fs.createReadStream(path).pipe(res);
}));

/**
 * Sending a quotation. `via: email` really sends through the connected mailbox
 * and fails loudly when it is not connected; `via: manual` only records that the
 * salesperson sent it themselves.
 */
quotationsRouter.post('/:id/send', requirePermission('quotes:send'), ah(async (req, res) => {
  const body = z.object({
    via: z.enum(['email', 'whatsapp', 'manual']).default('email'),
    to: z.string().optional(),
    subject: z.string().optional(),
    message: z.string().optional(),
    attach_pdf: z.boolean().default(true),
  }).parse(req.body ?? {});

  const quote = loadQuotation(req.ctx.orgId, req.params.id);
  assertQuoteAccess(req, quote);
  if (quote.items.length === 0) throw badRequest('Add at least one line before sending.');

  if (body.via === 'manual') {
    return res.json({
      quotation: markSent(req.ctx.orgId, quote.id, req.ctx.user.id, 'manual', 'Recorded as sent outside VoltaFlow.'),
      delivery: { sent: true, channel: 'manual' },
    });
  }

  const provider = body.via === 'email' ? 'smtp' : 'whatsapp_cloud';
  const integration = getIntegration(req.ctx.orgId, provider);
  if (!integration || integration.status !== 'connected') {
    return res.status(409).json({
      error: {
        code: 'not_configured',
        message: body.via === 'email'
          ? 'Email is not connected. Connect your mailbox in Settings → Communication, or record the quotation as sent manually.'
          : 'WhatsApp is not connected. Connect WhatsApp Business in Settings → Communication, or record the quotation as sent manually.',
        details: { provider },
      },
    });
  }

  const to = body.to ?? (body.via === 'email' ? quote.lead_email : quote.lead_phone);
  if (!to) throw badRequest(`The customer has no ${body.via === 'email' ? 'email address' : 'phone number'} on file.`);

  const org = get<any>('SELECT * FROM organizations WHERE id = ?', [req.ctx.orgId]);
  const template = get<any>("SELECT * FROM message_templates WHERE org_id = ? AND key = 'quote_sent'", [req.ctx.orgId]);
  const ctx = { org, company: org, quote, quotation: quote, lead: { first_name: quote.lead_first_name, last_name: quote.lead_last_name }, user: req.ctx.user };

  const attachments = body.attach_pdf
    ? [{ filename: `${quote.number}.pdf`, path: await renderQuotationPdf(req.ctx.orgId, quote.id) }]
    : undefined;

  const result = await sendMessage({
    orgId: req.ctx.orgId,
    channel: body.via,
    leadId: quote.lead_id,
    customerId: quote.customer_id,
    quotationId: quote.id,
    to,
    subject: body.subject ?? (template ? render(template.subject ?? '', ctx) : `Quotation ${quote.number}`),
    body: body.message ?? (template ? render(template.body, ctx) : `Please find quotation ${quote.number} attached.`),
    purpose: 'operational',
    userId: req.ctx.user.id,
    attachments,
  });

  if (!result.sent) {
    return res.status(502).json({
      error: { code: 'delivery_failed', message: result.reason ?? 'The message could not be delivered.' },
      quotation: quote,
    });
  }
  res.json({
    quotation: markSent(req.ctx.orgId, quote.id, req.ctx.user.id, body.via),
    delivery: { sent: true, channel: body.via, provider_message_id: result.providerMessageId },
  });
}));

quotationsRouter.post('/:id/status', requirePermission('quotes:write'), ah((req, res) => {
  const body = z.object({
    status: z.enum(['draft', 'sent', 'viewed', 'awaiting_response', 'accepted', 'rejected', 'expired', 'cancelled']),
    rejection_reason: z.string().nullish(),
  }).parse(req.body);
  const quote = loadQuotation(req.ctx.orgId, req.params.id);
  assertQuoteAccess(req, quote);
  res.json({ quotation: setQuotationStatus(req.ctx.orgId, quote.id, req.ctx.user.id, body.status, body) });
}));

quotationsRouter.post('/:id/duplicate', requirePermission('quotes:write'), ah((req, res) => {
  const quote = loadQuotation(req.ctx.orgId, req.params.id);
  assertQuoteAccess(req, quote);
  const copy = createQuotation({
    orgId: req.ctx.orgId,
    userId: req.ctx.user.id,
    leadId: quote.lead_id,
    customerId: quote.customer_id,
    projectId: quote.project_id,
    title: `${quote.title} (revised)`,
    description: quote.description,
    items: quote.items.map((i: any) => ({
      category: i.category, name: i.name, description: i.description, quantity: i.quantity,
      unit: i.unit, unit_price: i.unit_price, discount_pct: i.discount_pct, is_optional: i.is_optional,
    })),
    discount_type: quote.discount_type,
    discount_value: quote.discount_value,
    vat_rate: quote.vat_rate,
    terms: quote.terms,
    notes: quote.notes,
  });
  run('UPDATE quotations SET version = ? WHERE id = ? AND org_id = ?', [
    (quote.version ?? 1) + 1, copy.id, req.ctx.orgId,
  ]);
  res.status(201).json({ quotation: loadQuotation(req.ctx.orgId, copy.id) });
}));

quotationsRouter.delete('/:id', requirePermission('quotes:write'), ah((req, res) => {
  const quote = loadQuotation(req.ctx.orgId, req.params.id);
  assertQuoteAccess(req, quote);
  if (quote.status !== 'draft') throw badRequest('Only a draft can be deleted. Cancel the quotation instead.');
  run('DELETE FROM quotations WHERE id = ? AND org_id = ?', [quote.id, req.ctx.orgId]);
  audit({
    orgId: req.ctx.orgId, userId: req.ctx.user.id, action: 'quote.deleted', entityType: 'quotation',
    entityId: quote.id, entityLabel: quote.number,
  });
  res.json({ ok: true });
}));

quotationsRouter.get('/meta/products', requirePermission('quotes:write'), ah((req, res) => {
  res.json({
    products: all(
      'SELECT * FROM product_templates WHERE org_id = ? AND is_active = 1 ORDER BY project_type, category, name',
      [req.ctx.orgId],
    ),
  });
}));

function assertQuoteAccess(req: any, quote: any): void {
  if (req.ctx.can('quotes:read:all')) return;
  if (quote.owner_id === req.ctx.user.id || quote.created_by === req.ctx.user.id) return;
  throw forbidden('That quotation belongs to another salesperson.');
}

export { nowIso };
