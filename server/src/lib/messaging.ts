import nodemailer from 'nodemailer';
import { get, insert, parseJson, run } from './db.ts';
import { newId } from './ids.ts';
import { nowIso } from './time.ts';
import { logActivity, bumpUsage } from './leads.ts';
import { notConfigured, badRequest } from './errors.ts';
import { render } from './render.ts';

export type Channel = 'email' | 'whatsapp' | 'sms' | 'phone';

export interface IntegrationState {
  provider: string;
  status: 'disconnected' | 'connected' | 'error';
  config: Record<string, any>;
  last_error: string | null;
  last_checked_at: string | null;
}

export function getIntegration(orgId: string, provider: string): IntegrationState | null {
  const row = get<any>('SELECT * FROM integrations WHERE org_id = ? AND provider = ?', [orgId, provider]);
  if (!row) return null;
  return {
    provider: row.provider,
    status: row.status,
    config: parseJson<Record<string, any>>(row.config, {}),
    last_error: row.last_error,
    last_checked_at: row.last_checked_at,
  };
}

function getSecrets(orgId: string, provider: string): Record<string, any> {
  const row = get<{ secrets: string }>('SELECT secrets FROM integrations WHERE org_id = ? AND provider = ?', [
    orgId, provider,
  ]);
  return parseJson<Record<string, any>>(row?.secrets, {});
}

export interface SendResult {
  sent: boolean;
  messageId: string;
  /** Present when `sent` is false — shown verbatim to the user. */
  reason?: string;
  providerMessageId?: string;
}

export interface SendMessageInput {
  orgId: string;
  channel: Channel;
  leadId?: string | null;
  customerId?: string | null;
  quotationId?: string | null;
  to: string;
  subject?: string | null;
  body: string;
  purpose?: 'operational' | 'marketing';
  userId?: string | null;
  automationRunId?: string | null;
  attachments?: { filename: string; path: string }[];
}

/**
 * Sends a message through a configured provider. Nothing is ever reported as
 * sent unless the provider accepted it: an unconfigured channel records a
 * `blocked` message and returns `sent: false` with the reason.
 */
export async function sendMessage(input: SendMessageInput): Promise<SendResult> {
  const messageId = newId('msg');
  const purpose = input.purpose ?? 'operational';

  if (purpose === 'marketing') {
    const consent = checkMarketingConsent(input.orgId, input.leadId, input.customerId);
    if (!consent.allowed) {
      recordMessage(input, messageId, 'blocked', null, consent.reason);
      return { sent: false, messageId, reason: consent.reason };
    }
  }

  if (input.channel === 'phone') {
    throw badRequest('Phone calls are logged, not sent. Use the call-logging action instead.');
  }

  if (input.channel === 'email') return sendEmail(input, messageId);
  if (input.channel === 'whatsapp') return sendWhatsApp(input, messageId);

  const reason = 'SMS is not available yet. Connect an SMS provider in Settings to enable it.';
  recordMessage(input, messageId, 'blocked', null, reason);
  return { sent: false, messageId, reason };
}

async function sendEmail(input: SendMessageInput, messageId: string): Promise<SendResult> {
  const integration = getIntegration(input.orgId, 'smtp');
  if (!integration || integration.status !== 'connected') {
    const reason = 'Email is not connected. Connect your mailbox in Settings → Communication to send from VoltaFlow.';
    recordMessage(input, messageId, 'blocked', null, reason);
    return { sent: false, messageId, reason };
  }
  const secrets = getSecrets(input.orgId, 'smtp');
  try {
    const transport = nodemailer.createTransport({
      host: integration.config.host,
      port: Number(integration.config.port ?? 587),
      secure: Boolean(integration.config.secure),
      auth: secrets.user ? { user: secrets.user, pass: secrets.pass } : undefined,
    });
    const info = await transport.sendMail({
      from: integration.config.from_address
        ? `${integration.config.from_name ?? ''} <${integration.config.from_address}>`.trim()
        : secrets.user,
      to: input.to,
      subject: input.subject ?? '(no subject)',
      text: input.body,
      attachments: input.attachments,
    });
    recordMessage(input, messageId, 'sent', info.messageId ?? null, null);
    bumpUsage(input.orgId, 'emails_sent');
    return { sent: true, messageId, providerMessageId: info.messageId };
  } catch (err) {
    const reason = `The mail server rejected the message: ${err instanceof Error ? err.message : String(err)}`;
    recordMessage(input, messageId, 'failed', null, reason);
    run('UPDATE integrations SET status = ?, last_error = ?, last_checked_at = ? WHERE org_id = ? AND provider = ?', [
      'error', reason, nowIso(), input.orgId, 'smtp',
    ]);
    return { sent: false, messageId, reason };
  }
}

