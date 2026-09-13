import { useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { get } from '../lib/api';
import { useSession } from '../lib/session';
import { Badge, Button, Card, EmptyState, ErrorBlock, Icon, LoadingBlock, Tabs } from '../components/ui';
import { dateTime, relative, label, money } from '../lib/format';

export default function Surveys() {
  const navigate = useNavigate();
  const { user } = useSession();
  const [status, setStatus] = useState('scheduled');

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['surveys', status],
    queryFn: () => get(`/surveys${status === 'all' ? '' : `?status=${status}`}`),
  });

  const surveys = data?.surveys ?? [];

  return (
    <div className="page">
      <div className="page-head">
        <div>
          <h1>Site surveys</h1>
          <p className="muted small" style={{ margin: 0 }}>
            {user?.role === 'technician'
              ? 'Your visits, with the checklist and camera ready.'
              : 'Technical assessments booked against your leads.'}
          </p>
        </div>
      </div>

      <Card padded={false}>
        <div style={{ padding: '0 14px' }}>
          <Tabs
            active={status} onChange={setStatus}
            tabs={[
              { key: 'scheduled', label: 'Scheduled' },
              { key: 'in_progress', label: 'In progress' },
              { key: 'completed', label: 'Completed' },
              { key: 'all', label: 'All' },
            ]}
          />
        </div>

        {isLoading ? (
          <div style={{ padding: 14 }}><LoadingBlock rows={4} height={60} /></div>
        ) : error ? (
          <div style={{ padding: 14 }}><ErrorBlock error={error} onRetry={refetch} /></div>
        ) : surveys.length === 0 ? (
          <EmptyState
            icon="survey"
            title={status === 'scheduled' ? 'No visits booked' : 'Nothing here'}
            message="Book a survey from a lead — the checklist and the photo upload are generated for you."
          />
        ) : (
          <div>
            {surveys.map((survey: any) => (
              <button
                key={survey.id} className="attention-item"
                style={{ width: '100%', textAlign: 'left', border: 0, borderBottom: '1px solid var(--border)', background: 'none', font: 'inherit' }}
                onClick={() => navigate(`/app/surveys/${survey.id}`)}
              >
                <span style={{ color: 'var(--accent)' }}><Icon name="survey" size={18} /></span>
                <div className="grow" style={{ minWidth: 0 }}>
                  <div className="row gap-4 wrap">
                    <span className="strong truncate">{survey.lead_name ?? 'Survey'}</span>
                    <Badge outline>{label(survey.project_type)}</Badge>
                    {survey.feasible === false && <Badge tone="danger">not feasible</Badge>}
                  </div>
                  <div className="tiny dim truncate">
                    {survey.scheduled_at ? `${dateTime(survey.scheduled_at)} (${relative(survey.scheduled_at)})` : 'not scheduled'}
                    {survey.address ? ` · ${survey.address}` : ''}
                  </div>
                  {survey.recommended_system && <div className="small truncate">{survey.recommended_system}</div>}
                </div>
                <div className="right nowrap hide-mobile">
                  {survey.technician_name && <div className="small">{survey.technician_name}</div>}
                  {survey.estimated_cost ? <div className="tiny dim">{money(survey.estimated_cost)}</div> : null}
                </div>
                <Badge tone={survey.status === 'completed' ? 'good' : survey.status === 'cancelled' ? 'danger' : 'cold'}>
                  {label(survey.status)}
                </Badge>
              </button>
            ))}
          </div>
        )}
      </Card>
    </div>
  );
}
