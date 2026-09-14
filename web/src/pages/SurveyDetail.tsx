import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post, patch } from '../lib/api';
import { Badge, Button, Card, ErrorBlock, Field, Icon, LoadingBlock, useToast } from '../components/ui';
import { dateTime, relative, label, money } from '../lib/format';
import QuotationBuilder from '../components/QuotationBuilder';
import { useSession } from '../lib/session';

/** Mobile-first survey form: big controls, camera upload, autosaves as it goes. */
export default function SurveyDetail() {
  const { id = '' } = useParams();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);
  const { can } = useSession();

  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['survey', id],
    queryFn: () => get(`/surveys/${id}`),
  });

  const [findings, setFindings] = useState<Record<string, any>>({});
  const [notes, setNotes] = useState('');
  const [preferences, setPreferences] = useState('');
  const [recommended, setRecommended] = useState('');
  const [cost, setCost] = useState('');
  const [blockers, setBlockers] = useState('');
  const [feasible, setFeasible] = useState<boolean | null>(null);
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle');
  const [uploading, setUploading] = useState(false);
  const [building, setBuilding] = useState(false);

  useEffect(() => {
    if (!data?.survey) return;
    setFindings(data.survey.findings ?? {});
    setNotes(data.survey.technical_notes ?? '');
    setPreferences(data.survey.customer_preferences ?? '');
    setRecommended(data.survey.recommended_system ?? '');
    setCost(data.survey.estimated_cost ? String(data.survey.estimated_cost) : '');
    setBlockers(data.survey.blockers ?? '');
    setFeasible(data.survey.feasible);
  }, [data?.survey?.id]);

  const save = async (extra: Record<string, unknown> = {}, complete = false) => {
    setSaveState('saving');
    try {
      await patch(`/surveys/${id}`, {
        findings,
        technical_notes: notes || null,
        customer_preferences: preferences || null,
        recommended_system: recommended || null,
        estimated_cost: cost ? Number(cost) : null,
        blockers: blockers || null,
        feasible,
        ...(complete ? { status: 'completed' } : {}),
        ...extra,
      });
      setSaveState('saved');
      queryClient.invalidateQueries({ queryKey: ['survey', id] });
      queryClient.invalidateQueries({ queryKey: ['surveys'] });
      if (complete) {
        toast.success('Survey completed.', 'The findings are now on the lead.');
        queryClient.invalidateQueries({ queryKey: ['lead'] });
      }
      setTimeout(() => setSaveState('idle'), 2200);
    } catch (err) {
      setSaveState('error');
      toast.error(err);
    }
  };

  const uploadPhotos = async (files: FileList | null) => {
    if (!files?.length) return;
    setUploading(true);
    try {
      const body = new FormData();
      Array.from(files).forEach((file) => body.append('files', file));
      body.append('survey_id', id);
      if (data?.survey?.lead_id) body.append('lead_id', data.survey.lead_id);
      await post('/documents', body);
      queryClient.invalidateQueries({ queryKey: ['survey', id] });
      toast.success(`${files.length} photo(s) uploaded.`);
    } catch (err) { toast.error(err); } finally { setUploading(false); }
  };

  if (isLoading) return <div className="page"><LoadingBlock rows={4} height={80} /></div>;
  if (error) return <div className="page"><ErrorBlock error={error} onRetry={refetch} /></div>;

  const survey = data.survey;
  const done = survey.status === 'completed';

  return (
    <div className="page" style={{ maxWidth: 820 }}>
      <div className="row gap-4 mb-4 small">
        <Link to="/app/surveys" className="muted" style={{ textDecoration: 'none' }}>Site surveys</Link>
        <span className="dim">/</span>
        <span className="dim">{survey.lead_name ?? 'survey'}</span>
      </div>

      <Card padded={false}>
        <div className="card-body">
          <div className="row between wrap gap-4 top">
            <div>
              <h1>{survey.lead_name ?? 'Site survey'}</h1>
              <div className="small muted" style={{ marginTop: 3 }}>
                {survey.address ?? 'no address recorded'}
              </div>
              <div className="row gap-4 wrap small muted mt-2">
                <Badge outline>{label(survey.project_type)}</Badge>
                <span>{survey.scheduled_at ? `${dateTime(survey.scheduled_at)} (${relative(survey.scheduled_at)})` : 'not scheduled'}</span>
                {survey.technician_name && <span>{survey.technician_name}</span>}
              </div>
            </div>
            <Badge tone={done ? 'good' : survey.status === 'cancelled' ? 'danger' : 'cold'}>{label(survey.status)}</Badge>
          </div>
        </div>
        <div className="card-body tight row gap-4 wrap" style={{ borderTop: '1px solid var(--border)' }}>
          {survey.address && (
            <a className="btn sm" href={`https://maps.google.com/?q=${encodeURIComponent(survey.address)}`} target="_blank" rel="noreferrer">
              <Icon name="target" size={14} />Navigate
            </a>
          )}
          {survey.lead_phone && <a className="btn sm" href={`tel:${survey.lead_phone}`}><Icon name="phone" size={14} />Call customer</a>}
          {survey.lead_id && <Button size="sm" onClick={() => navigate(`/app/leads/${survey.lead_id}`)}>Open lead</Button>}
          <div className="grow" />
          <span className="small" style={{ color: saveState === 'error' ? 'var(--danger)' : saveState === 'saved' ? 'var(--good)' : 'var(--ink-3)' }}>
            {saveState === 'saving' ? 'Saving…' : saveState === 'saved' ? 'Saved' : saveState === 'error' ? 'Could not save' : ''}
          </span>
        </div>
      </Card>

      <div className="col gap-6 mt-4">
        {/* ---- checklist ---- */}
        {data.checklist.map((section: any) => (
          <Card key={section.section} title={section.section}>
            <div className="grid c2">
              {section.fields.map((field: any) => (
                <Field key={field.key} label={field.label}>
                  {field.type === 'boolean' ? (
                    <div className="chips">
                      {[['yes', 'Yes'], ['no', 'No']].map(([value, text]) => (
                        <button
                          key={value} type="button"
                          className={`chip ${String(findings[field.key]) === value ? 'on' : ''}`}
                          onClick={() => setFindings((f) => ({ ...f, [field.key]: value }))}
                          disabled={done}
                        >
                          {text}
                        </button>
                      ))}
                    </div>
                  ) : field.type === 'select' ? (
                    <select
                      value={findings[field.key] ?? ''} disabled={done}
                      onChange={(e) => setFindings((f) => ({ ...f, [field.key]: e.target.value }))}
                    >
                      <option value="">Not recorded</option>
                      {field.options.map((option: string) => <option key={option} value={option}>{option}</option>)}
                    </select>
                  ) : field.type === 'number' ? (
                    <input
                      type="number" inputMode="decimal" value={findings[field.key] ?? ''} disabled={done}
                      onChange={(e) => setFindings((f) => ({ ...f, [field.key]: e.target.value }))}
                    />
                  ) : (
                    <input
                      value={findings[field.key] ?? ''} disabled={done}
                      onChange={(e) => setFindings((f) => ({ ...f, [field.key]: e.target.value }))}
                    />
                  )}
                </Field>
              ))}
            </div>
          </Card>
        ))}

        {/* ---- photos ---- */}
        <Card
          title="Photos"
          subtitle="Roof, electrical panel, meter, plant room, anything the designer will need"
          actions={
            <Button size="sm" icon="camera" loading={uploading} onClick={() => fileInput.current?.click()} disabled={done}>
              Add photos
            </Button>
          }
        >
          <input
            ref={fileInput} type="file" accept="image/*" capture="environment" multiple
            style={{ display: 'none' }} onChange={(e) => uploadPhotos(e.target.files)}
          />
          {data.photos.length === 0 ? (
            <p className="small muted" style={{ margin: 0 }}>No photos yet. On a phone this opens the camera directly.</p>
          ) : (
            <div className="grid" style={{ gridTemplateColumns: 'repeat(auto-fill, minmax(110px, 1fr))' }}>
              {data.photos.map((photo: any) => (
                <a key={photo.id} href={`/api/documents/${photo.id}`} target="_blank" rel="noreferrer">
                  {photo.mime_type.startsWith('image/') ? (
                    <img
                      src={`/api/documents/${photo.id}`} alt={photo.filename} loading="lazy"
                      style={{ width: '100%', aspectRatio: '4/3', objectFit: 'cover', borderRadius: 'var(--radius-sm)', border: '1px solid var(--border)' }}
                    />
                  ) : (
                    <div className="card center" style={{ padding: 14 }}><Icon name="doc" size={18} /></div>
                  )}
                  <div className="tiny dim truncate mt-2">{photo.filename}</div>
                </a>
              ))}
            </div>
          )}
        </Card>

        {/* ---- assessment ---- */}
        <Card title="Technical assessment">
          <div className="col gap-6">
            <Field label="Is the project feasible as discussed?">
              <div className="chips">
                {[[true, 'Yes, proceed'], [false, 'No — blockers']].map(([value, text]) => (
                  <button
                    key={String(value)} type="button" disabled={done}
                    className={`chip ${feasible === value ? 'on' : ''}`}
                    onClick={() => setFeasible(value as boolean)}
                  >
                    {text as string}
                  </button>
                ))}
              </div>
            </Field>
            <Field label="Recommended system" hint="Exactly what you would install — this goes onto the quotation.">
              <input value={recommended} disabled={done} onChange={(e) => setRecommended(e.target.value)} placeholder="10.35 kWp (23 x 450 Wp), 10 kW hybrid inverter, 10 kWh LFP battery" />
            </Field>
            <div className="grid c2">
              <Field label="Estimated cost (€)" hint="Used as the lead value when none is set.">
                <input type="number" inputMode="decimal" value={cost} disabled={done} onChange={(e) => setCost(e.target.value)} />
              </Field>
              <Field label="Blockers">
                <input value={blockers} disabled={done} onChange={(e) => setBlockers(e.target.value)} placeholder="Panel needs upgrading, no scaffolding access…" />
              </Field>
            </div>
            <Field label="Technical notes">
              <textarea rows={4} value={notes} disabled={done} onChange={(e) => setNotes(e.target.value)} placeholder="What you measured, what you observed, what the designer must know." />
            </Field>
            <Field label="Customer preferences">
              <textarea rows={2} value={preferences} disabled={done} onChange={(e) => setPreferences(e.target.value)} placeholder="Wants panels off the street elevation, prefers a specific brand…" />
            </Field>
          </div>
        </Card>

        {!done && (
          <div className="row gap-4 wrap" style={{ position: 'sticky', bottom: 12 }}>
            <Button block={false} onClick={() => save()} loading={saveState === 'saving'}>Save progress</Button>
            <Button
              variant="primary" className="grow"
              onClick={() => save({}, true)}
              loading={saveState === 'saving'}
            >
              Complete the survey
            </Button>
          </div>
        )}

        {done && (
          <Card>
            <div className="row gap-6 wrap">
              <span style={{ color: 'var(--good)' }}><Icon name="check" size={22} /></span>
              <div className="grow" style={{ minWidth: 180 }}>
                <h3 style={{ margin: 0 }}>Survey completed</h3>
                <p className="small muted" style={{ margin: '2px 0 0' }}>
                  {relative(survey.completed_at)}
                  {survey.estimated_cost ? ` — ${money(survey.estimated_cost)} estimated` : ''}.
                  The findings are on the lead timeline.
                </p>
              </div>
              {survey.lead_id && can('quotes:write') && (
                <Button variant="primary" icon="quote" onClick={() => setBuilding(true)}>
                  Create quotation
                </Button>
              )}
            </div>
            {survey.lead_id && can('quotes:write') && (
              <p className="tiny dim" style={{ margin: '10px 0 0' }}>
                The quotation opens pre-filled from this survey and your price list. You review and
                edit every line before it is created — nothing is sent to the customer automatically.
              </p>
            )}
          </Card>
        )}
      </div>

      {building && (
        <QuotationBuilder
          leadId={survey.lead_id}
          surveyId={survey.id}
          onClose={() => setBuilding(false)}
          onSaved={(quote: any) => { setBuilding(false); navigate(`/app/quotations/${quote.id}`); }}
        />
      )}
    </div>
  );
}
