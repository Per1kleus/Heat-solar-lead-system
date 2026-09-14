import { useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { get, post } from '../lib/api';
import { Badge, Button, Card, Field, Icon, LoadingBlock, useToast } from '../components/ui';
import { csvParse, number } from '../lib/format';

/** Three-phase importer: choose a file → map the columns → review, then commit. */
export default function ImportLeads() {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const toast = useToast();
  const fileInput = useRef<HTMLInputElement>(null);

  const [phase, setPhase] = useState<'upload' | 'map' | 'review' | 'done'>('upload');
  const [fileName, setFileName] = useState('');
  const [headers, setHeaders] = useState<string[]>([]);
  const [rows, setRows] = useState<Record<string, string>[]>([]);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [sourceKey, setSourceKey] = useState('other');
  const [ownerId, setOwnerId] = useState('');
  const [skipDuplicates, setSkipDuplicates] = useState(true);
  const [preview, setPreview] = useState<any>(null);
  const [result, setResult] = useState<any>(null);
  const [busy, setBusy] = useState(false);

  const { data: meta } = useQuery({ queryKey: ['import-fields'], queryFn: () => get('/data/import/fields') });

  const readFile = async (file: File) => {
    if (file.size > 8 * 1024 * 1024) return toast.show('That file is larger than 8 MB. Split it first.', 'error');
    const text = await file.text();
    const parsed = csvParse(text);
    if (parsed.rows.length === 0) return toast.show('That file has no data rows.', 'error');
    setFileName(file.name);
    setHeaders(parsed.headers);
    setRows(parsed.rows);
    // Guess the mapping from the column names — the user confirms it on the next screen.
    const guess: Record<string, string> = {};
    for (const header of parsed.headers) {
      const key = header.toLowerCase().replace(/[^a-z]/g, '');
      const match = (meta?.fields ?? []).find((field: any) => {
        const candidates = [field.key.replace(/_/g, ''), field.label.toLowerCase().replace(/[^a-z]/g, '')];
        return candidates.includes(key) || GUESSES[key] === field.key;
      });
      if (match) guess[header] = match.key;
    }
    setMapping(guess);
    setPhase('map');
  };

  const dryRun = async () => {
    setBusy(true);
    try {
      const response = await post('/data/import/leads', {
        rows, mapping, source_key: sourceKey, owner_id: ownerId || undefined,
        skip_duplicates: skipDuplicates, dry_run: true,
      });
      setPreview(response);
      setPhase('review');
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  const commit = async () => {
    setBusy(true);
    try {
      const response = await post('/data/import/leads', {
        rows, mapping, source_key: sourceKey, owner_id: ownerId || undefined,
        skip_duplicates: skipDuplicates, dry_run: false,
      });
      setResult(response);
      setPhase('done');
      queryClient.invalidateQueries({ queryKey: ['leads'] });
      queryClient.invalidateQueries({ queryKey: ['dashboard'] });
      toast.success(`${response.created} lead(s) imported.`);
    } catch (err) { toast.error(err); } finally { setBusy(false); }
  };

  const mappedRequired = Object.values(mapping).includes('first_name')
    && (Object.values(mapping).includes('phone') || Object.values(mapping).includes('email'));

  return (
    <div className="page" style={{ maxWidth: 1000 }}>
      <div className="page-head">
        <div>
          <h1>Import leads</h1>
          <p className="muted small" style={{ margin: 0 }}>
            Nothing is written until you have seen exactly what will happen.
          </p>
        </div>
        <Button onClick={() => navigate('/app/leads')}>Back to leads</Button>
      </div>

      <div className="steps-bar">
        {['upload', 'map', 'review', 'done'].map((key, index) => (
          <i key={key} className={['upload', 'map', 'review', 'done'].indexOf(phase) >= index ? 'done' : ''} />
        ))}
      </div>

      {phase === 'upload' && (
        <Card title="1. Choose your file" subtitle="A CSV exported from your spreadsheet or your old system. Comma, semicolon or tab separated.">
          <input ref={fileInput} type="file" accept=".csv,text/csv,text/plain" style={{ display: 'none' }}
            onChange={(e) => e.target.files?.[0] && readFile(e.target.files[0])} />
          <div
            className="card center"
            style={{ padding: 34, borderStyle: 'dashed', cursor: 'pointer' }}
            onClick={() => fileInput.current?.click()}
            onDragOver={(e) => e.preventDefault()}
            onDrop={(e) => { e.preventDefault(); const file = e.dataTransfer.files?.[0]; if (file) readFile(file); }}
          >
            <div className="empty-icon"><Icon name="upload" size={20} /></div>
            <h3>Drop a CSV here, or click to choose one</h3>
            <p className="small muted" style={{ margin: 0 }}>Up to 5,000 rows at a time, 8 MB maximum.</p>
          </div>

          <div className="banner mt-6">
            <Icon name="dot" size={15} />
            <span>
              Imported leads do not trigger the new-lead follow-up sequence — otherwise importing a year of
              history would create a year of overdue tasks.
            </span>
          </div>
        </Card>
      )}

      {phase === 'map' && (
        <Card
          title="2. Match your columns"
          subtitle={`${fileName} — ${number(rows.length)} rows, ${headers.length} columns`}
          footer={
            <div className="row between">
              <Button onClick={() => setPhase('upload')}>Choose a different file</Button>
              <Button variant="primary" loading={busy} disabled={!mappedRequired} onClick={dryRun}>Check the file</Button>
            </div>
          }
        >
          {!mappedRequired && (
            <div className="banner warn mb-4">
              <Icon name="alert" size={15} />
              <span>Map at least a first name, and a phone number or an email address.</span>
            </div>
          )}

          <div className="grid c2 mb-6">
            <Field label="Source for every imported lead" hint="You can change it on individual leads afterwards.">
              <select value={sourceKey} onChange={(e) => setSourceKey(e.target.value)}>
                {(meta?.sources ?? []).map((source: any) => <option key={source.key} value={source.key}>{source.name}</option>)}
              </select>
            </Field>
            <Field label="Assign to" hint="An “Owner email” column overrides this row by row.">
              <select value={ownerId} onChange={(e) => setOwnerId(e.target.value)}>
                <option value="">Use my assignment rules</option>
                {(meta?.users ?? []).map((user: any) => (
                  <option key={user.id} value={user.id}>{user.first_name} {user.last_name}</option>
                ))}
              </select>
            </Field>
          </div>

          <div className="table-wrap">
            <table className="data">
              <thead><tr><th>Column in your file</th><th>First value</th><th>Import as</th></tr></thead>
              <tbody>
                {headers.map((header) => (
                  <tr key={header} style={{ cursor: 'default' }}>
                    <td className="strong">{header}</td>
                    <td className="small dim truncate" style={{ maxWidth: 220 }}>{rows[0]?.[header] || '—'}</td>
                    <td>
                      <select
                        value={mapping[header] ?? ''}
                        onChange={(e) => setMapping((m) => ({ ...m, [header]: e.target.value }))}
                        aria-label={`Map ${header}`}
                      >
                        <option value="">Ignore this column</option>
                        {(meta?.fields ?? []).map((field: any) => (
                          <option key={field.key} value={field.key}>{field.label}</option>
                        ))}
                      </select>
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          <label className="check mt-6">
            <input type="checkbox" checked={skipDuplicates} onChange={(e) => setSkipDuplicates(e.target.checked)} />
            <span>Skip rows that match an existing lead or customer by phone or email (recommended)</span>
          </label>
        </Card>
      )}

      {phase === 'review' && preview && (
        <Card
          title="3. Review before importing"
          subtitle="This is a dry run — nothing has been written yet."
          footer={
            <div className="row between">
              <Button onClick={() => setPhase('map')}>Back to mapping</Button>
              <Button variant="primary" loading={busy} disabled={preview.will_import === 0 || preview.allowance.exceeds} onClick={commit}>
                Import {number(preview.will_import)} lead{preview.will_import === 1 ? '' : 's'}
              </Button>
            </div>
          }
        >
          <div className="kpi-grid mb-6">
            <div className="kpi"><span className="kpi-label">Rows in the file</span><span className="kpi-value">{number(preview.total_rows)}</span></div>
            <div className="kpi good"><span className="kpi-label">Will be imported</span><span className="kpi-value">{number(preview.will_import)}</span></div>
            <div className={`kpi ${preview.duplicates.length ? 'warn' : ''}`}>
              <span className="kpi-label">Duplicates</span><span className="kpi-value">{number(preview.duplicates.length)}</span>
              <span className="kpi-sub">{skipDuplicates ? 'will be skipped' : 'will be created anyway'}</span>
            </div>
            <div className={`kpi ${preview.errors.length ? 'alert' : ''}`}>
              <span className="kpi-label">Rows with errors</span><span className="kpi-value">{number(preview.errors.length)}</span>
              <span className="kpi-sub">skipped</span>
            </div>
          </div>

          {preview.allowance.exceeds && (
            <div className="banner error mb-4">
              <Icon name="alert" size={15} />
              <span>
                This import needs {number(preview.will_import)} of your allowance but only {number(preview.allowance.remaining)} leads
                remain on your plan this month. Upgrade, or split the file.
              </span>
            </div>
          )}

          {preview.errors.length > 0 && (
            <div className="mb-6">
              <h3 className="mb-2">Rows that cannot be imported</h3>
              <div className="table-wrap" style={{ maxHeight: 200, overflowY: 'auto' }}>
                <table className="data">
                  <thead><tr><th style={{ width: 70 }}>Row</th><th>Problem</th></tr></thead>
                  <tbody>
                    {preview.errors.map((error: any, index: number) => (
                      <tr key={index} style={{ cursor: 'default' }}>
                        <td className="mono">{error.row}</td>
                        <td className="small">{error.message}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {preview.duplicates.length > 0 && (
            <div className="mb-6">
              <h3 className="mb-2">Duplicates found</h3>
              <div className="table-wrap" style={{ maxHeight: 200, overflowY: 'auto' }}>
                <table className="data">
                  <thead><tr><th style={{ width: 70 }}>Row</th><th>Name</th><th>Matched</th><th>Existing record</th></tr></thead>
                  <tbody>
                    {preview.duplicates.map((duplicate: any, index: number) => (
                      <tr key={index} style={{ cursor: 'default' }}>
                        <td className="mono">{duplicate.row}</td>
                        <td>{duplicate.name}</td>
                        <td><Badge outline>{duplicate.matched_on}</Badge></td>
                        <td className="small">{duplicate.existing}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            </div>
          )}

          {preview.preview.length > 0 ? (
            <>
          <h3 className="mb-2">First rows that will be created</h3>
          <div className="table-wrap">
            <table className="data">
              <thead>
                <tr>{Object.keys(preview.preview[0] ?? {}).filter((k) => k !== '_row').slice(0, 7).map((key) => (
                  <th key={key}>{key.replace(/_/g, ' ')}</th>
                ))}</tr>
              </thead>
              <tbody>
                {preview.preview.map((row: any, index: number) => (
                  <tr key={index} style={{ cursor: 'default' }}>
                    {Object.keys(row).filter((k) => k !== '_row').slice(0, 7).map((key) => (
                      <td key={key} className="small truncate" style={{ maxWidth: 160 }}>
                        {Array.isArray(row[key]) ? row[key].join(', ') : String(row[key] ?? '')}
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
            </>
          ) : (
            <div className="banner info">
              <Icon name="dot" size={15} />
              <span>Nothing in this file would be created. Fix the rows above, or go back and check the column mapping.</span>
            </div>
          )}
        </Card>
      )}

      {phase === 'done' && result && (
        <Card title="Import complete">
          <div className="banner success mb-6">
            <Icon name="check" size={16} />
            <span>
              {number(result.created)} lead{result.created === 1 ? '' : 's'} imported
              {result.skipped_duplicates > 0 ? `, ${result.skipped_duplicates} duplicate(s) skipped` : ''}
              {result.errors.length > 0 ? `, ${result.errors.length} row(s) could not be imported` : ''}.
            </span>
          </div>
          {result.errors.length > 0 && (
            <div className="table-wrap mb-6" style={{ maxHeight: 220, overflowY: 'auto' }}>
              <table className="data">
                <thead><tr><th style={{ width: 70 }}>Row</th><th>Problem</th></tr></thead>
                <tbody>
                  {result.errors.map((error: any, index: number) => (
                    <tr key={index} style={{ cursor: 'default' }}>
                      <td className="mono">{error.row}</td><td className="small">{error.message}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
          <div className="row gap-4">
            <Button variant="primary" onClick={() => navigate('/app/leads')}>See the imported leads</Button>
            <Button onClick={() => { setPhase('upload'); setResult(null); setPreview(null); setRows([]); setHeaders([]); }}>
              Import another file
            </Button>
          </div>
        </Card>
      )}
    </div>
  );
}

/** Common spreadsheet header names mapped to our fields. */
const GUESSES: Record<string, string> = {
  name: 'first_name', firstname: 'first_name', fname: 'first_name', onoma: 'first_name',
  surname: 'last_name', lastname: 'last_name', familyname: 'last_name', epitheto: 'last_name',
  tel: 'phone', telephone: 'phone', mobile: 'phone', phonenumber: 'phone', tilefono: 'phone',
  mail: 'email', emailaddress: 'email',
  town: 'city', poli: 'city', location: 'city',
  street: 'address', addr: 'address',
  postcode: 'postal_code', zip: 'postal_code', zipcode: 'postal_code', tk: 'postal_code',
  value: 'estimated_value', amount: 'estimated_value', budget: 'estimated_value',
  interest: 'project_types', product: 'project_types', type: 'project_types',
  source: 'source_key', channel: 'source_key',
  notes: 'notes', comment: 'notes', comments: 'notes',
  company: 'company', business: 'company',
  owner: 'owner_email', salesperson: 'owner_email',
};
