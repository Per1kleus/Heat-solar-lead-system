import { Router } from 'express';
import { z } from 'zod';
import { all, get } from '../lib/db.ts';
import { ah } from '../middleware/errors.ts';
import { requirePermission } from '../middleware/context.ts';
import { LEAD_SELECT, moveStage, shapeLead } from '../lib/leads.ts';
import { daysBetween } from '../lib/time.ts';

export const pipelineRouter = Router();

/** Kanban board: stages with their cards, already scoped to what the user may see. */
pipelineRouter.get('/', requirePermission('leads:read:own', 'leads:read:all'), ah((req, res) => {
  const { orgId } = req.ctx;
  const q = req.query as Record<string, string | undefined>;
  const mine = !req.ctx.seesAll();

  const filters: string[] = ["l.status != 'lost'", 'l.deleted_at IS NULL'];
  const params: any[] = [];
  if (mine) { filters.push('l.owner_id = ?'); params.push(req.ctx.user.id); }
  else if (q.owner_id) { filters.push('l.owner_id = ?'); params.push(q.owner_id); }
  if (q.project_type) { filters.push('l.project_types LIKE ?'); params.push(`%"${q.project_type}"%`); }
  if (q.temperature) { filters.push('l.temperature = ?'); params.push(q.temperature); }
  if (q.source_id) { filters.push('l.source_id = ?'); params.push(q.source_id); }
  if (q.search) {
    const term = `%${q.search.toLowerCase()}%`;
    filters.push('(lower(l.first_name) LIKE ? OR lower(l.last_name) LIKE ? OR lower(l.city) LIKE ?)');
    params.push(term, term, term);
  }

  const stages = all<any>(
    'SELECT * FROM pipeline_stages WHERE org_id = ? AND is_active = 1 ORDER BY position', [orgId],
  );
  const leads = all<any>(
    `${LEAD_SELECT} WHERE l.org_id = ? AND ${filters.join(' AND ')}
     ORDER BY l.estimated_value DESC, l.created_at DESC LIMIT 800`,
    [orgId, ...params],
  ).map((lead) => {
    const shaped = shapeLead(lead);
    return {
      ...shaped,
      days_in_stage: lead.stage_entered_at ? daysBetween(lead.stage_entered_at) : null,
    };
  });

  const columns = stages.map((stage) => {
    const cards = leads.filter((l) => l.stage_id === stage.id);
    return {
      ...stage,
      cards,
      count: cards.length,
      value: cards.reduce((sum, c) => sum + Number(c.estimated_value || 0), 0),
      weighted: cards.reduce((sum, c) => sum + (Number(c.estimated_value || 0) * Number(c.probability || 0)) / 100, 0),
    };
  });

  res.json({
    columns,
    totals: {
      count: leads.length,
      value: columns.filter((c) => c.type === 'open').reduce((s, c) => s + c.value, 0),
      weighted: columns.filter((c) => c.type === 'open').reduce((s, c) => s + c.weighted, 0),
    },
  });
}));

pipelineRouter.post('/move', requirePermission('leads:write'), ah((req, res) => {
  const { lead_id, stage_id } = z.object({ lead_id: z.string(), stage_id: z.string() }).parse(req.body);
  if (!req.ctx.seesAll()) {
    const owner = get<{ owner_id: string | null }>('SELECT owner_id FROM leads WHERE id = ? AND org_id = ?', [
      lead_id, req.ctx.orgId,
    ]);
    if (owner?.owner_id !== req.ctx.user.id) {
      return res.status(403).json({
        error: { code: 'forbidden', message: 'This lead belongs to another salesperson.' },
      });
    }
  }
  res.json({ lead: moveStage(req.ctx.orgId, lead_id, stage_id, req.ctx.user.id) });
}));
