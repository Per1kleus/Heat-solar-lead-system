import { useState } from 'react';
import { Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { get, post } from '../lib/api';
import { Badge, Button, Card, EmptyState, Icon, useToast } from './ui';
import { relative, dateTime, label as labelOf } from '../lib/format';
import MessageComposer, { MessageStatus, type ComposerChannel } from './MessageComposer';

/**
 * Everything about talking to this customer, in one place: how to reach them,
 * which channels actually work right now, when they were last contacted, and
 * what was sent — including what was NOT sent and why.
 */
export default function CommunicationPanel({
  lead, messages, lastContact, onCall, onRefresh,
}: {
  lead: any;
  messages: any[];
  lastContact: any | null;
  onCall: () => void;
  onRefresh: () => void;
}) {
  const [composer, setComposer] = useState<ComposerChannel | null>(null);
  const [busy, setBusy] = useState(false);
  const toast = useToast();

  const { data: channelData } = useQuery({
    queryKey: ['channels', lead.id],
    queryFn: () => get(`/messages/channels?lead_id=${lead.id}`),
    staleTime: 60_000,
  });
  const channels: any[] = channelData?.channels ?? [];
  const channelFor = (key: string) => channels.find((c) => c.key === key);
  const notConnected = channels.filter((c) => ['email', 'whatsapp'].includes(c.key) && !c.connected);

  const toggleOptOut = async () => {
    setBusy(true);
    try {
      const next = !lead.messaging_opt_out;
      const result = await post(`/leads/${lead.id}/messaging-opt-out`, { opted_out: next });
      toast.success(
        next ? 'Automatic messages stopped for this contact.' : 'Automatic messages allowed again.',
        next && result.stopped > 0 ? `${result.stopped} running sequence(s) stopped.` : undefined,
      );
      onRefresh();
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  const recent = messages.slice(0, 5);

  return (
    <>
      <Card
        title={<h2 className="row gap-4"><Icon name="inbox" size={16} />Talk to {lead.first_name}</h2>}
        padded={false}
      >
        <div className="card-body tight col gap-4">
          {/* --- the three things you need to reach someone --- */}
          <dl className="kv" style={{ margin: 0 }}>
            <dt>Phone</dt>
            <dd>{lead.phone ? <a href={`tel:${lead.phone}`}>{lead.phone}</a> : <span className="dim">none on file</span>}</dd>
            <dt>Email</dt>
            <dd style={{ minWidth: 0 }}>
              {lead.email
                ? <a href={`mailto:${lead.email}`} className="truncate" style={{ display: 'block' }}>{lead.email}</a>
                : <span className="dim">none on file</span>}
            </dd>
            <dt>Prefers</dt>
            <dd>{labelOf(lead.preferred_contact ?? 'phone')}</dd>
            <dt>Last contact</dt>
            <dd>
              {lastContact
                ? <span title={dateTime(lastContact.occurred_at)}>{relative(lastContact.occurred_at)} · {labelOf(lastContact.type)}</span>
                : <span className="dim">never contacted</span>}
            </dd>
          </dl>

          {/* --- the actions --- */}
          <div className="row gap-4 wrap">
            <Button
              size="sm" variant="primary" icon="whatsapp"
              disabled={!lead.phone}
              title={lead.phone ? undefined : 'No phone number on file'}
              onClick={() => setComposer('whatsapp')}
            >
              WhatsApp
            </Button>
            <Button
              size="sm" icon="mail" disabled={!lead.email}
              title={lead.email ? undefined : 'No email on file'}
              onClick={() => setComposer('email')}
            >
              Email
            </Button>
            <Button size="sm" icon="phone" disabled={!lead.phone} onClick={onCall}>Call</Button>
          </div>

          {/* --- what is and is not possible right now --- */}
          {notConnected.length > 0 && (
            <div className="banner warn" style={{ margin: 0 }}>
              <Icon name="alert" size={15} />
              <span>
                {notConnected.map((c) => c.label).join(' and ')}{' '}
                {notConnected.length === 1 ? 'is' : 'are'} not connected, so nothing can be sent from
                VoltaFlow on {notConnected.length === 1 ? 'that channel' : 'those channels'} yet.{' '}
                <Link to="/app/settings/integrations">Connect {notConnected.length === 1 ? 'it' : 'them'}</Link>.
              </span>
            </div>
          )}

          {lead.messaging_opt_out && (
            <div className="banner warn" style={{ margin: 0 }}>
              <Icon name="alert" size={15} />
              <span>This contact has opted out of automatic messages. You can still write to them by hand.</span>
            </div>
          )}

          <div className="row gap-4 wrap tiny dim">
            {(['whatsapp', 'email', 'sms'] as const).map((key) => {
              const c = channelFor(key);
              if (!c) return null;
              return (
                <span key={key} className="row gap-4" title={c.hint}>
                  <span className="dot" style={{ background: c.connected ? 'var(--good)' : 'var(--ink-3)' }} />
                  {c.label} {c.connected ? 'ready' : key === 'sms' ? 'unavailable' : 'not connected'}
                </span>
              );
            })}
          </div>
        </div>

        {/* --- history, with failures visible --- */}
        <div style={{ borderTop: '1px solid var(--border)' }}>
          {recent.length === 0 ? (
            <EmptyState
              icon="mail" title="Nothing sent yet"
              message="Messages you send from VoltaFlow appear here with their real delivery status."
            />
          ) : (
            recent.map((message: any) => (
              <div key={message.id} className="attention-item" style={{ alignItems: 'flex-start' }}>
                <Icon name={message.channel === 'email' ? 'mail' : message.channel === 'whatsapp' ? 'whatsapp' : 'phone'} size={14} />
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row gap-4" style={{ minWidth: 0 }}>
                    <span className="small strong truncate">
                      {message.subject || (message.body ?? '').slice(0, 60) || 'Message'}
                    </span>
                    <MessageStatus status={message.status} />
                    {message.automation_run_id && <Badge title="Sent by a follow-up sequence">auto</Badge>}
                  </div>
                  <div className="tiny dim">
                    {message.direction === 'inbound' ? 'Received' : 'Sent'} {relative(message.created_at)}
                    {message.user_first_name ? ` · ${message.user_first_name}` : ''}
                  </div>
                  {message.error && (
                    <div className="tiny" style={{ color: 'var(--warm)', marginTop: 2 }}>{message.error}</div>
                  )}
                </div>
              </div>
            ))
          )}
        </div>

        <div className="card-body tight row gap-4 wrap" style={{ borderTop: '1px solid var(--border)' }}>
          <span className="tiny dim grow" style={{ minWidth: 0 }}>
            {messages.length > recent.length ? `${messages.length} messages in total` : 'Operational messages only'}
          </span>
          <Button size="sm" variant="ghost" loading={busy} onClick={toggleOptOut}>
            {lead.messaging_opt_out ? 'Allow automatic messages' : 'Stop automatic messages'}
          </Button>
        </div>
      </Card>

      {composer && (
        <MessageComposer
          lead={lead} channel={composer}
          onClose={() => setComposer(null)}
          onSent={onRefresh}
        />
      )}
    </>
  );
}
