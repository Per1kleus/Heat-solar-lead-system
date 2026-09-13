import { all, get, insert, run } from './db.ts';
import { newId, randomToken } from './ids.ts';
import { addDays, nowIso } from './time.ts';
import { logActivity, rescoreLead, money } from './leads.ts';
import { emit } from './events.ts';
import { audit } from './audit.ts';
import { badRequest, notFound } from './errors.ts';

export interface QuotationItemInput {
  id?: string;
  category?: string;
  name: string;
  description?: string | null;
  quantity: number;
  unit?: string;
  unit_price: number;
  discount_pct?: number;
  is_optional?: boolean;
  position?: number;
}

export interface QuotationTotals {
  subtotal: number;
  discount_amount: number;
  vat_amount: number;
  total: number;
  optional_total: number;
}

/**
 * Totals for a quotation. Optional items are priced separately and never counted
 * in the headline total — that is what installers expect on a proposal.
 */
export function computeTotals(
  items: QuotationItemInput[],
  opts: { discount_type?: string; discount_value?: number; vat_rate?: number },
): QuotationTotals & { lines: (QuotationItemInput & { line_total: number })[] } {
  const lines = items.map((item) => {
    const gross = Number(item.quantity || 0) * Number(item.unit_price || 0);
    const lineTotal = round2(gross * (1 - Number(item.discount_pct || 0) / 100));
    return { ...item, line_total: lineTotal };
  });
  const subtotal = round2(lines.filter((l) => !l.is_optional).reduce((sum, l) => sum + l.line_total, 0));
  const optionalTotal = round2(lines.filter((l) => l.is_optional).reduce((sum, l) => sum + l.line_total, 0));
  const discountAmount = opts.discount_type === 'percent'
    ? round2(subtotal * (Number(opts.discount_value || 0) / 100))
    : round2(Number(opts.discount_value || 0));
  const net = Math.max(0, round2(subtotal - discountAmount));
  const vatAmount = round2(net * (Number(opts.vat_rate ?? 24) / 100));
  return {
    subtotal,
    discount_amount: discountAmount,
    vat_amount: vatAmount,
    total: round2(net + vatAmount),
    optional_total: optionalTotal,
    lines,
  };
}

function round2(n: number): number {
  return Math.round((n + Number.EPSILON) * 100) / 100;
}

export function nextQuoteNumber(orgId: string): string {
  const org = get<{ quote_prefix: string; quote_counter: number }>(
    'SELECT quote_prefix, quote_counter FROM organizations WHERE id = ?', [orgId],
  );
  if (!org) throw notFound('Organisation not found.');
  const year = new Date().getFullYear();
  let counter = org.quote_counter + 1;
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const number = `${org.quote_prefix}-${year}-${String(counter).padStart(4, '0')}`;
    if (!get('SELECT 1 FROM quotations WHERE org_id = ? AND number = ?', [orgId, number])) {
      run('UPDATE organizations SET quote_counter = ? WHERE id = ?', [counter, orgId]);
      return number;
    }
    counter += 1;
  }
  return `${org.quote_prefix}-${year}-${Date.now().toString(36)}`;
}

export interface CreateQuotationInput {
  orgId: string;
  userId: string | null;
  leadId?: string | null;
  customerId?: string | null;
  projectId?: string | null;
  title: string;
  description?: string | null;
  items: QuotationItemInput[];
  discount_type?: 'amount' | 'percent';
  discount_value?: number;
  vat_rate?: number;
  valid_until?: string | null;
  terms?: string | null;
  notes?: string | null;
}

