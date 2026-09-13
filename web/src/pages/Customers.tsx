import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { get, download } from '../lib/api';
import { useSession } from '../lib/session';
import { Badge, Button, Card, EmptyState, ErrorBlock, LoadingBlock, SearchInput, useDebounced, useToast } from '../components/ui';
import { money, relative } from '../lib/format';

export default function Customers() {
  const navigate = useNavigate();
  const toast = useToast();
  const { organization, can } = useSession();
  const currency = organization?.currency ?? 'EUR';
  const [search, setSearch] = useState('');
  const debounced = useDebounced(search, 300);

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['customers', debounced],
    queryFn: () => get(`/customers?${debounced.trim() ? `search=${encodeURIComponent(debounced.trim())}&` : ''}limit=150`),
    placeholderData: (prev) => prev,
  });

  const customers = data?.customers ?? [];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Customers</h1>
          <p className="muted small" style={{ margin: 0 }}>
            People you have sold to. Each one can carry several projects — that is where cross-selling starts.
          </p>
        </div>
        {can('data:export') && (
          <Button icon="download" onClick={() => download('/data/export/customers', 'customers.csv').catch(toast.error)}>Export</Button>
        )}
      </div>

      <Card padded={false}>
        <div className="card-body tight">
          <SearchInput value={search} onChange={setSearch} placeholder="Name, phone, email or company…" />
        </div>
        {isLoading ? (
          <div style={{ padding: 14 }}><LoadingBlock rows={5} height={40} /></div>
        ) : error ? (
          <div style={{ padding: 14 }}><ErrorBlock error={error} onRetry={refetch} /></div>
        ) : customers.length === 0 ? (
          <EmptyState icon="customers" title="No customers yet" message="A customer record is created automatically the first time you win a deal." />
        ) : (
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>
                  <th>Customer</th><th className="hide-mobile">Contact</th><th className="hide-mobile">City</th>
                  <th className="num">Projects</th><th className="num">Lifetime value</th>
                  <th className="hide-mobile">Open leads</th><th className="hide-mobile">Consent</th>
                </tr>
              </thead>
              <tbody>
                {customers.map((customer: any) => (
                  <tr key={customer.id} onClick={() => navigate(`/app/customers/${customer.id}`)}>
                    <td>
                      <div className="strong">{customer.full_name}</div>
                      {customer.company && <div className="tiny dim">{customer.company}</div>}
                    </td>
                    <td className="hide-mobile small">
                      {customer.phone && <div>{customer.phone}</div>}
                      {customer.email && <div className="dim truncate" style={{ maxWidth: 200 }}>{customer.email}</div>}
                    </td>
                    <td className="hide-mobile small">{customer.city ?? '—'}</td>
                    <td className="num">{customer.project_count}</td>
                    <td className="num strong">{money(customer.total_value, currency)}</td>
                    <td className="hide-mobile">{customer.open_leads > 0 ? <Badge tone="accent">{customer.open_leads}</Badge> : <span className="dim">—</span>}</td>
                    <td className="hide-mobile">{customer.marketing_consent ? <Badge tone="good">Marketing</Badge> : <span className="dim small">operational only</span>}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </Card>
    </div>
  );
}
