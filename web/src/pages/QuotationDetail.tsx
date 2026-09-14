import { useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, openInNewTab } from '../lib/api';
import { useSession } from '../lib/session';
import {
  Badge, Button, Card, ConfirmDialog, ErrorBlock, Icon, LoadingBlock, Modal, useToast,
} from '../components/ui';
import QuotationBuilder from '../components/QuotationBuilder';
import { money, date, dateTime, relative, label } from '../lib/format';
import { quoteTone } from './LeadDetail';

export default function QuotationDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const { organization, can } = useSession();
  const currency = organization?.currency ?? 'EUR';

  const [dialog, setDialog] = useState<string | null>(null);
  const [editing, setEditing] = useState(false);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['quotation', id],
    queryFn: () => get(`/quotations/${id}`),
  });

  const refresh = () => {
    queryClient.invalidateQueries({ queryKey: ['quotation', id] });
    queryClient.invalidateQueries({ queryKey: ['quotations'] });
    queryClient.invalidateQueries({ queryKey: ['dashboard'] });
  };

  if (isLoading) return <div className="page"><LoadingBlock rows={4} height={90} /></div>;
  if (error) return <div className="page"><ErrorBlock error={error} onRetry={refetch} /></div>;

  const quote = data.quotation;
  const publicLink = `${window.location.origin}/q/${quote.public_token}`;
  const included = quote.items.filter((i: any) => !i.is_optional);
  const optional = quote.items.filter((i: any) => i.is_optional);

  const setStatus = async (status: string, extra: Record<string, unknown> = {}) => {
    try {
      await post(`/quotations/${id}/status`, { status, ...extra });
      refresh();
      toast.success(`Marked as ${label(status).toLowerCase()}.`);
    } catch (err) { toast.error(err); }
  };

  return (
    <div className="page">
      <div className="row gap-4 mb-4 small">
        <Link to="/app/quotations" className="muted" style={{ textDecoration: 'none' }}>Quotations</Link>
        <span className="dim">/</span>
        <span className="dim mono">{quote.number}</span>
      </div>

      <Card padded={false}>
        <div className="card-body">
          <div className="row between wrap gap-6 top">
            <div style={{ minWidth: 0 }}>
              <div className="row gap-4 wrap">
                <h1 className="truncate">{quote.title}</h1>
                <Badge tone={quoteTone(quote.status)}>{label(quote.status)}</Badge>
                {quote.version > 1 && <Badge outline>v{quote.version}</Badge>}
              </div>
              <div className="row gap-4 wrap small muted" style={{ marginTop: 4 }}>
                <span className="mono">{quote.number}</span>
                {quote.lead_id && <Link to={`/app/leads/${quote.lead_id}`}>{quote.customer_name}</Link>}
                {!quote.lead_id && <span>{quote.customer_name}</span>}
                <span>created {relative(quote.created_at)}</span>
                {quote.owner_name && <span>by {quote.owner_name}</span>}
              </div>
            </div>
            <div className="right">
              <div style={{ fontSize: 24, fontWeight: 700, letterSpacing: '-.02em' }}>{money(quote.total, currency, 2)}</div>
              <div className="small muted">including {quote.vat_rate}% VAT</div>
              {quote.valid_until && (
                <div className="tiny" style={{ color: new Date(quote.valid_until) < new Date() ? 'var(--danger)' : 'var(--ink-3)' }}>
                  Valid until {date(quote.valid_until)}
                </div>
              )}
            </div>
          </div>
        </div>

        <div className="card-body tight row gap-4 wrap" style={{ borderTop: '1px solid var(--border)' }}>
          <Button size="sm" icon="doc" onClick={() => openInNewTab(`/quotations/${id}/pdf`).catch(toast.error)}>View PDF</Button>
          {can('quotes:send') && ['draft', 'sent', 'viewed', 'awaiting_response', 'expired'].includes(quote.status) && (
            <Button size="sm" variant="primary" icon="mail" onClick={() => setDialog('send')}>
              {quote.status === 'draft' ? 'Send to customer' : 'Send again'}
            </Button>
          )}
          <Button size="sm" icon="link" onClick={() => { navigator.clipboard?.writeText(publicLink); toast.success('Customer link copied.'); }}>
            Copy customer link
          </Button>
          {can('quotes:write') && quote.status === 'draft' && <Button size="sm" icon="edit" onClick={() => setEditing(true)}>Edit</Button>}
          {can('quotes:write') && !['accepted', 'rejected'].includes(quote.status) && (
            <>
              <Button size="sm" onClick={() => setStatus('accepted')}>Mark accepted</Button>
              <Button size="sm" onClick={() => setDialog('reject')}>Mark rejected</Button>
            </>
          )}
          {can('quotes:write') && <Button size="sm" onClick={() => setDialog('duplicate')}>New revision</Button>}
          <div className="grow" />
          {quote.status === 'draft' && can('quotes:write') && (
            <Button size="sm" variant="ghost" icon="trash" onClick={() => setDialog('delete')}>Delete draft</Button>
          )}
        </div>
      </Card>

      <div className="grid split mt-4">
        <Card title="Scope and pricing" padded={false}>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Description</th><th className="num">Qty</th><th>Unit</th>
                  <th className="num">Unit price</th><th className="num">Total</th>
                </tr>
              </thead>
              <tbody>
                {included.map((item: any) => (
                  <tr key={item.id} style={{ cursor: 'default' }}>
                    <td>
                      <div className="strong">{item.name}</div>
                      {item.description && <div className="tiny dim">{item.description}</div>}
                      <Badge outline>{item.category}</Badge>
                    </td>
                    <td className="num">{item.quantity}</td>
                    <td>{item.unit}</td>
                    <td className="num">
                      {money(item.unit_price, currency, 2)}
                      {item.discount_pct > 0 && <div className="tiny" style={{ color: 'var(--danger)' }}>−{item.discount_pct}%</div>}
                    </td>
                    <td className="num strong">{money(item.line_total, currency, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card-body" style={{ borderTop: '1px solid var(--border)' }}>
            <div style={{ maxWidth: 320, marginLeft: 'auto' }}>
              <dl className="kv" style={{ gridTemplateColumns: '1fr auto' }}>
                <dt>Subtotal</dt><dd className="right">{money(quote.subtotal, currency, 2)}</dd>
                {quote.discount_amount > 0 && <><dt>Discount</dt><dd className="right" style={{ color: 'var(--danger)' }}>−{money(quote.discount_amount, currency, 2)}</dd></>}
                <dt>VAT {quote.vat_rate}%</dt><dd className="right">{money(quote.vat_amount, currency, 2)}</dd>
              </dl>
              <div className="row between mt-2" style={{ paddingTop: 9, borderTop: '2px solid var(--accent)' }}>
                <strong>Total</strong><strong style={{ fontSize: 18 }}>{money(quote.total, currency, 2)}</strong>
              </div>
            </div>
          </div>

          {optional.length > 0 && (
            <div className="card-body" style={{ borderTop: '1px solid var(--border)' }}>
              <h3 className="mb-2">Optional extras</h3>
              {optional.map((item: any) => (
                <div key={item.id} className="row between small" style={{ padding: '4px 0' }}>
                  <span>{item.name} — {item.quantity} {item.unit}</span>
                  <span className="strong">{money(item.line_total, currency, 2)}</span>
                </div>
              ))}
              <div className="row between mt-2 strong">
                <span>Optional total</span><span>{money(quote.optional_total, currency, 2)}</span>
              </div>
            </div>
          )}

          {(quote.notes || quote.terms) && (
            <div className="card-body" style={{ borderTop: '1px solid var(--border)' }}>
              {quote.notes && (<><h3 className="mb-2">Notes</h3><p className="small muted" style={{ whiteSpace: 'pre-wrap' }}>{quote.notes}</p></>)}
              {quote.terms && (<><h3 className="mb-2 mt-4">Terms</h3><p className="small muted" style={{ whiteSpace: 'pre-wrap' }}>{quote.terms}</p></>)}
            </div>
          )}
        </Card>

        <div className="col gap-6">
          <Card title="Tracking">
            <dl className="kv">
              <dt>Status</dt><dd><Badge tone={quoteTone(quote.status)}>{label(quote.status)}</Badge></dd>
              <dt>Created</dt><dd>{dateTime(quote.created_at)}</dd>
              <dt>Sent</dt><dd>{quote.sent_at ? `${dateTime(quote.sent_at)} (${quote.sent_via ?? '—'})` : <span className="dim">not sent</span>}</dd>
              <dt>First viewed</dt><dd>{quote.first_viewed_at ? relative(quote.first_viewed_at) : <span className="dim">not opened</span>}</dd>
              <dt>Views</dt><dd>{quote.view_count}</dd>
              <dt>Responded</dt><dd>{quote.responded_at ? relative(quote.responded_at) : <span className="dim">no answer yet</span>}</dd>
              <dt>Days since sent</dt><dd>{quote.days_since_sent ?? '—'}</dd>
              <dt>Valid until</dt><dd>{quote.valid_until ? date(quote.valid_until) : '—'}</dd>
            </dl>
            {quote.rejection_reason && (
              <div className="banner warn mt-4"><Icon name="alert" size={15} /><span>{quote.rejection_reason}</span></div>
            )}
          </Card>

          <Card title="Follow-up sequence" subtitle="Created automatically when the quotation is sent">
            {data.tasks.length === 0 ? (
              <p className="small muted" style={{ margin: 0 }}>
                {quote.status === 'draft'
                  ? 'The day 2 / 5 / 10 / 20 sequence starts when you send this quotation.'
                  : 'No open follow-ups — the customer has answered, or the sequence has finished.'}
              </p>
            ) : (
              <div className="col gap-4">
                {data.tasks.map((task: any) => (
                  <div key={task.id} className="row between gap-4 small">
                    <span className="truncate">{task.title}</span>
                    <span className="dim nowrap">{relative(task.due_at)}</span>
                  </div>
                ))}
              </div>
            )}
          </Card>

          {data.messages.length > 0 && (
            <Card title="Delivery">
              {data.messages.map((message: any) => (
                <div key={message.id} className="row between gap-4 small" style={{ padding: '4px 0' }}>
                  <span className="truncate">{message.subject ?? message.channel}</span>
                  <Badge tone={message.status === 'sent' ? 'good' : message.status === 'blocked' || message.status === 'failed' ? 'danger' : ''}>
                    {label(message.status)}
                  </Badge>
                </div>
              ))}
              {data.messages.some((m: any) => m.error) && (
                <div className="banner error mt-4">
                  <Icon name="alert" size={15} />
                  <span>{data.messages.find((m: any) => m.error).error}</span>
                </div>
              )}
            </Card>
          )}
        </div>
      </div>

      {editing && (
        <QuotationBuilder
          quotation={quote}
          onClose={() => setEditing(false)}
          onSaved={() => { setEditing(false); refresh(); }}
        />
      )}
      {dialog === 'send' && <SendDialog quote={quote} onClose={() => setDialog(null)} onSent={refresh} />}
      {dialog === 'reject' && (
        <RejectDialog onClose={() => setDialog(null)} onConfirm={async (reason) => { await setStatus('rejected', { rejection_reason: reason }); setDialog(null); }} />
      )}
      {dialog === 'duplicate' && (
        <ConfirmDialog
          title="Create a new revision"
          message="A copy of this quotation is created as a draft you can edit. The original stays on the record."
          confirmLabel="Create revision"
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            try {
              const result = await post(`/quotations/${id}/duplicate`);
              setDialog(null);
              navigate(`/app/quotations/${result.quotation.id}`);
              toast.success('Revision created.');
            } catch (err) { toast.error(err); }
          }}
        />
      )}
      {dialog === 'delete' && (
        <ConfirmDialog
          title="Delete this draft" tone="danger" confirmLabel="Delete"
          message="This draft will be removed permanently. Sent quotations can only be cancelled, not deleted."
          onCancel={() => setDialog(null)}
          onConfirm={async () => {
            try {
              await post(`/quotations/${id}`, undefined, { method: 'DELETE' } as any);
              toast.success('Draft deleted.');
              navigate('/app/quotations');
            } catch (err) { toast.error(err); }
          }}
        />
      )}
    </div>
  );
}

function SendDialog({ quote, onClose, onSent }: { quote: any; onClose: () => void; onSent: () => void }) {
  const toast = useToast();
  const [via, setVia] = useState<'email' | 'whatsapp' | 'manual'>('email');
  const [sending, setSending] = useState(false);
  const [message, setMessage] = useState('');
  const [subject, setSubject] = useState(`Your quotation ${quote.number}`);
  const [failure, setFailure] = useState<string | null>(null);

  const { data: channels } = useQuery({ queryKey: ['channels'], queryFn: () => get('/messages/channels'), staleTime: 120_000 });
  const channel = channels?.channels?.find((c: any) => c.key === via);
  const connected = via === 'manual' || channel?.connected;

  const send = async () => {
    setSending(true);
    setFailure(null);
    try {
      await post(`/quotations/${quote.id}/send`, {
        via, subject: via === 'email' ? subject : undefined,
        message: message || undefined, attach_pdf: true,
      });
      toast.success(
        via === 'manual' ? 'Recorded as sent.' : `Quotation sent by ${via}.`,
        'The follow-up sequence has started.',
      );
      onSent();
      onClose();
    } catch (err: any) {
      setFailure(err?.message ?? 'The quotation could not be sent.');
    } finally {
      setSending(false);
    }
  };

  return (
    <Modal
      title={`Send ${quote.number}`} subtitle={quote.customer_name} onClose={onClose}
      footer={
        <>
          <Button onClick={onClose} disabled={sending}>Cancel</Button>
          <Button variant="primary" loading={sending} disabled={!connected} onClick={send}>
            {via === 'manual' ? 'Record as sent' : 'Send now'}
          </Button>
        </>
      }
    >
      <div className="col gap-6">
        <div className="field">
          <label>How are you sending it?</label>
          <div className="chips">
            {(['email', 'whatsapp', 'manual'] as const).map((option) => {
              const info = channels?.channels?.find((c: any) => c.key === option);
              return (
                <button
                  key={option} type="button"
                  className={`chip ${via === option ? 'on' : ''}`}
                  onClick={() => { setVia(option); setFailure(null); }}
                >
                  {option === 'manual' ? 'I sent it myself' : option === 'email' ? 'Email' : 'WhatsApp'}
                  {option !== 'manual' && !info?.connected ? ' · not connected' : ''}
                </button>
              );
            })}
          </div>
        </div>

        {!connected && (
          <div className="banner warn">
            <Icon name="alert" size={15} />
            <span>{channel?.hint ?? 'This channel is not connected.'} Choose “I sent it myself” to record that you sent the PDF another way.</span>
          </div>
        )}

        {via === 'manual' && (
          <div className="banner info">
            <Icon name="dot" size={15} />
            <span>
              Nothing is sent from VoltaFlow. The quotation is marked as sent so the follow-up sequence and
              the pipeline stay accurate.
            </span>
          </div>
        )}

        {via === 'email' && (
          <>
            <div className="field">
              <label>Subject</label>
              <input value={subject} onChange={(e) => setSubject(e.target.value)} />
            </div>
            <div className="field">
              <label>Message</label>
              <textarea rows={5} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Leave blank to use your “Quotation sent” template." />
              <span className="hint">The PDF is attached automatically.</span>
            </div>
          </>
        )}

        {via === 'whatsapp' && (
          <div className="field">
            <label>Message</label>
            <textarea rows={4} value={message} onChange={(e) => setMessage(e.target.value)} placeholder="Hello, here is the quotation we discussed…" />
            <span className="hint">WhatsApp cannot carry the PDF attachment — include the customer link in the message.</span>
          </div>
        )}

        {failure && (
          <div className="banner error" role="alert">
            <Icon name="alert" size={15} />
            <div>
              <strong>Not sent.</strong>
              <div className="small">{failure}</div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  );
}

function RejectDialog({ onClose, onConfirm }: { onClose: () => void; onConfirm: (reason: string) => Promise<void> }) {
  const [reason, setReason] = useState('');
  const [saving, setSaving] = useState(false);
  return (
    <Modal
      title="Customer rejected this quotation" onClose={onClose} width="narrow"
      footer={
        <>
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="danger" loading={saving} onClick={async () => { setSaving(true); try { await onConfirm(reason); } finally { setSaving(false); } }}>
            Mark rejected
          </Button>
        </>
      }
    >
      <div className="field">
        <label>Why? (this feeds your lost-reason analytics)</label>
        <textarea rows={3} autoFocus value={reason} onChange={(e) => setReason(e.target.value)} placeholder="Went with a cheaper offer, postponed the project…" />
      </div>
    </Modal>
  );
}
