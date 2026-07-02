import { describe, expect, it } from 'vitest';
import request from 'supertest';
import express from 'express';

import { createReportRouter, createReportStore } from '../../src/api/report-handler.js';
import { buildSituationProjection } from '../../src/operator-vnext/situation-projection.js';

describe('Story PR5.2: vNext Report Projection API', () => {
  describe('AC #1: vNext projection is selected only when explicitly configured', () => {
    it('serves legacy report slots when no vNext provider is configured', async () => {
      const store = createReportStore();
      store.update('briefing', '<p>Legacy briefing</p>', 1);

      const router = createReportRouter(store, new Set());
      const app = express();
      app.use(express.json());
      app.use('/', router);
      const response = await request(app).get('/');

      expect(response.status).toBe(200);
      expect(response.body).toEqual({
        slots: [
          expect.objectContaining({
            slotId: 'briefing',
            html: '<p>Legacy briefing</p>',
            priority: 1,
          }),
        ],
      });
    });

    it('serves deterministic vNext report slots without mutating the legacy store', async () => {
      const store = createReportStore();
      store.update('briefing', '<p>Legacy briefing</p>', 1);
      const projection = buildSituationProjection([
        {
          situationId: 'sit_manual_report',
          situationVersion: 2,
          awarenessRunId: 'run_manual_report',
          title: 'Synthetic report projection',
          status: 'in_progress',
          summary: 'Synthetic dashboard projection row.',
          nextAction: 'Continue the synthetic operator flow.',
          freshness: 'live',
          verificationState: 'pending',
          confidence: 0.9,
          evidenceRefs: [{ kind: 'raw', connector: 'manual', id: 'event-report' }],
          updatedAtMs: 1_710_000_010_000,
          viewModelHash: 'vm_hash_report',
          ownerHint: 'operator:primary',
        },
      ]);

      const router = createReportRouter(store, new Set(), {
        vNextProjectionProvider: () => projection,
      });
      const app = express();
      app.use('/', router);
      const response = await request(app).get('/');

      expect(response.status).toBe(200);
      expect(response.body.mode).toBe('vnext');
      expect(response.body.projection.view_model_hash).toBe('vm_hash_report');
      expect(response.body.projection.today[0]).toMatchObject({
        evidence_count: 1,
        evidence_refs: [],
        owner_hint: null,
      });
      expect(response.body.slots.map((slot: { slotId: string }) => slot.slotId)).toEqual([
        'briefing',
        'vnext-status',
        'vnext-today',
        'vnext-evidence',
      ]);
      expect(response.body.slots[0].html).toContain('Synthetic report projection');
      expect(store.get('briefing')?.html).toBe('<p>Legacy briefing</p>');
    });

    it('rejects legacy report mutations while vNext projections are active', async () => {
      const store = createReportStore();
      const projection = buildSituationProjection([
        {
          situationId: 'sit_projection_only',
          situationVersion: 1,
          awarenessRunId: 'run_projection_only',
          title: 'Projection-only dashboard',
          status: 'in_progress',
          summary: 'Projection mode owns dashboard state.',
          nextAction: 'Read the projected state instead of mutating legacy slots.',
          freshness: 'live',
          verificationState: 'verified',
          confidence: 1,
          evidenceRefs: [{ kind: 'raw', connector: 'manual', id: 'event-projection-only' }],
          updatedAtMs: 1_710_000_010_000,
          viewModelHash: 'vm_hash_projection_only',
        },
      ]);

      const router = createReportRouter(store, new Set(), {
        vNextProjectionProvider: () => projection,
      });
      const app = express();
      app.use(express.json());
      app.use('/', router);

      for (const response of [
        await request(app)
          .put('/')
          .send({ slots: { briefing: { html: '<p>Legacy</p>' } } }),
        await request(app).put('/slots/briefing').send({ html: '<p>Legacy</p>' }),
        await request(app).delete('/slots/briefing'),
      ]) {
        expect(response.status).toBe(409);
        expect(response.body).toMatchObject({
          ok: false,
          code: 'vnext_report_projection_only',
        });
      }
      expect(store.getAllSorted()).toEqual([]);

      const nullProjectionRouter = createReportRouter(store, new Set(), {
        vNextProjectionProvider: () => null,
      });
      const nullProjectionApp = express();
      nullProjectionApp.use(express.json());
      nullProjectionApp.use('/', nullProjectionRouter);
      const nullProjectionWrite = await request(nullProjectionApp)
        .put('/')
        .send({ slots: { briefing: { html: '<p>Legacy</p>' } } });

      expect(nullProjectionWrite.status).toBe(409);
      expect(nullProjectionWrite.body).toMatchObject({
        ok: false,
        code: 'vnext_report_projection_only',
      });
      expect(store.getAllSorted()).toEqual([]);
    });
  });
});
