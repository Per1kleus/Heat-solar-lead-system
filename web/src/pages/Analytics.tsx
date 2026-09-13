import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import {
  Bar, BarChart, CartesianGrid, Cell, Line, LineChart, ResponsiveContainer,
  Tooltip, XAxis, YAxis,
} from 'recharts';
import { get, download } from '../lib/api';
import { useSession } from '../lib/session';
import {
  Badge, Button, Card, EmptyState, ErrorBlock, Kpi, LoadingBlock, Tabs, useToast,
} from '../components/ui';
import { money, moneyShort, number, percent, label } from '../lib/format';

const RANGES = [
  { key: '30', label: 'Last 30 days' },
  { key: '90', label: 'Last 90 days' },
  { key: '180', label: 'Last 6 months' },
  { key: '365', label: 'Last 12 months' },
];

export default function Analytics() {
  const [params, setParams] = useSearchParams();
  const { organization, can } = useSession();
  const toast = useToast();
  const currency = organization?.currency ?? 'EUR';
  const tab = params.get('tab') ?? 'sales';
  const rangeDays = params.get('days') ?? '180';

  const range = useMemo(() => {
    const to = new Date().toISOString();
    const from = new Date(Date.now() - Number(rangeDays) * 86_400_000).toISOString();
    return `from=${from}&to=${to}`;
  }, [rangeDays]);

  const setParam = (key: string, value: string) => {
    const next = new URLSearchParams(params);
    next.set(key, value);
    setParams(next, { replace: true });
  };

  return (
    <div className="page viz">
      <div className="page-head">
        <div>
          <h1>Analytics</h1>
          <p className="muted small" style={{ margin: 0 }}>
            Every figure is calculated live from your own records.
          </p>
        </div>
        <div className="row gap-4 wrap">
          <select value={rangeDays} onChange={(e) => setParam('days', e.target.value)} style={{ width: 'auto' }} aria-label="Date range">
            {RANGES.map((r) => <option key={r.key} value={r.key}>{r.label}</option>)}
          </select>
          {can('data:export') && (
            <Button icon="download" onClick={() => download('/data/export/source_performance', 'source-performance.csv').catch(toast.error)}>
              Export
            </Button>
          )}
        </div>
      </div>

      <Tabs
        active={tab} onChange={(key) => setParam('tab', key)}
        tabs={[
          { key: 'sales', label: 'Sales' },
          { key: 'sources', label: 'Marketing sources' },
          ...(can('analytics:team') ? [{ key: 'team', label: 'Salespeople' }] : []),
          { key: 'forecast', label: 'Revenue forecast' },
        ]}
      />

      <div className="mt-6">
        {tab === 'sales' && <SalesTab range={range} currency={currency} />}
        {tab === 'sources' && <SourcesTab range={range} currency={currency} />}
        {tab === 'team' && <TeamTab range={range} currency={currency} />}
        {tab === 'forecast' && <ForecastTab currency={currency} />}
      </div>
    </div>
  );
}

// ---------- shared chart pieces ----------

function VizTooltip({ active, payload, label: tipLabel, currency, moneyKeys = [] }: any) {
  if (!active || !payload?.length) return null;
  return (
    <div className="viz-tooltip">
      <div className="strong mb-2">{tipLabel}</div>
      {payload.map((entry: any) => (
        <div key={entry.dataKey} className="row between" style={{ gap: 10 }}>
          <span className="row" style={{ gap: 6 }}>
            <span className="viz-swatch" style={{ background: entry.color }} />
            <span className="k">{entry.name}</span>
          </span>
          <span className="strong">
            {moneyKeys.includes(entry.dataKey) ? money(entry.value, currency) : number(entry.value)}
          </span>
        </div>
      ))}
    </div>
  );
}

function Legend({ items }: { items: { label: string; color: string }[] }) {
  return (
    <div className="viz-legend mt-2">
      {items.map((item) => (
        <span key={item.label}>
          <span className="viz-swatch" style={{ background: item.color }} />
          {item.label}
        </span>
      ))}
    </div>
  );
}

const AXIS = { fontSize: 11, fill: 'var(--viz-axis)' };

// ---------- sales ----------

