import { Router } from 'express';
import { z } from 'zod';
import multer from 'multer';
import fs from 'node:fs';
import path from 'node:path';
import { all, get, insert, parseJson, run } from '../lib/db.ts';
import { ah } from '../middleware/errors.ts';
import { requirePermission } from '../middleware/context.ts';
import { config } from '../lib/config.ts';
import { newId, randomToken } from '../lib/ids.ts';
import { nowIso } from '../lib/time.ts';
import { badRequest, forbidden, notFound } from '../lib/errors.ts';
import { logActivity, rescoreLead } from '../lib/leads.ts';
import { audit } from '../lib/audit.ts';
import { notify } from '../lib/notify.ts';
import { buildQuotationDraft } from '../lib/quoteDraft.ts';

export const surveysRouter = Router();

const SURVEY_SELECT = `
  SELECT s.*, l.first_name AS lead_first_name, l.last_name AS lead_last_name, l.phone AS lead_phone,
         l.reference AS lead_reference, l.estimated_value AS lead_value,
         u.first_name AS tech_first_name, u.last_name AS tech_last_name, u.avatar_color AS tech_color,
         a.starts_at AS appointment_starts_at
  FROM site_surveys s
  LEFT JOIN leads l ON l.id = s.lead_id
  LEFT JOIN users u ON u.id = s.technician_id
  LEFT JOIN appointments a ON a.id = s.appointment_id
`;

surveysRouter.get('/', requirePermission('surveys:read'), ah((req, res) => {
  const q = req.query as Record<string, string | undefined>;
  const where = ['s.org_id = ?'];
  const params: any[] = [req.ctx.orgId];
  if (req.ctx.role === 'technician') { where.push('s.technician_id = ?'); params.push(req.ctx.user.id); }
  else if (q.technician_id) { where.push('s.technician_id = ?'); params.push(q.technician_id); }
  if (q.status) { where.push('s.status = ?'); params.push(q.status); }
  if (q.lead_id) { where.push('s.lead_id = ?'); params.push(q.lead_id); }
  const rows = all<any>(
    `${SURVEY_SELECT} WHERE ${where.join(' AND ')} ORDER BY COALESCE(s.scheduled_at, s.created_at) DESC LIMIT 200`,
    params,
  );
  res.json({ surveys: rows.map(shapeSurvey) });
}));

surveysRouter.get('/:id', requirePermission('surveys:read'), ah((req, res) => {
  const survey = loadSurvey(req.ctx.orgId, req.params.id);
  assertSurveyAccess(req, survey);
  res.json({
    survey: shapeSurvey(survey),
    photos: all(
      "SELECT * FROM documents WHERE org_id = ? AND survey_id = ? ORDER BY created_at",
      [req.ctx.orgId, survey.id],
    ),
    checklist: checklistFor(survey.project_type),
  });
}));

const surveySchema = z.object({
  lead_id: z.string().nullish(),
  customer_id: z.string().nullish(),
  project_id: z.string().nullish(),
  appointment_id: z.string().nullish(),
  technician_id: z.string().nullish(),
  project_type: z.string().default('pv'),
  scheduled_at: z.string().nullish(),
  address: z.string().nullish(),
});

surveysRouter.post('/', requirePermission('surveys:write'), ah((req, res) => {
  const body = surveySchema.parse(req.body);
  const id = newId('srv');
  const now = nowIso();
  insert('site_surveys', {
    id, org_id: req.ctx.orgId, lead_id: body.lead_id ?? null, customer_id: body.customer_id ?? null,
    project_id: body.project_id ?? null, appointment_id: body.appointment_id ?? null,
    technician_id: body.technician_id ?? null, project_type: body.project_type,
    status: 'scheduled', scheduled_at: body.scheduled_at ?? null, address: body.address ?? null,
    findings: '{}', created_at: now, updated_at: now,
  });
  if (body.technician_id) {
    notify({
      orgId: req.ctx.orgId, userId: body.technician_id, type: 'survey_assigned',
      title: 'Site survey assigned to you',
      body: body.address ?? 'Open the survey for the address and checklist.',
      link: `/surveys/${id}`, leadId: body.lead_id ?? null,
    });
  }
  res.status(201).json({ survey: shapeSurvey(loadSurvey(req.ctx.orgId, id)) });
}));

