import nodemailer from 'nodemailer';
import { get, insert, parseJson, run } from './db.ts';
import { newId } from './ids.ts';
import { nowIso } from './time.ts';
import { logActivity, bumpUsage } from './leads.ts';
import { notConfigured, badRequest } from './errors.ts';
import { render, renderChecked } from './render.ts';

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
  /**
   * The identity of the scheduled action this send belongs to. Claimed before
   * the provider is called, so a retry or a duplicated tick replays the original
   * outcome instead of messaging the customer twice. Never content-derived.
   */
  dedupeKey?: string | null;
}

/** How many times a transient provider failure is retried before giving up. */
const MAX_SEND_ATTEMPTS = 3;

export interface ProviderResult {
  ok: boolean;
  providerMessageId?: string | null;
  error?: string;
  /** False for a permanent rejection (bad address, refused content). */
  retryable?: boolean;
}

/**
 * A channel's actual transport. Registered rather than hard-wired so a test can
 * substitute a provider at this boundary without real credentials, and so a new
 * provider is one registration rather than a change to the send path.
 */
export type ProviderTransport = (
  input: SendMessageInput,
  config: Record<string, any>,
  secrets: Record<string, any>,
) => Promise<ProviderResult>;

const transports: Record<string, ProviderTransport> = {};

export function registerTransport(channel: Channel, transport: ProviderTransport): void {
  transports[channel] = transport;
}

/** Restores the real provider. Used by tests after substituting one. */
export function resetTransports(): void {
  transports.email = smtpTransport;
  transports.whatsapp = whatsAppTransport;
}

/**
 * Sends a message through a configured provider. Nothing is ever reported as
 * sent unless the provider accepted it: an unconfigured channel records a
 * `blocked` message and returns `sent: false` with the reason.
 */
export async function sendMessage(input: SendMessageInput): Promise<SendResult> {
  if (input.channel === 'phone') {
    throw badRequest('Phone calls are logged, not sent. Use the call-logging action instead.');
  }

  // Claim the send first. If this exact scheduled action already ran, its
  // outcome is replayed rather than repeated — the customer is never messaged
  // twice because a tick was duplicated or a worker retried.
  const claim = claimMessage(input);
  if (claim.replay) return claim.replay;
  const messageId = claim.messageId;

  if ((input.purpose ?? 'operational') === 'marketing') {
    const consent = checkMarketingConsent(input.orgId, input.leadId, input.customerId);
    if (!consent.allowed) return settle(input, messageId, 'blocked', null, consent.reason);
  }

  if (input.channel === 'sms') {
    return settle(input, messageId, 'blocked', null,
      'SMS is not available yet — no SMS provider is implemented in VoltaFlow.');
  }

  const provider = input.channel === 'email' ? 'smtp' : 'whatsapp_cloud';
  const integration = getIntegration(input.orgId, provider);
  if (!integration || integration.status !== 'connected') {
    return settle(input, messageId, 'blocked', null, channelStatus(input.orgId)[input.channel].reason);
  }

  const transport = transports[input.channel];
  if (!transport) {
    return settle(input, messageId, 'blocked', null, `No transport is registered for ${input.channel}.`);
  }

  let result: ProviderResult;
  try {
    result = await transport(input, integration.config, getSecrets(input.orgId, provider));
  } catch (err) {
    result = {
      ok: false, retryable: true,
      error: `Could not reach the ${input.channel} provider: ${err instanceof Error ? err.message : String(err)}`,
    };
  }

  if (result.ok) {
    if (input.channel === 'email') bumpUsage(input.orgId, 'emails_sent');
    return settle(input, messageId, 'sent', result.providerMessageId ?? null, null);
  }
  // A permanent rejection is recorded as failed and never retried; a transient
  // one stays retryable until MAX_SEND_ATTEMPTS.
  if (input.channel === 'email' && result.retryable === false) {
    run('UPDATE integrations SET status = ?, last_error = ?, last_checked_at = ? WHERE org_id = ? AND provider = ?', [
      'error', result.error ?? 'The mail server rejected the message.', nowIso(), input.orgId, 'smtp',
    ]);
  }
  return settle(input, messageId, 'failed', null, result.error ?? 'The provider rejected the message.',
    result.retryable !== false);
}

