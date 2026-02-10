/**
 * Skills API router for /api/skills endpoints
 *
 * Provides CRUD operations for the unified skill registry.
 */

import { Router } from 'express';
import { ApiError } from './types.js';
import { asyncHandler, validateRequired } from './error-handler.js';
import type { SkillRegistry, SkillSource } from '../skills/skill-registry.js';

/**
 * Create skills API router
 */
export function createSkillsRouter(registry: SkillRegistry): Router {
  const router = Router();

  // GET /api/skills — installed skills
  router.get(
    '/',
    asyncHandler(async (_req, res) => {
      const skills = await registry.getInstalled();
      res.json({ skills });
    })
  );

  // GET /api/skills/catalog — remote catalog
  router.get(
    '/catalog',
    asyncHandler(async (req, res) => {
      const source = (req.query.source as string) || 'all';
      const validSources = ['all', 'mama', 'cowork', 'external'];
      if (!validSources.includes(source)) {
        throw new ApiError(`Invalid source: ${source}`, 400, 'BAD_REQUEST');
      }
      const skills = await registry.getCatalog(source as SkillSource | 'all');
      res.json({ skills });
    })
  );

  // GET /api/skills/search — search across all
  router.get(
    '/search',
    asyncHandler(async (req, res) => {
      const q = (req.query.q as string) || '';
      const source = (req.query.source as string) || 'all';
      if (!q) {
        throw new ApiError('Query parameter "q" is required', 400, 'BAD_REQUEST');
      }
      const skills = await registry.search(q, source as SkillSource | 'all');
      res.json({ skills });
    })
  );

  // POST /api/skills/install — install a skill
  router.post(
    '/install',
    asyncHandler(async (req, res) => {
      const body = req.body as { source?: string; name?: string };
      validateRequired(body as unknown as Record<string, unknown>, ['source', 'name']);

      const validSources = ['cowork', 'external'];
      if (!validSources.includes(body.source!)) {
        throw new ApiError(`Cannot install from source: ${body.source}`, 400, 'BAD_REQUEST');
      }

      const result = await registry.install(body.source as SkillSource, body.name!);
      res.json(result);
    })
  );

  // POST /api/skills/install-url — install from GitHub URL
  router.post(
    '/install-url',
    asyncHandler(async (req, res) => {
      const body = req.body as { url?: string };
      if (!body.url || typeof body.url !== 'string') {
        throw new ApiError('Field "url" is required', 400, 'BAD_REQUEST');
      }

      if (!body.url.startsWith('https://github.com/')) {
        throw new ApiError('Only GitHub URLs are supported', 400, 'BAD_REQUEST');
      }

      const result = await registry.installFromUrl(body.url);
      res.json(result);
    })
  );

  // DELETE /api/skills/:name — uninstall
  router.delete(
    '/:name',
    asyncHandler(async (req, res) => {
      const name = req.params.name as string;
      const source = (req.query.source as SkillSource) || 'mama';
      await registry.uninstall(source, name);
      res.json({ deleted: true });
    })
  );

  // PUT /api/skills/:name — toggle enabled/disabled
  router.put(
    '/:name',
    asyncHandler(async (req, res) => {
      const name = req.params.name as string;
      const { enabled, source } = req.body as { enabled?: boolean; source?: SkillSource };

      if (enabled === undefined) {
        throw new ApiError('Field "enabled" is required', 400, 'BAD_REQUEST');
      }

      await registry.toggle(source || 'mama', name, enabled);
      res.json({ updated: true });
    })
  );

  // GET /api/skills/:name/readme — get SKILL.md content
  router.get(
    '/:name/readme',
    asyncHandler(async (req, res) => {
      const name = req.params.name as string;
      const source = (req.query.source as SkillSource) || 'mama';
      const content = await registry.getContent(source, name);

      if (!content) {
        throw new ApiError(`Skill not found: ${name}`, 404, 'NOT_FOUND');
      }

      res.json({ content });
    })
  );

  return router;
}
