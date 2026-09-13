import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { money, date } from '../lib/format';

/** The page a customer opens from the quotation link in their email. */
export default function PublicQuote() {
  const { token = '' } = useParams();
  const [decision, setDecision] = useState<'accepted' | 'rejected' | null>(null);
  const [note, setNote] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [answered, setAnswered] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const { data, isLoading, error: loadError, refetch } = useQuery({
    queryKey: ['public-quote', token],
    queryFn: async () => {
      const response = await fetch(`/api/public/quote/${token}`);
      if (!response.ok) throw new Error('This quotation link is no longer valid.');
      return response.json();
    },
    retry: false,
  });

  if (isLoading) {
    return <div className="page" style={{ maxWidth: 840 }}><div className="skeleton" style={{ height: 320 }} /></div>;
  }
  if (loadError || !data) {
    return (
      <div className="page" style={{ maxWidth: 560 }}>
        <div className="card" style={{ padding: 24, textAlign: 'center' }}>
          <h1 style={{ marginBottom: 6 }}>Link no longer valid</h1>
          <p className="muted">Please contact the company for an up-to-date quotation.</p>
        </div>
      </div>
    );
  }

  const { quotation: quote, company } = data;
  const included = quote.items.filter((item: any) => !item.is_optional);
  const optional = quote.items.filter((item: any) => item.is_optional);
  const settled = ['accepted', 'rejected'].includes(quote.status) || answered;

  const respond = async () => {
    if (!decision) return;
    setSubmitting(true);
    setError(null);
    try {
      const response = await fetch(`/api/public/quote/${token}/respond`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ decision, note: note || undefined }),
      });
      const payload = await response.json();
      if (!response.ok) throw new Error(payload?.error?.message ?? 'Your answer could not be recorded.');
      setAnswered(payload.message);
      refetch();
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Your answer could not be recorded.');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="public-shell">
      <div className="page" style={{ maxWidth: 840 }}>
        <div className="card">
          <div className="card-body">
            <div className="row between wrap gap-6 top">
              <div>
                {company.logo_url
                  ? <img src={company.logo_url} alt={company.name} style={{ maxHeight: 52, marginBottom: 8 }} />
                  : <h2>{company.name}</h2>}
                <div className="small muted">
                  {[company.address, [company.postal_code, company.city].filter(Boolean).join(' '), company.phone, company.email]
                    .filter(Boolean).map((line: string) => <div key={line}>{line}</div>)}
                  {company.vat_number && <div>VAT {company.vat_number}</div>}
                </div>
              </div>
              <div className="right">
                <h1>Quotation</h1>
                <div className="small muted">No. {quote.number}</div>
                <div className="small muted">Valid until {quote.valid_until ? date(quote.valid_until) : '—'}</div>
                <div className="small muted">For {quote.customer_name}</div>
              </div>
            </div>
          </div>

          <div className="card-body" style={{ borderTop: '1px solid var(--border)' }}>
            <h2>{quote.title}</h2>
            {quote.description && <p className="muted small mt-2">{quote.description}</p>}
          </div>

          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr><th>Description</th><th className="num">Qty</th><th>Unit</th><th className="num">Price</th><th className="num">Total</th></tr>
              </thead>
              <tbody>
                {included.map((item: any) => (
                  <tr key={item.id} style={{ cursor: 'default' }}>
                    <td>
                      <div className="strong">{item.name}</div>
                      {item.description && <div className="tiny dim">{item.description}</div>}
                    </td>
                    <td className="num">{item.quantity}</td>
                    <td>{item.unit}</td>
                    <td className="num">{money(item.unit_price, quote.currency, 2)}</td>
                    <td className="num strong">{money(item.line_total, quote.currency, 2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <div className="card-body" style={{ borderTop: '1px solid var(--border)' }}>
            <div style={{ maxWidth: 320, marginLeft: 'auto' }}>
              <div className="row between small"><span className="dim">Subtotal</span><span>{money(quote.subtotal, quote.currency, 2)}</span></div>
              {quote.discount_amount > 0 && (
                <div className="row between small"><span className="dim">Discount</span><span>−{money(quote.discount_amount, quote.currency, 2)}</span></div>
              )}
              <div className="row between small"><span className="dim">VAT {quote.vat_rate}%</span><span>{money(quote.vat_amount, quote.currency, 2)}</span></div>
              <div className="row between mt-2" style={{ paddingTop: 9, borderTop: '2px solid var(--accent)' }}>
                <strong>Total</strong><strong style={{ fontSize: 20 }}>{money(quote.total, quote.currency, 2)}</strong>
              </div>
            </div>
          </div>

          {optional.length > 0 && (
            <div className="card-body" style={{ borderTop: '1px solid var(--border)' }}>
              <h3 className="mb-2">Optional extras</h3>
              {optional.map((item: any) => (
                <div key={item.id} className="row between small" style={{ padding: '3px 0' }}>
                  <span>{item.name} — {item.quantity} {item.unit}</span>
                  <span className="strong">{money(item.line_total, quote.currency, 2)}</span>
                </div>
              ))}
            </div>
          )}

          {(quote.notes || quote.terms) && (
            <div className="card-body" style={{ borderTop: '1px solid var(--border)' }}>
              {quote.notes && (<><h3 className="mb-2">Notes</h3><p className="small muted" style={{ whiteSpace: 'pre-wrap' }}>{quote.notes}</p></>)}
              {quote.terms && (<><h3 className="mb-2 mt-4">Terms and conditions</h3><p className="small muted" style={{ whiteSpace: 'pre-wrap' }}>{quote.terms}</p></>)}
            </div>
          )}

          <div className="card-foot">
            <div className="row between wrap gap-4" style={{ width: '100%' }}>
              <a className="btn" href={`/api/public/quote/${token}/pdf`} target="_blank" rel="noreferrer">Download the PDF</a>
              {quote.owner_name && <span className="small muted">Prepared by {quote.owner_name}</span>}
            </div>
          </div>
        </div>

        <div className="card mt-6">
          <div className="card-body">
            {answered ? (
              <div className="banner success"><span>{answered}</span></div>
            ) : quote.status === 'accepted' ? (
              <div className="banner success"><span>You accepted this quotation. {company.name} will be in touch to arrange the installation.</span></div>
            ) : quote.status === 'rejected' ? (
              <div className="banner"><span>This quotation was declined. Contact {company.name} if anything has changed.</span></div>
            ) : quote.expired ? (
              <div className="banner warn"><span>This quotation has expired. Please contact {company.name} for an up-to-date price.</span></div>
            ) : (
              <>
                <h2 className="mb-2">Would you like to go ahead?</h2>
                <p className="small muted">
                  Your answer goes straight to {company.name}. Nothing is charged here.
                </p>
                {error && <div className="banner error mb-4" role="alert"><span>{error}</span></div>}
                <div className="chips mb-4">
                  <button
                    type="button" className={`chip ${decision === 'accepted' ? 'on' : ''}`}
                    onClick={() => setDecision('accepted')}
                  >
                    Yes, I accept this quotation
                  </button>
                  <button
                    type="button" className={`chip ${decision === 'rejected' ? 'on' : ''}`}
                    onClick={() => setDecision('rejected')}
                  >
                    Not this time
                  </button>
                </div>
                {decision && (
                  <div className="field mb-4">
                    <label htmlFor="note">
                      {decision === 'accepted' ? 'Anything you would like to add?' : 'Would you tell us why? (optional)'}
                    </label>
                    <textarea id="note" rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
                  </div>
                )}
                <button className="btn primary lg" disabled={!decision || submitting} onClick={respond}>
                  {submitting ? 'Sending…' : 'Send my answer'}
                </button>
              </>
            )}
          </div>
        </div>

        <p className="center small dim mt-6">
          {company.name}{company.website ? ` · ${company.website}` : ''}
        </p>
      </div>
    </div>
  );
}