const findingsSchema = z.object({
  findings: z.record(z.any()).optional(),
  technical_notes: z.string().nullish(),
  customer_preferences: z.string().nullish(),
  feasible: z.boolean().nullish(),
  recommended_system: z.string().nullish(),
  estimated_cost: z.number().nonnegative().nullish(),
  blockers: z.string().nullish(),
  technician_id: z.string().nullish(),
  scheduled_at: z.string().nullish(),
  status: z.enum(['scheduled', 'in_progress', 'completed', 'cancelled']).optional(),
});

surveysRouter.patch('/:id', requirePermission('surveys:write'), ah((req, res) => {
  const survey = loadSurvey(req.ctx.orgId, req.params.id);
  assertSurveyAccess(req, survey);
  const body = findingsSchema.parse(req.body);

  const map: Record<string, any> = {
    technical_notes: body.technical_notes, customer_preferences: body.customer_preferences,
    feasible: body.feasible === undefined ? undefined : body.feasible ? 1 : 0,
    recommended_system: body.recommended_system, estimated_cost: body.estimated_cost,
    blockers: body.blockers, technician_id: body.technician_id, scheduled_at: body.scheduled_at,
    status: body.status,
  };
  if (body.findings) {
    // Merge so a phone that only submits part of the form does not wipe the rest.
    map.findings = JSON.stringify({ ...parseJson<Record<string, any>>(survey.findings, {}), ...body.findings });
  }
  if (body.status === 'completed') map.completed_at = nowIso();
  const keys = Object.keys(map).filter((k) => map[k] !== undefined);
  if (keys.length > 0) {
    run(
      `UPDATE site_surveys SET ${keys.map((k) => `${k} = ?`).join(', ')}, updated_at = ? WHERE id = ? AND org_id = ?`,
      [...keys.map((k) => map[k]), nowIso(), survey.id, req.ctx.orgId],
    );
  }

  if (survey.lead_id && body.status === 'completed') {
    logActivity({
      orgId: req.ctx.orgId, leadId: survey.lead_id, type: 'survey',
      title: 'Site survey completed',
      body: [
        body.feasible === false ? 'Marked NOT feasible.' : body.feasible === true ? 'Marked feasible.' : null,
        body.recommended_system ? `Recommended: ${body.recommended_system}` : null,
        body.estimated_cost ? `Estimated cost: ${body.estimated_cost}` : null,
        body.blockers ? `Blockers: ${body.blockers}` : null,
      ].filter(Boolean).join('\n'),
      meta: { survey_id: survey.id },
      userId: req.ctx.user.id,
    });
    if (body.estimated_cost) {
      run('UPDATE leads SET estimated_value = ?, updated_at = ? WHERE id = ? AND org_id = ? AND estimated_value = 0', [
        body.estimated_cost, nowIso(), survey.lead_id, req.ctx.orgId,
      ]);
    }
    run("UPDATE appointments SET status = 'completed', updated_at = ? WHERE id = ? AND org_id = ?", [
      nowIso(), survey.appointment_id, req.ctx.orgId,
    ]);
    rescoreLead(req.ctx.orgId, survey.lead_id);
    audit({
      orgId: req.ctx.orgId, userId: req.ctx.user.id, action: 'survey.completed', entityType: 'site_survey',
      entityId: survey.id, entityLabel: survey.address ?? survey.id,
    });
  }
  res.json({ survey: shapeSurvey(loadSurvey(req.ctx.orgId, survey.id)) });
}));

/**
 * The pre-filled quotation for a completed survey. Nothing is written: the owner
 * reviews and edits this in the builder, then creates the quotation themselves.
 */
surveysRouter.get('/:id/quotation-draft', requirePermission('quotes:write'), ah((req, res) => {
  const survey = loadSurvey(req.ctx.orgId, req.params.id);
  assertSurveyAccess(req, survey);
  const draft = buildQuotationDraft(req.ctx.orgId, survey.id);
  res.json({
    draft,
    // Earlier quotations for this lead: a second one is allowed, so say so rather
    // than silently returning the first.
    existing: survey.lead_id
      ? all(
          `SELECT id, number, status, total, currency, created_at, survey_id FROM quotations
           WHERE org_id = ? AND lead_id = ? ORDER BY created_at DESC LIMIT 5`,
          [req.ctx.orgId, survey.lead_id],
        )
      : [],
  });
}));

function loadSurvey(orgId: string, id: string): any {
  const survey = get<any>(`${SURVEY_SELECT} WHERE s.id = ? AND s.org_id = ?`, [id, orgId]);
  if (!survey) throw notFound('That site survey no longer exists.');
  return survey;
}

