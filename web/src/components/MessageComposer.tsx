import { useEffect, useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { get, post } from '../lib/api';
import { Badge, Button, Icon, Modal, useToast } from './ui';

export type ComposerChannel = 'email' | 'whatsapp';

interface Props {
  lead: any;
  channel: ComposerChannel;
  /** Pre-selects a template, e.g. "quote_follow_up" from the dashboard. */
  templateKey?: string;
  quotationId?: string;
  appointmentId?: string;
  onClose: () => void;
  onSent: () => void;
}

/**
 * The one place a message to a customer is written.
 *
 * Templates are rendered on the server against this lead, so the composer opens
 * with real text rather than {{placeholders}}, and the sender edits it before it
 * goes anywhere. Sending reports exactly what the provider did: an unconnected
 * channel refuses with the setup path, and "log it myself" stays available so the
 * timeline is complete either way.
 */
export default function MessageComposer({
  lead, channel: initialChannel, templateKey, quotationId, appointmentId, onClose, onSent,
}: Props) {
  const [channel, setChannel] = useState<ComposerChannel>(initialChannel);
  const [subject, setSubject] = useState('');
  const [body, setBody] = useState('');
  const [chosen, setChosen] = useState<string | null>(templateKey ?? null);
  const [sending, setSending] = useState(false);
  const [failure, setFailure] = useState<string | null>(null);
  const toast = useToast();

  const { data: channelData } = useQuery({
    queryKey: ['channels', lead.id],
    queryFn: () => get(`/messages/channels?lead_id=${lead.id}`),
    staleTime: 60_000,
  });
  const { data: templateData } = useQuery({
    queryKey: ['templates', lead.id, quotationId ?? '', appointmentId ?? ''],
    queryFn: () => get(
      `/messages/templates?lead_id=${lead.id}`
      + (quotationId ? `&quotation_id=${quotationId}` : '')
      + (appointmentId ? `&appointment_id=${appointmentId}` : ''),
    ),
  });

  const info = channelData?.channels?.find((c: any) => c.key === channel);
  const connected = Boolean(info?.connected);
  const reachable = info?.reachable !== false;
  const address = channel === 'email' ? lead.email : lead.phone;

  const templates = useMemo(
    () => (templateData?.templates ?? []).filter((t: any) => t.purpose === 'operational'),
    [templateData],
  );

  // Apply the requested template as soon as the rendered text arrives.
  useEffect(() => {
    if (!chosen || templates.length === 0) return;
    const template = templates.find((t: any) => t.key === chosen);
    if (!template) return;
    setSubject(template.subject ?? '');
    setBody(template.body ?? '');
  }, [chosen, templates]);

  const apply = (key: string) => {
    setChosen(key);
    const template = templates.find((t: any) => t.key === key);
    if (!template) return;
    // A template written for one channel still works on the other; the subject is
    // simply ignored on WhatsApp.
    if (template.channel === 'email' || template.channel === 'whatsapp') setChannel(template.channel);
    setSubject(template.subject ?? '');
    setBody(template.body ?? '');
  };

  const send = async () => {
    setSending(true); setFailure(null);
    try {
      await post('/messages/send', {
        lead_id: lead.id, channel,
        subject: channel === 'email' ? subject || undefined : undefined,
        body,
      });
      toast.success(
        channel === 'email' ? 'Email sent.' : 'WhatsApp message sent.',
        'It is on the customer timeline.',
      );
      onSent(); onClose();
    } catch (err: any) {
      // The attempt is already recorded as blocked/failed with its reason; show
      // that reason here rather than a generic error.
      setFailure(err?.message ?? 'The message could not be sent.');
    } finally { setSending(false); }
  };

  const logManually = async () => {
    setSending(true);
    try {
      await post(`/leads/${lead.id}/activities`, {
        type: channel, direction: 'outbound', body, title: subject || undefined,
      });
      toast.success('Logged on the timeline.', 'Recorded as sent by you, outside VoltaFlow.');
      onSent(); onClose();
    } catch (err) { toast.error(err); } finally { setSending(false); }
  };

  return (
    <Modal
      title={`${channel === 'email' ? 'Email' : 'WhatsApp'} ${lead.first_name ?? ''}`.trim()}
      subtitle={address ?? 'No address on file'}
      onClose={onClose}
      width="wide"
      footer={
        <>
          <Button onClick={onClose} disabled={sending}>Cancel</Button>
          <Button onClick={logManually} loading={sending} disabled={!body.trim()}>
            I sent it myself
          </Button>
          <Button
            variant="primary" onClick={send} loading={sending}
            disabled={!connected || !reachable || !body.trim()}
          >
            Send {channel === 'email' ? 'email' : 'message'}
          </Button>
        </>
      }
    >
      <div className="col gap-6">
        <div className="chips">
          {(['whatsapp', 'email'] as ComposerChannel[]).map((key) => {
            const c = channelData?.channels?.find((x: any) => x.key === key);
            return (
              <button
                key={key} type="button"
                className={`chip ${channel === key ? 'on' : ''}`}
                onClick={() => { setChannel(key); setFailure(null); }}
              >
                <Icon name={key === 'email' ? 'mail' : 'whatsapp'} size={13} />
                {key === 'email' ? 'Email' : 'WhatsApp'}
                {c && !c.connected ? ' · not connected' : ''}
                {c && c.reachable === false ? ' · no address' : ''}
              </button>
            );
          })}
          {channelData?.stated_preference && (
            <span className="tiny dim" style={{ alignSelf: 'center' }}>
              Customer prefers {channelData.stated_preference}
            </span>
          )}
        </div>

        {channelData?.opted_out && (
          <div className="banner warn">
            <Icon name="alert" size={15} />
            <span>
              This contact has opted out of <strong>automatic</strong> messages. You can still send
              this one by hand — it is about their own enquiry.
            </span>
          </div>
        )}

        {!reachable && (
          <div className="banner warn">
            <Icon name="alert" size={15} />
            <span>
              This contact has no {channel === 'email' ? 'email address' : 'phone number'} on file.
              Add one on the lead before sending.
            </span>
          </div>
        )}

        {reachable && !connected && (
          <div className="banner warn">
            <Icon name="alert" size={15} />
            <span>
              {info?.hint ?? 'This channel is not connected.'}{' '}
              {info?.setup_path && <Link to={info.setup_path}>Open Settings → Communication</Link>}
              {' '}Nothing will be sent from here until it is connected — write the message and use
              “I sent it myself” to keep the timeline accurate.
            </span>
          </div>
        )}

        {failure && (
          <div className="banner error">
            <Icon name="alert" size={15} />
            <span><strong>Not sent.</strong> {failure}</span>
          </div>
        )}

        {templates.length > 0 && (
          <div className="field">
            <label>Start from a template</label>
            <div className="chips">
              {templates.map((template: any) => (
                <button
                  key={template.key} type="button"
                  className={`chip ${chosen === template.key ? 'on' : ''}`}
                  onClick={() => apply(template.key)}
                >
                  {template.name}
                </button>
              ))}
            </div>
            <span className="hint">Everything stays editable — change it before you send.</span>
          </div>
        )}

        {channel === 'email' && (
          <div className="field">
            <label>Subject</label>
            <input value={subject} onChange={(e) => setSubject(e.target.value)} placeholder="Your enquiry" />
          </div>
        )}

        <div className="field">
          <label>Message</label>
          <textarea rows={10} value={body} onChange={(e) => setBody(e.target.value)} autoFocus />
          <span className="hint">
            This is an operational message about the customer's own enquiry. Marketing messages
            require recorded consent.
          </span>
        </div>
      </div>
    </Modal>
  );
}

/** Small status pill used wherever a message is listed. */
export function MessageStatus({ status }: { status: string }) {
  const tone = status === 'sent' ? 'good'
    : status === 'received' ? 'cold'
      : status === 'blocked' ? 'warm' : 'danger';
  const label = status === 'sent' ? 'Sent'
    : status === 'received' ? 'Reply'
      : status === 'blocked' ? 'NOT sent' : 'Failed';
  return <Badge tone={tone}>{label}</Badge>;
}