/**
 * WhatsApp Business Cloud API. The request shape is implemented in full; until a
 * phone number id and token are saved in Settings the call is refused rather than
 * faked.
 */
async function sendWhatsApp(input: SendMessageInput, messageId: string): Promise<SendResult> {
  const integration = getIntegration(input.orgId, 'whatsapp_cloud');
  if (!integration || integration.status !== 'connected') {
    const reason = 'WhatsApp is not connected. Connect WhatsApp Business in Settings → Communication to enable this feature.';
    recordMessage(input, messageId, 'blocked', null, reason);
    return { sent: false, messageId, reason };
  }
  const secrets = getSecrets(input.orgId, 'whatsapp_cloud');
  const phoneNumberId = integration.config.phone_number_id;
  if (!phoneNumberId || !secrets.access_token) {
    const reason = 'WhatsApp is missing its phone number id or access token.';
    recordMessage(input, messageId, 'blocked', null, reason);
    return { sent: false, messageId, reason };
  }
  try {
    const response = await fetch(`https://graph.facebook.com/v21.0/${phoneNumberId}/messages`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${secrets.access_token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: input.to.replace(/[^\d]/g, ''),
        type: 'text',
        text: { body: input.body },
      }),
    });
    const payload = (await response.json()) as any;
    if (!response.ok) {
      const reason = payload?.error?.message ?? `WhatsApp returned HTTP ${response.status}`;
      recordMessage(input, messageId, 'failed', null, reason);
      return { sent: false, messageId, reason };
    }
    const providerId = payload?.messages?.[0]?.id ?? null;
    recordMessage(input, messageId, 'sent', providerId, null);
    return { sent: true, messageId, providerMessageId: providerId ?? undefined };
  } catch (err) {
    const reason = `Could not reach WhatsApp: ${err instanceof Error ? err.message : String(err)}`;
    recordMessage(input, messageId, 'failed', null, reason);
    return { sent: false, messageId, reason };
  }
}

function recordMessage(
  input: SendMessageInput, messageId: string, status: string, providerMessageId: string | null, error: string | null,
): void {
  insert('messages', {
    id: messageId,
    org_id: input.orgId,
    lead_id: input.leadId ?? null,
    customer_id: input.customerId ?? null,
    quotation_id: input.quotationId ?? null,
    channel: input.channel,
    direction: 'outbound',
    to_address: input.to,
    subject: input.subject ?? null,
    body: input.body,
    purpose: input.purpose ?? 'operational',
    status,
    provider: input.channel === 'email' ? 'smtp' : input.channel,
    provider_message_id: providerMessageId,
    error,
    sent_at: status === 'sent' ? nowIso() : null,
    user_id: input.userId ?? null,
    automation_run_id: input.automationRunId ?? null,
    created_at: nowIso(),
  });
  if (input.leadId) {
    logActivity({
      orgId: input.orgId,
      leadId: input.leadId,
      quotationId: input.quotationId ?? null,
      type: input.channel,
      direction: 'outbound',
      title: status === 'sent'
        ? `${channelLabel(input.channel)} sent: ${input.subject ?? truncate(input.body)}`
        : `${channelLabel(input.channel)} NOT sent: ${input.subject ?? truncate(input.body)}`,
      body: status === 'sent' ? input.body : `${error}\n\n---\n${input.body}`,
      meta: { message_id: messageId, status },
      userId: input.userId ?? null,
      isCustomerTouch: status === 'sent',
    });
  }
}

function channelLabel(channel: Channel): string {
  return { email: 'Email', whatsapp: 'WhatsApp message', sms: 'SMS', phone: 'Call' }[channel];
}

function truncate(text: string, length = 60): string {
  return text.length > length ? `${text.slice(0, length)}...` : text;
}

export function checkMarketingConsent(
  orgId: string, leadId?: string | null, customerId?: string | null,
): { allowed: boolean; reason: string } {
  if (leadId) {
    const lead = get<{ consent_marketing: number }>(
      'SELECT consent_marketing FROM leads WHERE id = ? AND org_id = ?', [leadId, orgId],
    );
    if (lead?.consent_marketing) return { allowed: true, reason: '' };
  }
  if (customerId) {
    const customer = get<{ marketing_consent: number }>(
      'SELECT marketing_consent FROM customers WHERE id = ? AND org_id = ?', [customerId, orgId],
    );
    if (customer?.marketing_consent) return { allowed: true, reason: '' };
  }
  return {
    allowed: false,
    reason: 'This contact has not given marketing consent. Only operational messages about their enquiry may be sent.',
  };
}