interface Claim { messageId: string; replay?: SendResult }

/**
 * Reserves a row for this send. With a dedupe key the reservation is unique, so
 * the second caller gets the first one's outcome back:
 *   sent    → never send again
 *   blocked → a rule refused it (opt-out, no provider); retrying cannot help
 *   failed  → transient, so retry until the attempt cap
 */
function claimMessage(input: SendMessageInput): Claim {
  const key = input.dedupeKey ?? null;
  if (key) {
    const existing = get<any>('SELECT * FROM messages WHERE org_id = ? AND dedupe_key = ?', [input.orgId, key]);
    if (existing) {
      if (existing.status === 'sent') {
        return {
          messageId: existing.id,
          replay: { sent: true, messageId: existing.id, providerMessageId: existing.provider_message_id ?? undefined },
        };
      }
      if (existing.status === 'blocked' || existing.attempts >= MAX_SEND_ATTEMPTS) {
        return {
          messageId: existing.id,
          replay: {
            sent: false, messageId: existing.id,
            reason: existing.status === 'blocked'
              ? existing.error
              : `${existing.error} (gave up after ${existing.attempts} attempts)`,
          },
        };
      }
      // Transient failure, still under the cap: try again on the same row.
      run('UPDATE messages SET attempts = attempts + 1 WHERE id = ?', [existing.id]);
      return { messageId: existing.id };
    }
  }

  const messageId = newId('msg');
  try {
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
      status: 'queued',
      provider: input.channel === 'email' ? 'smtp' : input.channel,
      user_id: input.userId ?? null,
      automation_run_id: input.automationRunId ?? null,
      dedupe_key: key,
      attempts: 1,
      created_at: nowIso(),
    });
  } catch {
    // Another execution claimed the same key between the read and the insert.
    const existing = get<any>('SELECT * FROM messages WHERE org_id = ? AND dedupe_key = ?', [input.orgId, key]);
    return {
      messageId: existing?.id ?? messageId,
      replay: {
        sent: existing?.status === 'sent',
        messageId: existing?.id ?? messageId,
        reason: existing?.status === 'sent' ? undefined : 'This message is already being sent.',
      },
    };
  }
  return { messageId };
}

/** Writes the outcome to the claimed row and puts it on the lead timeline. */
function settle(
  input: SendMessageInput, messageId: string, status: 'sent' | 'failed' | 'blocked',
  providerMessageId: string | null, error: string | null, retryable = false,
): SendResult {
  run(
    `UPDATE messages SET status = ?, provider_message_id = ?, error = ?, sent_at = ? WHERE id = ?`,
    [status, providerMessageId, error, status === 'sent' ? nowIso() : null, messageId],
  );
  // A transient failure keeps its key claimable so the next attempt reuses this
  // row; a permanent one does not, and neither does a success.
  if (status === 'failed' && !retryable) {
    run('UPDATE messages SET attempts = ? WHERE id = ?', [MAX_SEND_ATTEMPTS, messageId]);
  }
  logSendToTimeline(input, messageId, status, error);
  return status === 'sent'
    ? { sent: true, messageId, providerMessageId: providerMessageId ?? undefined }
    : { sent: false, messageId, reason: error ?? 'The message could not be sent.' };
}

/** SMTP. Registered as the email transport; substituted in tests. */
const smtpTransport: ProviderTransport = async (input, config, secrets) => {
  try {
    const transport = nodemailer.createTransport({
      host: config.host,
      port: Number(config.port ?? 587),
      secure: Boolean(config.secure),
      auth: secrets.user ? { user: secrets.user, pass: secrets.pass } : undefined,
    });
    const info = await transport.sendMail({
      from: config.from_address
        ? `${config.from_name ?? ''} <${config.from_address}>`.trim()
        : secrets.user,
      to: input.to,
      subject: input.subject ?? '(no subject)',
      text: input.body,
      attachments: input.attachments,
    });
    return { ok: true, providerMessageId: info.messageId ?? null };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    // A rejected recipient or a refused login will not fix itself; a timeout or
    // a dropped connection might.
    const permanent = /5\d\d|invalid|no recipients|authentication|auth/i.test(message);
    return { ok: false, error: `The mail server rejected the message: ${message}`, retryable: !permanent };
  }
};

