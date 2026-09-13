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

// --- templates ------------------------------------------------------------

export interface SendTemplateInput {
  orgId: string;
  templateKey: string;
  channel?: Channel;
  leadId?: string | null;
  customerId?: string | null;
  quotationId?: string | null;
  userId?: string | null;
  automationRunId?: string | null;
  purpose?: 'operational' | 'marketing';
  attachments?: { filename: string; path: string }[];
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
  const org = get<any>('SELECT * FROM organizations WHERE id = ?', [input.orgId]);
  const lead = input.leadId
    ? get<any>('SELECT * FROM leads WHERE id = ? AND org_id = ?', [input.leadId, input.orgId])
    : null;
  const quotation = input.quotationId
    ? get<any>('SELECT * FROM quotations WHERE id = ? AND org_id = ?', [input.quotationId, input.orgId])
    : null;
  const ownerId = input.userId ?? lead?.owner_id ?? null;
  const user = ownerId
    ? get<any>('SELECT * FROM users WHERE id = ? AND org_id = ?', [ownerId, input.orgId])
    : null;

  const channel = (input.channel ?? template.channel) as Channel;
  const to = channel === 'email' ? lead?.email : lead?.phone;
  if (!to) {
    return {
      sent: false, messageId: '',
      reason: `The lead has no ${channel === 'email' ? 'email address' : 'phone number'} on file.`,
    };
  }

  const ctx = { org, company: org, lead, quotation, quote: quotation, user };
  return sendMessage({
    orgId: input.orgId,
    channel,
    leadId: input.leadId ?? null,
    customerId: input.customerId ?? null,
    quotationId: input.quotationId ?? null,
    to,
    subject: template.subject ? render(template.subject, ctx) : null,
    body: render(template.body, ctx),
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