/**
 * Which channels this organisation can actually use, and which one a given lead
 * should be contacted on. "preferred" resolves to what the customer asked for,
 * falling back to whatever is connected and reachable — never to a channel the
 * provider cannot deliver on.
 */
export function channelStatus(orgId: string): Record<Channel, { connected: boolean; reason: string }> {
  const smtp = getIntegration(orgId, 'smtp');
  const whatsapp = getIntegration(orgId, 'whatsapp_cloud');
  const telephony = getIntegration(orgId, 'telephony');
  return {
    email: {
      connected: smtp?.status === 'connected',
      reason: 'Connect your mailbox in Settings → Communication to send email from VoltaFlow.',
    },
    whatsapp: {
      connected: whatsapp?.status === 'connected',
      reason: 'WhatsApp is not connected. Connect WhatsApp Business in Settings → Communication to enable this feature.',
    },
    sms: {
      // No SMS provider is implemented, so the honest answer is always "no".
      connected: false,
      reason: 'SMS is not available yet — no SMS provider is implemented in VoltaFlow.',
    },
    phone: {
      // Click-to-call works from the device with or without a provider; the
      // integration only adds automatic call logging.
      connected: true,
      reason: telephony?.status === 'connected'
        ? 'Calls are logged automatically by your telephony provider.'
        : 'Calls open on your device and are logged manually.',
    },
  };
}

export interface ResolvedChannel {
  /** Where the message would go. Null only when the contact is unreachable. */
  channel: Channel | null;
  to: string | null;
  /** True when a provider is connected and would actually accept the message. */
  deliverable: boolean;
  /** Why it is not deliverable — shown to the user verbatim. */
  reason: string;
}

/**
 * Picks the channel a contact should be reached on: their stated preference
 * first, then whatever else is connected and reachable.
 *
 * When nothing is connected this still returns the channel it WOULD have used,
 * with `deliverable: false`. That matters: the attempt is then recorded as a
 * blocked message against the right channel and appears on the timeline as "NOT
 * sent", rather than vanishing. `channel` is null only when the contact has no
 * address at all, where there is nothing to record an attempt against.
 */
export function resolveChannel(
  orgId: string, lead: { preferred_contact?: string | null; email?: string | null; phone?: string | null },
  requested?: Channel | 'preferred' | null,
): ResolvedChannel {
  const status = channelStatus(orgId);
  const addressFor = (channel: Channel): string | null =>
    (channel === 'email' ? lead.email : lead.phone) || null;

  const candidates: Channel[] = [];
  if (requested && requested !== 'preferred') {
    candidates.push(requested);
  } else {
    const wanted = lead.preferred_contact;
    if (wanted === 'whatsapp') candidates.push('whatsapp', 'email');
    else if (wanted === 'email') candidates.push('email', 'whatsapp');
    else candidates.push('whatsapp', 'email');
  }

  // Best case: connected and reachable.
  for (const channel of candidates) {
    const to = addressFor(channel);
    if (to && status[channel].connected) return { channel, to, deliverable: true, reason: '' };
  }
  // Reachable but nothing is connected: name the channel so the refusal is
  // recorded against it.
  for (const channel of candidates) {
    const to = addressFor(channel);
    if (to) return { channel, to, deliverable: false, reason: status[channel].reason };
  }
  const first = candidates[0];
  return {
    channel: null, to: null, deliverable: false,
    reason: `This contact has no ${first === 'email' ? 'email address' : 'phone number'} on file.`,
  };
}

/**
 * "Do not contact me automatically." Checked for every automated send; a person
 * can still send an operational message by hand, which is the point of the flag.
 */
export function checkAutomatedSendAllowed(
  orgId: string, leadId?: string | null,
): { allowed: boolean; reason: string } {
  if (!leadId) return { allowed: true, reason: '' };
  const lead = get<{ messaging_opt_out: number; status: string }>(
    'SELECT messaging_opt_out, status FROM leads WHERE id = ? AND org_id = ?', [leadId, orgId],
  );
  if (lead?.messaging_opt_out) {
    return { allowed: false, reason: 'This contact has opted out of automatic messages.' };
  }
  return { allowed: true, reason: '' };
}

// --- templates ------------------------------------------------------------

export interface SendTemplateInput {
  orgId: string;
  templateKey: string;
  /** A specific channel, or "preferred" to use the customer's own choice. */
  channel?: Channel | 'preferred';
  leadId?: string | null;
  customerId?: string | null;
  quotationId?: string | null;
  appointmentId?: string | null;
  userId?: string | null;
  automationRunId?: string | null;
  purpose?: 'operational' | 'marketing';
  attachments?: { filename: string; path: string }[];
  /** Overrides the rendered body/subject, e.g. after the sender edited them. */
  bodyOverride?: string | null;
  subjectOverride?: string | null;
}