export function createQuotation(input: CreateQuotationInput): any {
  if (!input.title?.trim()) throw badRequest('Give the quotation a title so the customer knows what it covers.');
  if (!input.leadId && !input.customerId) throw badRequest('A quotation must belong to a lead or a customer.');
  if (!input.items?.length) throw badRequest('Add at least one line to the quotation.');

  const org = get<any>('SELECT * FROM organizations WHERE id = ?', [input.orgId]);
  const lead = input.leadId
    ? get<any>('SELECT * FROM leads WHERE id = ? AND org_id = ?', [input.leadId, input.orgId])
    : null;
  if (input.leadId && !lead) throw notFound('That lead no longer exists.');

  const vatRate = input.vat_rate ?? org.vat_rate ?? 24;
  const totals = computeTotals(input.items, {
    discount_type: input.discount_type, discount_value: input.discount_value, vat_rate: vatRate,
  });

  const id = newId('quo');
  const now = nowIso();
  insert('quotations', {
    id,
    org_id: input.orgId,
    number: nextQuoteNumber(input.orgId),
    lead_id: input.leadId ?? null,
    customer_id: input.customerId ?? lead?.customer_id ?? null,
    project_id: input.projectId ?? null,
    title: input.title.trim(),
    description: input.description ?? null,
    status: 'draft',
    currency: org.currency ?? 'EUR',
    subtotal: totals.subtotal,
    discount_type: input.discount_type ?? 'amount',
    discount_value: input.discount_value ?? 0,
    discount_amount: totals.discount_amount,
    vat_rate: vatRate,
    vat_amount: totals.vat_amount,
    total: totals.total,
    optional_total: totals.optional_total,
    valid_until: input.valid_until ?? addDays(new Date(), org.quote_validity_days ?? 30),
    terms: input.terms ?? org.quote_terms ?? null,
    notes: input.notes ?? null,
    owner_id: lead?.owner_id ?? input.userId,
    public_token: randomToken(18),
    created_by: input.userId,
    created_at: now,
    updated_at: now,
  });
  writeItems(input.orgId, id, totals.lines);

  if (input.leadId) {
    logActivity({
      orgId: input.orgId, leadId: input.leadId, quotationId: id, type: 'quote',
      title: `Quotation drafted: ${input.title}`,
      body: `${money(totals.total, org.currency)} including VAT`,
      meta: { quotation_id: id, total: totals.total }, userId: input.userId,
    });
    rescoreLead(input.orgId, input.leadId);
  }
  audit({
    orgId: input.orgId, userId: input.userId, action: 'quote.created', entityType: 'quotation', entityId: id,
    entityLabel: input.title, changes: { total: totals.total },
  });
  return loadQuotation(input.orgId, id);
}

export function updateQuotation(orgId: string, quotationId: string, userId: string | null, patch: any): any {
  const quote = get<any>('SELECT * FROM quotations WHERE id = ? AND org_id = ?', [quotationId, orgId]);
  if (!quote) throw notFound('That quotation no longer exists.');
  if (['accepted', 'rejected'].includes(quote.status)) {
    throw badRequest('A quotation the customer has already answered cannot be edited. Create a new version instead.');
  }

  const items: QuotationItemInput[] = patch.items ?? listItems(orgId, quotationId);
  const vatRate = patch.vat_rate ?? quote.vat_rate;
  const totals = computeTotals(items, {
    discount_type: patch.discount_type ?? quote.discount_type,
    discount_value: patch.discount_value ?? quote.discount_value,
    vat_rate: vatRate,
  });

  run(
    `UPDATE quotations SET title = ?, description = ?, discount_type = ?, discount_value = ?, discount_amount = ?,
       vat_rate = ?, subtotal = ?, vat_amount = ?, total = ?, optional_total = ?, valid_until = ?, terms = ?,
       notes = ?, pdf_path = NULL, updated_at = ?
     WHERE id = ? AND org_id = ?`,
    [
      patch.title ?? quote.title, patch.description ?? quote.description,
      patch.discount_type ?? quote.discount_type, patch.discount_value ?? quote.discount_value,
      totals.discount_amount, vatRate, totals.subtotal, totals.vat_amount, totals.total, totals.optional_total,
      patch.valid_until ?? quote.valid_until, patch.terms ?? quote.terms, patch.notes ?? quote.notes,
      nowIso(), quotationId, orgId,
    ],
  );
  if (patch.items) writeItems(orgId, quotationId, totals.lines);
  audit({
    orgId, userId, action: 'quote.updated', entityType: 'quotation', entityId: quotationId,
    entityLabel: quote.number, changes: { total: { from: quote.total, to: totals.total } },
  });
  if (quote.lead_id) {
    logActivity({
      orgId, leadId: quote.lead_id, quotationId, type: 'quote',
      title: `Quotation ${quote.number} updated`,
      body: `New total ${money(totals.total, quote.currency)}`, userId,
    });
  }
  return loadQuotation(orgId, quotationId);
}