function shapeSurvey(survey: any): any {
  return {
    ...survey,
    findings: parseJson<Record<string, any>>(survey.findings, {}),
    feasible: survey.feasible === null ? null : !!survey.feasible,
    lead_name: survey.lead_first_name ? `${survey.lead_first_name} ${survey.lead_last_name}` : null,
    technician_name: survey.tech_first_name ? `${survey.tech_first_name} ${survey.tech_last_name}` : null,
  };
}

function assertSurveyAccess(req: any, survey: any): void {
  if (req.ctx.role !== 'technician') return;
  if (survey.technician_id === req.ctx.user.id) return;
  throw forbidden('That survey is assigned to another technician.');
}

/** The on-site checklist a technician fills in, per project type. */
export function checklistFor(projectType: string): { section: string; fields: any[] }[] {
  const shared = {
    section: 'Access and site',
    fields: [
      { key: 'access_notes', label: 'Access to the property', type: 'text' },
      { key: 'scaffolding_required', label: 'Scaffolding required', type: 'boolean' },
      { key: 'parking', label: 'Parking / van access', type: 'select', options: ['Easy', 'Restricted', 'Difficult'] },
      { key: 'distance_to_panel_m', label: 'Cable run to the electrical panel (m)', type: 'number' },
    ],
  };
  if (projectType === 'heat_pump') {
    return [
      {
        section: 'Existing heating system',
        fields: [
          { key: 'existing_system', label: 'Existing system', type: 'select', options: ['Oil boiler', 'Gas boiler', 'Pellet', 'AC units', 'Electric', 'None'] },
          { key: 'boiler_age_years', label: 'Age of the existing boiler (years)', type: 'number' },
          { key: 'emitters', label: 'Emitters', type: 'select', options: ['Radiators', 'Underfloor', 'Fan coils', 'Mixed'] },
          { key: 'flow_temp_c', label: 'Design flow temperature (°C)', type: 'number' },
          { key: 'removal_required', label: 'Removal of the old system required', type: 'boolean' },
        ],
      },
      {
        section: 'Building',
        fields: [
          { key: 'heated_area_m2', label: 'Heated area (m²)', type: 'number' },
          { key: 'floors', label: 'Number of floors', type: 'number' },
          { key: 'insulation', label: 'Insulation condition', type: 'select', options: ['Poor', 'Average', 'Good', 'Excellent'] },
          { key: 'glazing', label: 'Glazing', type: 'select', options: ['Single', 'Double', 'Triple'] },
          { key: 'heat_loss_kw', label: 'Estimated heat loss (kW)', type: 'number' },
        ],
      },
      {
        section: 'Installation',
        fields: [
          { key: 'outdoor_unit_location', label: 'Outdoor unit location', type: 'text' },
          { key: 'condensate_drain', label: 'Condensate drain available', type: 'boolean' },
          { key: 'buffer_tank_space', label: 'Space for a buffer tank', type: 'boolean' },
          { key: 'dhw_cylinder_space', label: 'Space for a DHW cylinder', type: 'boolean' },
          { key: 'electrical_supply', label: 'Electrical supply', type: 'select', options: ['Single phase', 'Three phase'] },
          { key: 'noise_constraints', label: 'Noise / neighbour constraints', type: 'text' },
        ],
      },
      shared,
    ];
  }
  return [
    {
      section: 'Roof',
      fields: [
        { key: 'roof_type', label: 'Roof type', type: 'select', options: ['Tile', 'Flat concrete', 'Metal', 'Shingle', 'Ground mount', 'Carport'] },
        { key: 'roof_condition', label: 'Roof condition', type: 'select', options: ['Good', 'Fair', 'Needs work'] },
        { key: 'orientation', label: 'Orientation', type: 'select', options: ['S', 'SE', 'SW', 'E', 'W', 'Mixed'] },
        { key: 'tilt_deg', label: 'Tilt (degrees)', type: 'number' },
        { key: 'usable_area_m2', label: 'Usable area (m²)', type: 'number' },
        { key: 'shading', label: 'Shading', type: 'select', options: ['None', 'Partial morning', 'Partial afternoon', 'Heavy'] },
        { key: 'shading_source', label: 'Source of shading', type: 'text' },
      ],
    },
    {
      section: 'Electrical',
      fields: [
        { key: 'supply_phase', label: 'Supply', type: 'select', options: ['Single phase', 'Three phase'] },
        { key: 'main_breaker_a', label: 'Main breaker rating (A)', type: 'number' },
        { key: 'panel_space', label: 'Free ways in the consumer unit', type: 'number' },
        { key: 'meter_number', label: 'Meter / supply number', type: 'text' },
        { key: 'earthing', label: 'Earthing arrangement verified', type: 'boolean' },
        { key: 'inverter_location', label: 'Proposed inverter location', type: 'text' },
      ],
    },
    {
      section: 'System proposal',
      fields: [
        { key: 'module_count', label: 'Modules that fit', type: 'number' },
        { key: 'system_kwp', label: 'System size (kWp)', type: 'number' },
        { key: 'battery_space', label: 'Space for a battery', type: 'boolean' },
        { key: 'ev_charger_position', label: 'EV charger position', type: 'text' },
      ],
    },
    shared,
  ];
}