/** The rendered text of a template for one lead, for preview and editing. */
export interface RenderedTemplate {
  key: string;
  name: string;
  channel: Channel;
  purpose: 'operational' | 'marketing';
  subject: string | null;
  body: string;
}

/** Renders a stored template against the lead/quote/appointment/company. */
export function renderTemplate(
  orgId: string, templateKey: string,
  target: { leadId?: string | null; quotationId?: string | null; appointmentId?: string | null; userId?: string | null },
): RenderedTemplate | null {
  const template = get<any>('SELECT * FROM message_templates WHERE org_id = ? AND key = ? AND is_active = 1', [
    orgId, templateKey,
  ]);
  if (!template) return null;
  const ctx = templateContext(orgId, target);
  return {
    key: template.key,
    name: template.name,
    channel: template.channel as Channel,
    purpose: template.purpose,
    subject: template.subject ? render(template.subject, ctx) : null,
    body: render(template.body, ctx),
  };
}

function templateContext(
  orgId: string,
  target: { leadId?: string | null; quotationId?: string | null; appointmentId?: string | null; userId?: string | null },
): Record<string, any> {
  const org = get<any>('SELECT * FROM organizations WHERE id = ?', [orgId]);
  const lead = target.leadId
    ? get<any>('SELECT * FROM leads WHERE id = ? AND org_id = ?', [target.leadId, orgId])
    : null;
  const quotation = target.quotationId
    ? get<any>('SELECT * FROM quotations WHERE id = ? AND org_id = ?', [target.quotationId, orgId])
    : null;
  const appointment = target.appointmentId
    ? get<any>('SELECT * FROM appointments WHERE id = ? AND org_id = ?', [target.appointmentId, orgId])
    : null;
  const ownerId = target.userId ?? lead?.owner_id ?? null;
  const user = ownerId
    ? get<any>('SELECT * FROM users WHERE id = ? AND org_id = ?', [ownerId, orgId])
    : null;
  return { org, company: org, lead, quotation, quote: quotation, appointment, user };
}

/**
 * Renders a stored template against the lead/quote/company and sends it through
 * the real provider. The returned result reflects what the provider actually did.
 */
export async function sendTemplate(input: SendTemplateInput): Promise<SendResult> {
  const template = get<any>('SELECT * FROM message_templates WHERE org_id = ? AND key = ? AND is_active = 1', [
    input.orgId, input.templateKey,
  ]);
  if (!template) {
    return { sent: false, messageId: '', reason: `Template "${input.templateKey}" is not configured.` };
  }
  // Automated sends honour the contact's "do not contact me automatically" flag.
  // A person sending by hand is not an automated send and is not blocked here.
  if (input.automationRunId) {
    const allowed = checkAutomatedSendAllowed(input.orgId, input.leadId);
    if (!allowed.allowed) return { sent: false, messageId: '', reason: allowed.reason };
  }

  const lead = input.leadId
    ? get<any>('SELECT * FROM leads WHERE id = ? AND org_id = ?', [input.leadId, input.orgId])
    : null;
  if (!lead) return { sent: false, messageId: '', reason: 'That lead no longer exists.' };

  const requested = (input.channel ?? template.channel) as Channel | 'preferred';
  const resolved = resolveChannel(input.orgId, lead, requested);
  if (!resolved.channel || !resolved.to) {
    return { sent: false, messageId: '', reason: resolved.reason };
  }

  const ctx = templateContext(input.orgId, input);
  return sendMessage({
    orgId: input.orgId,
    channel: resolved.channel,
    leadId: input.leadId ?? null,
    customerId: input.customerId ?? null,
    quotationId: input.quotationId ?? null,
    to: resolved.to,
    subject: input.subjectOverride ?? (template.subject ? render(template.subject, ctx) : null),
    body: input.bodyOverride ?? render(template.body, ctx),
    purpose: (input.purpose ?? template.purpose) as 'operational' | 'marketing',
    userId: input.userId ?? null,
    automationRunId: input.automationRunId ?? null,
    attachments: input.attachments,
  });
}

export function requireIntegration(orgId: string, provider: string, label: string): IntegrationState {
  const integration = getIntegration(orgId, provider);
  if (!integration || integration.status !== 'connected') {
    throw notConfigured(`${label} is not connected. Connect it in Settings → Communication to enable this feature.`, {
      provider,
    });
  }
  return integration;
}