function SalesTab({ range, currency }: { range: string; currency: string }) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['analytics-sales', range],
    queryFn: () => get(`/analytics/sales?${range}`),
  });

  if (isLoading) return <LoadingBlock rows={3} height={180} />;
  if (error) return <ErrorBlock error={error} onRetry={refetch} />;

  const { funnel, metrics, monthly, by_stage: byStage, by_project_type: byType, lost_reasons: lostReasons } = data;

  const funnelSteps = [
    { key: 'leads', label: 'Leads received', value: funnel.leads },
    { key: 'contacted', label: 'Contacted', value: funnel.contacted },
    { key: 'qualified', label: 'Qualified', value: funnel.qualified },
    { key: 'quoted', label: 'Quoted', value: funnel.quoted },
    { key: 'won', label: 'Won', value: funnel.won },
  ];
  const funnelMax = Math.max(funnel.leads, 1);
  const seqSteps = ['var(--seq-1)', 'var(--seq-2)', 'var(--seq-3)', 'var(--seq-4)', 'var(--seq-5)'];

  const monthlyData = monthly.map((row: any) => ({
    ...row,
    periodLabel: new Date(`${row.period}-01`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }),
  }));

  return (
    <div className="col gap-6">
      <div className="kpi-grid">
        <Kpi label="Leads received" value={number(funnel.leads)} />
        <Kpi label="Contact rate" value={percent(metrics.contact_rate, 1)} sub={`${funnel.contacted} contacted`} />
        <Kpi label="Quotations issued" value={number(funnel.quoted)} sub={money(metrics.quote_value, currency)} />
        <Kpi label="Deals won" value={number(funnel.won)} tone="good" sub={money(metrics.revenue, currency)} />
        <Kpi label="Win rate" value={percent(metrics.conversion_rate, 1)} sub="of decided deals" />
        <Kpi label="Average deal" value={money(metrics.avg_deal_value, currency)} />
        <Kpi label="Sales cycle" value={`${metrics.avg_cycle_days} days`} sub="enquiry to won" />
        <Kpi label="Response time" value={`${metrics.avg_response_hours} h`} sub="to first contact" tone={metrics.avg_response_hours > 24 ? 'warn' : 'good'} />
      </div>

      <div className="grid c2" style={{ alignItems: 'start' }}>
        <Card title="Conversion funnel" subtitle={`${percent(metrics.lead_to_won_rate, 1)} of all leads end as a sale`}>
          {funnel.leads === 0 ? (
            <EmptyState icon="analytics" title="No leads in this period" />
          ) : (
            <div className="col gap-4">
              {funnelSteps.map((step, index) => (
                  <div key={step.key}>
                    <div className="row between small mb-2">
                      <span>{step.label}</span>
                      <span className="dim">
                        {index > 0 && (
                          <span style={{ marginRight: 8 }}>{percent((step.value / funnelMax) * 100, 0)} of all leads</span>
                        )}
                        <strong style={{ color: 'var(--ink)' }}>{number(step.value)}</strong>
                      </span>
                    </div>
                    <div className="funnel-step">
                      <div
                        className="funnel-bar"
                        style={{ width: `${Math.min(100, Math.max((step.value / funnelMax) * 100, 1.5))}%`, background: seqSteps[index] }}
                      />
                    </div>
                  </div>
              ))}
              <div className="row between small mt-2" style={{ paddingTop: 8, borderTop: '1px solid var(--border)' }}>
                <span className="dim">Lost</span>
                <span className="strong" style={{ color: 'var(--danger)' }}>{number(funnel.lost)}</span>
              </div>
            </div>
          )}
        </Card>

        <Card title="Volume by month" subtitle="Leads received against deals decided">
          {monthlyData.length === 0 ? <EmptyState icon="analytics" title="Not enough history yet" /> : (
            <>
              <ResponsiveContainer width="100%" height={230}>
                <BarChart data={monthlyData} margin={{ top: 6, right: 6, left: -18, bottom: 0 }} barGap={2}>
                  <CartesianGrid stroke="var(--viz-grid)" vertical={false} />
                  <XAxis dataKey="periodLabel" tick={AXIS} tickLine={false} axisLine={{ stroke: 'var(--viz-grid)' }} />
                  <YAxis tick={AXIS} tickLine={false} axisLine={false} width={44} allowDecimals={false} />
                  <Tooltip content={<VizTooltip currency={currency} />} cursor={{ fill: 'var(--surface-3)' }} />
                  <Bar dataKey="leads" name="Leads" fill="var(--series-1)" radius={[4, 4, 0, 0]} maxBarSize={26} />
                  <Bar dataKey="won" name="Won" fill="var(--series-3)" radius={[4, 4, 0, 0]} maxBarSize={26} />
                  <Bar dataKey="lost" name="Lost" fill="var(--series-2)" radius={[4, 4, 0, 0]} maxBarSize={26} />
                </BarChart>
              </ResponsiveContainer>
              <Legend items={[
                { label: 'Leads', color: 'var(--series-1)' },
                { label: 'Won', color: 'var(--series-3)' },
                { label: 'Lost', color: 'var(--series-2)' },
              ]} />
            </>
          )}
        </Card>

        <Card title="Revenue by month" subtitle="Value of deals won">
          {monthlyData.length === 0 ? <EmptyState icon="euro" title="No revenue recorded yet" /> : (
            <ResponsiveContainer width="100%" height={210}>
              <LineChart data={monthlyData} margin={{ top: 6, right: 10, left: -6, bottom: 0 }}>
                <CartesianGrid stroke="var(--viz-grid)" vertical={false} />
                <XAxis dataKey="periodLabel" tick={AXIS} tickLine={false} axisLine={{ stroke: 'var(--viz-grid)' }} />
                <YAxis tick={AXIS} tickLine={false} axisLine={false} width={58} tickFormatter={(v) => moneyShort(v, currency)} />
                <Tooltip content={<VizTooltip currency={currency} moneyKeys={['revenue']} />} cursor={{ stroke: 'var(--viz-grid)' }} />
                <Line
                  type="monotone" dataKey="revenue" name="Revenue"
                  stroke="var(--series-1)" strokeWidth={2}
                  dot={{ r: 3.5, strokeWidth: 0, fill: 'var(--series-1)' }}
                  activeDot={{ r: 5.5, stroke: 'var(--surface)', strokeWidth: 2 }}
                />
              </LineChart>
            </ResponsiveContainer>
          )}
        </Card>

        <Card title="By product" subtitle="Where the volume and the money are">
          {byType.length === 0 ? <EmptyState icon="analytics" title="No data yet" /> : (
            <div className="table-wrap">
              <table className="data">
                <thead><tr><th>Product</th><th className="num">Leads</th><th className="num">Won</th><th className="num">Revenue</th><th className="num">Avg value</th></tr></thead>
                <tbody>
                  {byType.map((row: any) => (
                    <tr key={row.project_type} style={{ cursor: 'default' }}>
                      <td className="strong">{row.project_type}</td>
                      <td className="num">{number(row.leads)}</td>
                      <td className="num">{number(row.won)}</td>
                      <td className="num strong">{money(row.revenue, currency)}</td>
                      <td className="num dim">{money(row.avg_value, currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>

      <div className="grid c2" style={{ alignItems: 'start' }}>
        <Card title="Where deals sit right now" subtitle="Open pipeline by stage, with how long they have been there">
          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Stage</th><th className="num">Deals</th><th className="num">Value</th><th className="num">Avg days in stage</th></tr></thead>
              <tbody>
                {byStage.map((row: any) => (
                  <tr key={row.key} style={{ cursor: 'default' }}>
                    <td><span className="row gap-4"><span className="dot" style={{ color: row.color }} />{row.name}</span></td>
                    <td className="num">{number(row.count)}</td>
                    <td className="num strong">{money(row.value, currency)}</td>
                    <td className="num" style={{ color: row.avg_days_in_stage > 14 ? 'var(--warm)' : 'var(--ink-2)' }}>
                      {row.avg_days_in_stage ? Math.round(row.avg_days_in_stage) : '—'}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </Card>

        <Card title="Why deals are lost">
          {lostReasons.length === 0 ? <EmptyState icon="check" title="Nothing lost in this period" /> : (
            <>
              <ResponsiveContainer width="100%" height={Math.max(160, lostReasons.length * 34)}>
                <BarChart data={lostReasons} layout="vertical" margin={{ top: 0, right: 12, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="var(--viz-grid)" horizontal={false} />
                  <XAxis type="number" tick={AXIS} tickLine={false} axisLine={false} tickFormatter={(v) => moneyShort(v, currency)} />
                  <YAxis type="category" dataKey="reason" tick={AXIS} tickLine={false} axisLine={false} width={126} />
                  <Tooltip content={<VizTooltip currency={currency} moneyKeys={['value']} />} cursor={{ fill: 'var(--surface-3)' }} />
                  <Bar dataKey="value" name="Value lost" fill="var(--series-2)" radius={[0, 4, 4, 0]} maxBarSize={20} />
                </BarChart>
              </ResponsiveContainer>
              <div className="small dim">Bars show the value of the leads lost for each reason.</div>
            </>
          )}
        </Card>
      </div>
    </div>
  );
}

// ---------- sources ----------

function SourcesTab({ range, currency }: { range: string; currency: string }) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['analytics-sources', range],
    queryFn: () => get(`/analytics/sources?${range}`),
  });

  if (isLoading) return <LoadingBlock rows={3} height={180} />;
  if (error) return <ErrorBlock error={error} onRetry={refetch} />;

  const sources = data.sources.filter((s: any) => s.leads > 0);
  const best = [...sources].sort((a, b) => b.revenue - a.revenue)[0];
  const chartData = sources.slice(0, 10);

  return (
    <div className="col gap-6">
      {sources.length === 0 ? (
        <Card><EmptyState icon="analytics" title="No leads in this period" message="Once leads arrive, this page shows exactly which channel pays for itself." /></Card>
      ) : (
        <>
          {best && best.revenue > 0 && (
            <div className="banner success">
              <span style={{ fontSize: 16 }}>💰</span>
              <span>
                <strong>{best.name}</strong> produced {money(best.revenue, currency)} from {best.leads} leads
                ({percent(best.conversion_rate, 1)} conversion, {money(best.revenue_per_lead, currency)} per lead).
              </span>
            </div>
          )}

          <Card title="Revenue by source" subtitle="The only ranking that matters">
            <ResponsiveContainer width="100%" height={Math.max(200, chartData.length * 36)}>
              <BarChart data={chartData} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
                <CartesianGrid stroke="var(--viz-grid)" horizontal={false} />
                <XAxis type="number" tick={AXIS} tickLine={false} axisLine={false} tickFormatter={(v) => moneyShort(v, currency)} />
                <YAxis type="category" dataKey="name" tick={AXIS} tickLine={false} axisLine={false} width={132} />
                <Tooltip content={<VizTooltip currency={currency} moneyKeys={['revenue']} />} cursor={{ fill: 'var(--surface-3)' }} />
                <Bar dataKey="revenue" name="Revenue" radius={[0, 4, 4, 0]} maxBarSize={22}>
                  {chartData.map((row: any) => (
                    <Cell key={row.id} fill={row.revenue > 0 ? 'var(--series-1)' : 'var(--surface-3)'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </Card>

          <Card title="Source performance" subtitle="Leads → qualified → quotes → won → revenue" padded={false}>
            <div className="table-wrap">
              <table className="data">
                <thead>
                  <tr>
                    <th>Source</th><th className="hide-mobile">Type</th>
                    <th className="num">Leads</th><th className="num hide-mobile">Contacted</th>
                    <th className="num">Qualified</th><th className="num">Quotes</th>
                    <th className="num">Won</th><th className="num">Revenue</th>
                    <th className="num">Conversion</th><th className="num hide-mobile">€ / lead</th>
                  </tr>
                </thead>
                <tbody>
                  {sources.map((source: any) => (
                    <tr key={source.id} style={{ cursor: 'default' }}>
                      <td className="strong">{source.name}</td>
                      <td className="hide-mobile"><Badge outline>{source.category}</Badge></td>
                      <td className="num">{number(source.leads)}</td>
                      <td className="num hide-mobile dim">{number(source.contacted)}</td>
                      <td className="num">{number(source.qualified)}</td>
                      <td className="num">{number(source.quotes)}</td>
                      <td className="num strong">{number(source.won)}</td>
                      <td className="num strong">{money(source.revenue, currency)}</td>
                      <td className="num">{percent(source.conversion_rate, 1)}</td>
                      <td className="num hide-mobile dim">{money(source.revenue_per_lead, currency)}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </Card>
        </>
      )}
    </div>
  );
}

// ---------- team ----------

function TeamTab({ range, currency }: { range: string; currency: string }) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['analytics-team', range],
    queryFn: () => get(`/analytics/team?${range}`),
  });

  if (isLoading) return <LoadingBlock rows={3} height={160} />;
  if (error) return <ErrorBlock error={error} onRetry={refetch} />;

  const team = data.team ?? [];

  return (
    <div className="col gap-6">
      <Card title="Revenue by salesperson">
        {team.length === 0 ? <EmptyState icon="customers" title="No sales users yet" /> : (
          <ResponsiveContainer width="100%" height={Math.max(180, team.length * 44)}>
            <BarChart data={team} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
              <CartesianGrid stroke="var(--viz-grid)" horizontal={false} />
              <XAxis type="number" tick={AXIS} tickLine={false} axisLine={false} tickFormatter={(v) => moneyShort(v, currency)} />
              <YAxis type="category" dataKey="full_name" tick={AXIS} tickLine={false} axisLine={false} width={132} />
              <Tooltip content={<VizTooltip currency={currency} moneyKeys={['revenue', 'open_pipeline']} />} cursor={{ fill: 'var(--surface-3)' }} />
              <Bar dataKey="revenue" name="Revenue won" fill="var(--series-1)" radius={[0, 4, 4, 0]} maxBarSize={18} />
              <Bar dataKey="open_pipeline" name="Open pipeline" fill="var(--series-3)" radius={[0, 4, 4, 0]} maxBarSize={18} />
            </BarChart>
          </ResponsiveContainer>
        )}
        <Legend items={[
          { label: 'Revenue won', color: 'var(--series-1)' },
          { label: 'Open pipeline', color: 'var(--series-3)' },
        ]} />
      </Card>

      <Card title="Performance detail" padded={false}>
        <div className="table-wrap">
          <table className="data">
            <thead>
              <tr>
                <th>Salesperson</th><th className="num">Leads</th><th className="num">Contact rate</th>
                <th className="num">Response time</th><th className="num">Quotes</th><th className="num">Won</th>
                <th className="num">Conversion</th><th className="num">Revenue</th>
                <th className="num">Touches</th><th className="num">Overdue</th>
              </tr>
            </thead>
            <tbody>
              {team.map((person: any) => (
                <tr key={person.id} style={{ cursor: 'default' }}>
                  <td>
                    <div className="strong">{person.full_name}</div>
                    <div className="tiny dim">{label(person.role)}</div>
                  </td>
                  <td className="num">{number(person.leads_assigned)}</td>
                  <td className="num">{percent(person.contact_rate, 1)}</td>
                  <td className="num" style={{ color: person.avg_response_hours > 24 ? 'var(--warm)' : undefined }}>
                    {person.avg_response_hours ? `${person.avg_response_hours} h` : '—'}
                  </td>
                  <td className="num">{number(person.quotes_sent)}</td>
                  <td className="num strong">{number(person.won)}</td>
                  <td className="num">{percent(person.conversion_rate, 1)}</td>
                  <td className="num strong">{money(person.revenue, currency)}</td>
                  <td className="num dim">{number(person.customer_touches)}</td>
                  <td className="num">
                    {person.overdue_tasks > 0
                      ? <Badge tone="danger">{person.overdue_tasks}</Badge>
                      : <span className="dim">0</span>}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </Card>
    </div>
  );
}

// ---------- forecast ----------

function ForecastTab({ currency }: { currency: string }) {
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['analytics-forecast'],
    queryFn: () => get('/analytics/forecast'),
  });

  if (isLoading) return <LoadingBlock rows={3} height={160} />;
  if (error) return <ErrorBlock error={error} onRetry={refetch} />;

  const byMonth = data.by_month
    .filter((row: any) => row.period !== 'unscheduled')
    .map((row: any) => ({
      ...row,
      periodLabel: new Date(`${row.period}-01`).toLocaleDateString('en-GB', { month: 'short', year: '2-digit' }),
    }));
  const unscheduled = data.by_month.find((row: any) => row.period === 'unscheduled');

  return (
    <div className="col gap-6">
      <div className="kpi-grid">
        <Kpi label="Pipeline value" value={money(data.pipeline_value, currency)} sub="all open deals" />
        <Kpi label="Average probability" value={percent(data.avg_probability)} sub="weighted by stage" />
        <Kpi label="Expected revenue" value={money(data.weighted_pipeline, currency)} tone="good" sub="pipeline × probability" />
        <Kpi label="Won this month" value={money(data.won_this_month, currency)} tone="good" />
        <Kpi label="Quotations outstanding" value={data.quotes_outstanding?.count ?? 0} sub={money(data.quotes_outstanding?.value ?? 0, currency)} tone="warn" />
      </div>

      <div className="banner info">
        <span style={{ fontSize: 15 }}>📈</span>
        <span>
          {money(data.pipeline_value, currency)} of open pipeline at an average probability of{' '}
          {percent(data.avg_probability)} gives an expected <strong>{money(data.weighted_pipeline, currency)}</strong>.
          Change the probability of any stage in Settings → Pipeline to re-weight this.
        </span>
      </div>

      <div className="grid c2" style={{ alignItems: 'start' }}>
        <Card title="Pipeline by stage" subtitle="Full value against the probability-weighted value">
          {data.by_stage.length === 0 ? <EmptyState icon="pipeline" title="No open deals" /> : (
            <>
              <ResponsiveContainer width="100%" height={Math.max(200, data.by_stage.length * 40)}>
                <BarChart data={data.by_stage} layout="vertical" margin={{ top: 0, right: 16, left: 0, bottom: 0 }}>
                  <CartesianGrid stroke="var(--viz-grid)" horizontal={false} />
                  <XAxis type="number" tick={AXIS} tickLine={false} axisLine={false} tickFormatter={(v) => moneyShort(v, currency)} />
                  <YAxis type="category" dataKey="name" tick={AXIS} tickLine={false} axisLine={false} width={132} />
                  <Tooltip content={<VizTooltip currency={currency} moneyKeys={['value', 'weighted']} />} cursor={{ fill: 'var(--surface-3)' }} />
                  <Bar dataKey="value" name="Pipeline value" fill="var(--series-1)" radius={[0, 4, 4, 0]} maxBarSize={16} />
                  <Bar dataKey="weighted" name="Weighted" fill="var(--series-3)" radius={[0, 4, 4, 0]} maxBarSize={16} />
                </BarChart>
              </ResponsiveContainer>
              <Legend items={[
                { label: 'Pipeline value', color: 'var(--series-1)' },
                { label: 'Weighted by probability', color: 'var(--series-3)' },
              ]} />
            </>
          )}
        </Card>

        <Card title="Expected close by month" subtitle="Based on the expected closing date on each lead">
          {byMonth.length === 0 ? (
            <EmptyState
              icon="calendar" title="No expected closing dates"
              message="Set an expected closing date on your open leads and the forecast fills in."
            />
          ) : (
            <>
              <ResponsiveContainer width="100%" height={230}>
                <BarChart data={byMonth} margin={{ top: 6, right: 6, left: -6, bottom: 0 }} barGap={2}>
                  <CartesianGrid stroke="var(--viz-grid)" vertical={false} />
                  <XAxis dataKey="periodLabel" tick={AXIS} tickLine={false} axisLine={{ stroke: 'var(--viz-grid)' }} />
                  <YAxis tick={AXIS} tickLine={false} axisLine={false} width={58} tickFormatter={(v) => moneyShort(v, currency)} />
                  <Tooltip content={<VizTooltip currency={currency} moneyKeys={['value', 'weighted']} />} cursor={{ fill: 'var(--surface-3)' }} />
                  <Bar dataKey="value" name="Pipeline value" fill="var(--series-1)" radius={[4, 4, 0, 0]} maxBarSize={26} />
                  <Bar dataKey="weighted" name="Weighted" fill="var(--series-3)" radius={[4, 4, 0, 0]} maxBarSize={26} />
                </BarChart>
              </ResponsiveContainer>
              <Legend items={[
                { label: 'Pipeline value', color: 'var(--series-1)' },
                { label: 'Weighted by probability', color: 'var(--series-3)' },
              ]} />
            </>
          )}
          {unscheduled && unscheduled.count > 0 && (
            <div className="banner warn mt-4">
              <span>⚠️</span>
              <span>
                {unscheduled.count} deal{unscheduled.count === 1 ? '' : 's'} worth {money(unscheduled.value, currency)}{' '}
                have no expected closing date and are not in this forecast.
              </span>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