// --- documents and photos -------------------------------------------------

export const documentsRouter = Router();

const ALLOWED_MIME = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/gif',
  'application/pdf', 'text/csv', 'text/plain',
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
]);

const upload = multer({
  storage: multer.diskStorage({
    destination: (_req, _file, cb) => cb(null, config.uploadsDir),
    // Never trust the client filename on disk: a random name with a checked extension.
    filename: (_req, file, cb) => {
      const ext = path.extname(file.originalname).slice(0, 10).replace(/[^a-zA-Z0-9.]/g, '');
      cb(null, `${randomToken(16)}${ext}`);
    },
  }),
  limits: { fileSize: config.maxUploadBytes, files: 10 },
  fileFilter: (_req, file, cb) => {
    if (!ALLOWED_MIME.has(file.mimetype)) {
      cb(badRequest(`Files of type ${file.mimetype} are not accepted.`));
      return;
    }
    cb(null, true);
  },
});

documentsRouter.post('/', requirePermission('documents:write'), upload.array('files', 10), ah((req, res) => {
  const files = (req.files as Express.Multer.File[]) ?? [];
  if (files.length === 0) throw badRequest('Choose at least one file to upload.');
  const body = req.body as Record<string, string | undefined>;
  const created = files.map((file) => {
    const id = newId('doc');
    insert('documents', {
      id,
      org_id: req.ctx.orgId,
      lead_id: body.lead_id || null,
      customer_id: body.customer_id || null,
      project_id: body.project_id || null,
      survey_id: body.survey_id || null,
      quotation_id: body.quotation_id || null,
      kind: file.mimetype.startsWith('image/') ? 'photo' : 'file',
      label: body.label || null,
      filename: file.originalname,
      stored_name: file.filename,
      mime_type: file.mimetype,
      size_bytes: file.size,
      uploaded_by: req.ctx.user.id,
      created_at: nowIso(),
    });
    return get('SELECT * FROM documents WHERE id = ?', [id]);
  });
  if (body.lead_id) {
    logActivity({
      orgId: req.ctx.orgId, leadId: body.lead_id, type: 'document',
      title: `${files.length} file(s) uploaded`,
      body: files.map((f) => f.originalname).join(', '),
      userId: req.ctx.user.id,
    });
  }
  res.status(201).json({ documents: created });
}));

documentsRouter.get('/:id', requirePermission('documents:read'), ah((req, res) => {
  const doc = get<any>('SELECT * FROM documents WHERE id = ? AND org_id = ?', [req.params.id, req.ctx.orgId]);
  if (!doc) throw notFound('That file no longer exists.');
  const filePath = path.join(config.uploadsDir, doc.stored_name);
  if (!filePath.startsWith(config.uploadsDir) || !fs.existsSync(filePath)) {
    throw notFound('That file is no longer stored.');
  }
  res.setHeader('Content-Type', doc.mime_type);
  res.setHeader('Content-Disposition', `${doc.kind === 'photo' ? 'inline' : 'attachment'}; filename="${doc.filename.replace(/"/g, '')}"`);
  fs.createReadStream(filePath).pipe(res);
}));

documentsRouter.delete('/:id', requirePermission('documents:write'), ah((req, res) => {
  const doc = get<any>('SELECT * FROM documents WHERE id = ? AND org_id = ?', [req.params.id, req.ctx.orgId]);
  if (!doc) throw notFound('That file no longer exists.');
  const filePath = path.join(config.uploadsDir, doc.stored_name);
  if (filePath.startsWith(config.uploadsDir) && fs.existsSync(filePath)) fs.rmSync(filePath);
  run('DELETE FROM documents WHERE id = ? AND org_id = ?', [doc.id, req.ctx.orgId]);
  audit({
    orgId: req.ctx.orgId, userId: req.ctx.user.id, action: 'document.deleted', entityType: 'document',
    entityId: doc.id, entityLabel: doc.filename,
  });
  res.json({ ok: true });
}));