function writeItems(orgId: string, quotationId: string, lines: (QuotationItemInput & { line_total: number })[]): void {
  run('DELETE FROM quotation_items WHERE quotation_id = ? AND org_id = ?', [quotationId, orgId]);
  lines.forEach((line, index) => {
    insert('quotation_items', {
      id: newId('qit'),
      org_id: orgId,
      quotation_id: quotationId,
      position: line.position ?? index,
      category: line.category ?? 'equipment',
      name: line.name,
      description: line.description ?? null,
      quantity: line.quantity,
      unit: line.unit ?? 'pcs',
      unit_price: line.unit_price,
      discount_pct: line.discount_pct ?? 0,
      line_total: line.line_total,
      is_optional: line.is_optional ? 1 : 0,
    });
  });
}

export function listItems(orgId: string, quotationId: string): any[] {
  return all(
    'SELECT * FROM quotation_items WHERE org_id = ? AND quotation_id = ? ORDER BY position, rowid',
    [orgId, quotationId],
  ).map((item: any) => ({ ...item, is_optional: !!item.is_optional }));
}

export function loadQuotation(orgId: string, quotationId: string): any {
  const quote = get<any>(
    `SELECT q.*, l.first_name AS lead_first_name, l.last_name AS lead_last_name, l.reference AS lead_reference,
            l.phone AS lead_phone, l.email AS lead_email, l.address AS lead_address, l.city AS lead_city,
            l.postal_code AS lead_postal_code, l.company AS lead_company,
            u.first_name AS owner_first_name, u.last_name AS owner_last_name,
            c.first_name AS customer_first_name, c.last_name AS customer_last_name
     FROM quotations q
     LEFT JOIN leads l ON l.id = q.lead_id
     LEFT JOIN users u ON u.id = q.owner_id
     LEFT JOIN customers c ON c.id = q.customer_id
     WHERE q.id = ? AND q.org_id = ?`,
    [quotationId, orgId],
  );
  if (!quote) throw notFound('That quotation no longer exists.');
  return {
    ...quote,
    items: listItems(orgId, quotationId),
    customer_name: quote.lead_first_name
      ? `${quote.lead_first_name} ${quote.lead_last_name}`
      : quote.customer_first_name ? `${quote.customer_first_name} ${quote.customer_last_name}` : 'Unknown',
    owner_name: quote.owner_first_name ? `${quote.owner_first_name} ${quote.owner_last_name}` : null,
    days_since_sent: quote.sent_at ? Math.floor((Date.now() - new Date(quote.sent_at).getTime()) / 86400000) : null,
  };
}

