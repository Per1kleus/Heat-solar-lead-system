import { Router } from 'express';
import { z } from 'zod';
import { ah } from '../middleware/errors.ts';
import { rateLimit } from '../middleware/rateLimit.ts';
import { isAiAvailable, runAiTask, type AiTask } from '../lib/ai.ts';
import { loadLead, logActivity } from '../lib/leads.ts';
import { assertVisible } from './leads.ts';
import { requireFeature } from '../lib/billing.ts';
import { countCompleteness } from '../lib/scoring.ts';

export const aiRouter = Router();

aiRouter.get('/status', ah((req, res) => {
  res.json({
    available: isAiAvailable(req.ctx.orgId),
    tasks: [
      { key: 'summary', label: 'Summarise this lead' },
      { key: 'conversation', label: 'Summarise the conversation' },
      { key: 'next_action', label: 'Suggest the next action' },
      { key: 'reply', label: 'Draft a reply' },
      { key: 'qualification', label: 'What information is missing?' },
    ],
    disclaimer:
      'AI drafts are generated from this lead record only. They never invent technical specifications, prices, savings, subsidies or legal claims. Review every draft before sending it.',
  });
}));

aiRouter.post(
  '/leads/:id',
  rateLimit({ name: 'ai', windowMs: 60_000, max: 20, key: (req) => req.ctx?.orgId ?? req.ip ?? 'anon' }),
  ah(async (req, res) => {
    requireFeature(req.ctx.orgId, 'ai', 'AI assistance');
    const body = z.object({
      task: z.enum(['summary', 'conversation', 'next_action', 'reply', 'qualification']),
      context: z.string().max(500).optional(),
    }).parse(req.body);

    const lead = loadLead(req.ctx.orgId, req.params.id);
    assertVisible(req, lead);

    // The "what is missing" answer is derived from the record itself, so it works
    // with or without an AI key.
    if (body.task === 'qualification' && !isAiAvailable(req.ctx.orgId)) {
      const missing = countCompleteness(lead).missing;
      return res.json({
        text: missing.length > 0
          ? `Missing before this lead can be quoted accurately:\n${missing.map((m) => `- ${m}`).join('\n')}`
          : 'Nothing material is missing from this lead.',
        source: 'rules',
        model: null,
      });
    }

    const result = await runAiTask(req.ctx.orgId, lead.id, body.task as AiTask, body.context);
    logActivity({
      orgId: req.ctx.orgId, leadId: lead.id, type: 'system',
      title: `AI assist used: ${body.task.replace('_', ' ')}`,
      meta: { task: body.task, model: result.model },
      userId: req.ctx.user.id,
    });
    res.json({ ...result, source: 'ai' });
  }),
);