/**
 * WhatsApp Business Cloud API. The request shape is implemented in full; until a
 * phone number id and token are saved in Settings the send is refused rather
 * than faked.
 */
const whatsAppTransport: ProviderTransport = async (input, config, secrets) => {
  if (!config.phone_number_id || !secrets.access_token) {
    return { ok: false, error: 'WhatsApp is missing its phone number id or access token.', retryable: false };
  }
  try {
    const response = await fetch(`https://graph.facebook.com/v21.0/${config.phone_number_id}/messages`, {
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
      return {
        ok: false,
        error: payload?.error?.message ?? `WhatsApp returned HTTP ${response.status}`,
        // 4xx is our mistake and will repeat; 5xx and rate limits are worth another go.
        retryable: response.status >= 500 || response.status === 429,
      };
    }
    return { ok: true, providerMessageId: payload?.messages?.[0]?.id ?? null };
  } catch (err) {
    return {
      ok: false,
      error: `Could not reach WhatsApp: ${err instanceof Error ? err.message : String(err)}`,
      retryable: true,
    };
  }
};

resetTransports();

/**
 * Puts the attempt on the lead timeline. A message that did not go out says so
 * in as many words, and carries the reason and the run that produced it, so the
 * history never implies a delivery that did not happen.
 */
function logSendToTimeline(
  input: SendMessageInput, messageId: string, status: string, error: string | null,
): void {
  if (!input.leadId) return;
  const automated = Boolean(input.automationRunId);
  const what = `${channelLabel(input.channel)}${automated ? ' (automated)' : ''}`;
  const subject = input.subject ?? truncate(input.body);
  logActivity({
    orgId: input.orgId,
    leadId: input.leadId,
    quotationId: input.quotationId ?? null,
    type: input.channel,
    direction: 'outbound',
    title: status === 'sent'
      ? `${what} sent: ${subject}`
      : `${what} NOT sent: ${subject}`,
    body: status === 'sent' ? input.body : `${error}\n\n---\n${input.body}`,
    meta: {
      message_id: messageId,
      status,
      automation_run_id: input.automationRunId ?? null,
      dedupe_key: input.dedupeKey ?? null,
      reason: error,
    },
    userId: input.userId ?? null,
    isCustomerTouch: status === 'sent',
  });
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
      // The state comes first: whoever reads this needs to know nothing was sent
      // before they need to know how to fix it.
      reason: 'Email is not connected. Connect your mailbox in Settings → Communication to send from VoltaFlow.',
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
  /** Identity of the scheduled action — see SendMessageInput.dedupeKey. */
  dedupeKey?: string | null;
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
  const bodyCheck = renderChecked(template.body, ctx);
  const subjectCheck = template.subject ? renderChecked(template.subject, ctx) : { text: null, missing: [] as string[] };

  // An automated send with holes in it is worse than no send: refuse, say which
  // fields are missing, and leave the problem visible. A person composing by
  // hand sees the same text and can fix it themselves, so they are not blocked.
  const missing = [...new Set([...bodyCheck.missing, ...subjectCheck.missing])];
  if (input.automationRunId && missing.length > 0 && !input.bodyOverride) {
    return {
      sent: false, messageId: '',
      reason: `Template "${input.templateKey}" is missing ${missing.join(', ')} for this lead, so nothing was sent.`,
    };
  }

  return sendMessage({
    orgId: input.orgId,
    channel: resolved.channel,
    leadId: input.leadId ?? null,
    customerId: input.customerId ?? null,
    quotationId: input.quotationId ?? null,
    to: resolved.to,
    subject: input.subjectOverride ?? subjectCheck.text,
    body: input.bodyOverride ?? bodyCheck.text,
    purpose: (input.purpose ?? template.purpose) as 'operational' | 'marketing',
    userId: input.userId ?? null,
    automationRunId: input.automationRunId ?? null,
    attachments: input.attachments,
    dedupeKey: input.dedupeKey ?? null,
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
