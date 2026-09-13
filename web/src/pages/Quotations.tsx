import { useEffect, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { get, download } from '../lib/api';
import { useSession } from '../lib/session';
import {
  Badge, Button, Card, EmptyState, ErrorBlock, Kpi, LoadingBlock, SearchInput, useDebounced, useToast,
} from '../components/ui';
import QuotationBuilder from '../components/QuotationBuilder';
import { money, relative, date, label } from '../lib/format';
import { quoteTone } from './LeadDetail';

export default function Quotations() {
  const [params, setParams] = useSearchParams();
  const navigate = useNavigate();
  const toast = useToast();
  const { organization, can } = useSession();
  const currency = organization?.currency ?? 'EUR';

  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 300);
  const [builderFor, setBuilderFor] = useState<string | null>(params.get('new') === '1' ? params.get('lead_id') : null);

  const status = params.get('status') ?? '';
  const queryString = new URLSearchParams({
    ...(status ? { status } : {}),
    ...(debounced.trim() ? { search: debounced.trim() } : {}),
    limit: '150',
  }).toString();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['quotations', queryString],
    queryFn: () => get(`/quotations?${queryString}`),
    placeholderData: (prev) => prev,
  });

  useEffect(() => {
    if (params.get('new') === '1') {
      setBuilderFor(params.get('lead_id'));
    }
  }, [params]);

  const quotations = data?.quotations ?? [];
  const buckets = Object.fromEntries((data?.buckets ?? []).map((b: any) => [b.status, b]));
  const count = (key: string) => buckets[key]?.n ?? 0;
  const total = (key: string) => buckets[key]?.total ?? 0;

  const setStatus = (value: string) => {
    const next = new URLSearchParams(params);
    if (value) next.set('status', value); else next.delete('status');
    next.delete('new');
    setParams(next, { replace: true });
  };

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Quotations</h1>
          <p className="muted small" style={{ margin: 0 }}>
            {money(data?.awaiting_value ?? 0, currency)} is currently sitting in “awaiting response”.
          </p>
        </div>
        <div className="row gap-4">
          {can('data:export') && (
            <Button icon="download" onClick={() => download('/data/export/quotations', 'quotations.csv').catch(toast.error)}>Export</Button>
          )}
          {can('quotes:write') && <Button icon="plus" variant="primary" onClick={() => setBuilderFor('')}>New quotation</Button>}
        </div>
      </div>

      <div className="kpi-grid mb-6">
        <Kpi label="Drafts" value={count('draft')} sub={money(total('draft'), currency)} onClick={() => setStatus('draft')} />
        <Kpi
          label="Awaiting a response"
          value={count('sent') + count('viewed') + count('awaiting_response')}
          sub={money(total('sent') + total('viewed') + total('awaiting_response'), currency)}
          tone="warn"
          onClick={() => setStatus('sent,viewed,awaiting_response')}
        />
        <Kpi label="Accepted" value={count('accepted')} sub={money(total('accepted'), currency)} tone="good" onClick={() => setStatus('accepted')} />
        <Kpi label="Rejected" value={count('rejected')} sub={money(total('rejected'), currency)} onClick={() => setStatus('rejected')} />
        <Kpi label="Expired" value={count('expired')} sub={money(total('expired'), currency)} tone={count('expired') > 0 ? 'alert' : undefined} onClick={() => setStatus('expired')} />
      </div>

      <Card padded={false}>
        <div className="card-body tight row gap-4 wrap">
          <SearchInput value={search} onChange={setSearch} placeholder="Number, title or customer…" />
          <select value={status} onChange={(e) => setStatus(e.target.value)} style={{ width: 'auto' }} aria-label="Status">
            <option value="">All statuses</option>
            <option value="draft">Draft</option>
            <option value="sent,viewed,awaiting_response">Awaiting a response</option>
            <option value="accepted">Accepted</option>
            <option value="rejected">Rejected</option>
            <option value="expired">Expired</option>
          </select>
          {status && <Button size="sm" variant="ghost" onClick={() => setStatus('')}>Clear</Button>}
        </div>

        {isLoading ? (
          <div style={{ padding: 14 }}><LoadingBlock rows={5} height={40} /></div>
        ) : error ? (
          <div style={{ padding: 14 }}><ErrorBlock error={error} onRetry={refetch} /></div>
        ) : quotations.length === 0 ? (
          <EmptyState
            icon="quote" title="No quotations here"
            message="Build one from a lead and the follow-up sequence starts the moment you send it."
            action={can('quotes:write') ? <Button size="sm" variant="primary" onClick={() => setBuilderFor('')}>New quotation</Button> : undefined}
          />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Number</th><th>Customer</th><th className="hide-mobile">Title</th><th>Status</th>
                  <th className="num">Total</th><th className="hide-mobile">Sent</th>
                  <th className="hide-mobile">Valid until</th><th className="hide-mobile">Owner</th>
                </tr>
              </thead>
              <tbody>
                {quotations.map((quote: any) => (
                  <tr key={quote.id} onClick={() => navigate(`/app/quotations/${quote.id}`)}>
                    <td className="mono nowrap">{quote.number}</td>
                    <td>
                      <div className="strong truncate" style={{ maxWidth: 180 }}>{quote.customer_name}</div>
                      {quote.temperature && <span className="tiny dim">{quote.temperature}</span>}
                    </td>
                    <td className="hide-mobile truncate" style={{ maxWidth: 250 }}>{quote.title}</td>
                    <td>
                      <Badge tone={quoteTone(quote.status)}>{label(quote.status)}</Badge>
                      {quote.days_since_sent !== null && ['sent', 'viewed', 'awaiting_response'].includes(quote.status) && quote.days_since_sent > 7 && (
                        <div className="tiny" style={{ color: 'var(--danger)' }}>{quote.days_since_sent} days</div>
                      )}
                    </td>
                    <td className="num strong nowrap">{money(quote.total, quote.currency ?? currency)}</td>
                    <td className="hide-mobile small dim nowrap">{quote.sent_at ? relative(quote.sent_at) : '—'}</td>
                    <td className="hide-mobile small nowrap" style={{ color: quote.is_expired ? 'var(--danger)' : 'var(--ink-3)' }}>
                      {quote.valid_until ? date(quote.valid_until) : '—'}
                    </td>
                    <td className="hide-mobile small dim nowrap">{quote.owner_name ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>

      {builderFor !== null && (
        <QuotationBuilder
          leadId={builderFor || undefined}
          onClose={() => { setBuilderFor(null); const next = new URLSearchParams(params); next.delete('new'); next.delete('lead_id'); setParams(next, { replace: true }); }}
          onSaved={(quote) => { setBuilderFor(null); navigate(`/app/quotations/${quote.id}`); }}
        />
      )}
    </div>
  );
}