export function markSent(
  orgId: string, quotationId: string, userId: string | null, via: string, note?: string,
): any {
  const quote = get<any>('SELECT * FROM quotations WHERE id = ? AND org_id = ?', [quotationId, orgId]);
  if (!quote) throw notFound('That quotation no longer exists.');
  const now = nowIso();
  run(
    `UPDATE quotations SET status = 'sent', sent_at = COALESCE(sent_at, ?), sent_via = ?, updated_at = ?
     WHERE id = ? AND org_id = ?`,
    [now, via, now, quotationId, orgId],
  );
  if (quote.lead_id) {
    logActivity({
      orgId, leadId: quote.lead_id, quotationId, type: 'quote', direction: 'outbound',
      title: `Quotation ${quote.number} sent (${via})`,
      body: note ?? `${money(quote.total, quote.currency)} — valid until ${
        quote.valid_until ? new Date(quote.valid_until).toLocaleDateString('en-GB') : 'n/a'}`,
      meta: { quotation_id: quotationId, via },
      userId, isCustomerTouch: via !== 'manual',
    });
    // Move the lead to "Proposal Sent" if such a stage exists and it is ahead.
    const stage = get<{ id: string; probability: number; position: number }>(
      "SELECT id, probability, position FROM pipeline_stages WHERE org_id = ? AND key = 'proposal_sent'", [orgId],
    );
    const current = get<{ position: number }>(
      'SELECT position FROM pipeline_stages WHERE id = (SELECT stage_id FROM leads WHERE id = ?)', [quote.lead_id],
    );
    if (stage && (!current || current.position < stage.position)) {
      run('UPDATE leads SET stage_id = ?, stage_entered_at = ?, probability = ? WHERE id = ? AND org_id = ?', [
        stage.id, now, stage.probability, quote.lead_id, orgId,
      ]);
    }
    rescoreLead(orgId, quote.lead_id);
  }
  audit({
    orgId, userId, action: 'quote.sent', entityType: 'quotation', entityId: quotationId,
    entityLabel: quote.number, changes: { via, total: quote.total },
  });
  emit({ type: 'quote_sent', orgId, leadId: quote.lead_id, quotationId, userId });
  return loadQuotation(orgId, quotationId);
}

export function setQuotationStatus(
  orgId: string, quotationId: string, userId: string | null,
  status: string, meta: { rejection_reason?: string | null } = {},
): any {
  const quote = get<any>('SELECT * FROM quotations WHERE id = ? AND org_id = ?', [quotationId, orgId]);
  if (!quote) throw notFound('That quotation no longer exists.');
  const now = nowIso();
  const fields: Record<string, any> = { status, updated_at: now };
  if (status === 'accepted') { fields.accepted_at = now; fields.responded_at = now; }
  if (status === 'rejected') {
    fields.rejected_at = now; fields.responded_at = now;
    fields.rejection_reason = meta.rejection_reason ?? null;
  }
  if (status === 'viewed' && !quote.first_viewed_at) fields.first_viewed_at = now;

  const keys = Object.keys(fields);
  run(
    `UPDATE quotations SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ? AND org_id = ?`,
    [...keys.map((k) => fields[k]), quotationId, orgId],
  );

  if (quote.lead_id) {
    logActivity({
      orgId, leadId: quote.lead_id, quotationId, type: 'quote',
      title: `Quotation ${quote.number}: ${statusLabel(status)}`,
      body: meta.rejection_reason ?? null, meta: { quotation_id: quotationId, status }, userId,
      isCustomerTouch: ['accepted', 'rejected', 'viewed'].includes(status),
      direction: ['accepted', 'rejected', 'viewed'].includes(status) ? 'inbound' : 'internal',
    });
    rescoreLead(orgId, quote.lead_id);
  }
  audit({
    orgId, userId, action: 'quote.status_changed', entityType: 'quotation', entityId: quotationId,
    entityLabel: quote.number, changes: { status: { from: quote.status, to: status } },
  });
  if (['accepted', 'rejected'].includes(status)) {
    emit({ type: 'quote_responded', orgId, leadId: quote.lead_id, quotationId, status });
  }
  return loadQuotation(orgId, quotationId);
}

function statusLabel(status: string): string {
  const labels: Record<string, string> = {
    draft: 'back to draft', sent: 'sent', viewed: 'viewed by the customer',
    awaiting_response: 'awaiting a response', accepted: 'accepted by the customer',
    rejected: 'rejected', expired: 'expired', cancelled: 'cancelled',
  };
  return labels[status] ?? status;
}
