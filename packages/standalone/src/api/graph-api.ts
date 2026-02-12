/**
 * MAMA Graph API
 *
 * HTTP API endpoints for Graph Viewer.
 * Provides /graph endpoint for fetching decisions and edges data.
 * Provides /viewer endpoint for serving HTML viewer.
 */

import fs from 'fs';
import path from 'path';
import os from 'os';
import { timingSafeEqual } from 'node:crypto';
import yaml from 'js-yaml';
import type { IncomingMessage, ServerResponse } from 'http';
import type {
  GraphNode,
  GraphEdge,
  SimilarityEdge,
  CheckpointData,
  GraphHandlerOptions,
  MemoryStats,
  SessionStats,
  GraphHandlerFn,
} from './graph-api-types.js';

// mama-core is pure JS with no .d.ts — require + any is intentional
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { getAdapter, initDB, vectorSearch } = require('@jungjaehoon/mama-core/memory-store');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { DebugLogger } = require('@jungjaehoon/mama-core/debug-logger');

const logger = new DebugLogger('GraphAPI');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const { generateEmbedding } = require('@jungjaehoon/mama-core/embeddings');
// eslint-disable-next-line @typescript-eslint/no-require-imports
const mama = require('@jungjaehoon/mama-core/mama-api');

// Config paths
const MAMA_CONFIG_PATH = path.join(os.homedir(), '.mama', 'config.yaml');

// Paths to viewer files (now in public/viewer/)
const VIEWER_DIR = path.join(__dirname, '../../public/viewer');
const VIEWER_HTML_PATH = path.join(VIEWER_DIR, 'viewer.html');
const VIEWER_CSS_PATH = path.join(VIEWER_DIR, 'viewer.css');
const VIEWER_JS_PATH = path.join(VIEWER_DIR, 'viewer.js');
const SW_JS_PATH = path.join(VIEWER_DIR, 'sw.js');
const MANIFEST_JSON_PATH = path.join(VIEWER_DIR, 'manifest.json');
const FAVICON_PATH = path.join(__dirname, '../../public/favicon.ico');

async function getAllNodes(): Promise<GraphNode[]> {
  const adapter = getAdapter();

  const stmt = adapter.prepare(`
    SELECT
      id,
      topic,
      decision,
      reasoning,
      outcome,
      confidence,
      created_at
    FROM decisions
    ORDER BY created_at DESC
  `);

  const rows = stmt.all() as Array<{
    id: string;
    topic: string;
    decision: string;
    reasoning: string;
    outcome: string | null;
    confidence: number | null;
    created_at: number;
  }>;

  return rows.map((row) => ({
    id: row.id,
    topic: row.topic,
    decision: row.decision,
    reasoning: row.reasoning,
    outcome: row.outcome,
    confidence: row.confidence,
    created_at: row.created_at,
  }));
}

async function getAllEdges(): Promise<GraphEdge[]> {
  const adapter = getAdapter();

  const stmt = adapter.prepare(`
    SELECT
      from_id,
      to_id,
      relationship,
      reason
    FROM decision_edges
    ORDER BY created_at DESC
  `);

  const rows = stmt.all() as Array<{
    from_id: string;
    to_id: string;
    relationship: string;
    reason: string | null;
  }>;

  return rows.map((row) => ({
    from: row.from_id,
    to: row.to_id,
    relationship: row.relationship,
    reason: row.reason,
  }));
}

function safeParseJsonArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
}

async function getAllCheckpoints(): Promise<CheckpointData[]> {
  const adapter = getAdapter();

  const stmt = adapter.prepare(`
    SELECT
      id,
      timestamp,
      summary,
      open_files,
      next_steps,
      status
    FROM checkpoints
    ORDER BY timestamp DESC
    LIMIT 50
  `);

  const rows = stmt.all() as Array<{
    id: string;
    timestamp: number;
    summary: string;
    open_files: string | null;
    next_steps: string;
    status: string | null;
  }>;

  return rows.map((row) => ({
    id: row.id,
    timestamp: row.timestamp,
    summary: row.summary,
    open_files: row.open_files ? safeParseJsonArray(row.open_files) : [],
    next_steps: row.next_steps,
    status: row.status,
  }));
}

function getUniqueTopics(nodes: GraphNode[]): string[] {
  const topicSet = new Set(nodes.map((n) => n.topic));
  return Array.from(topicSet).sort();
}

function filterNodesByTopic(nodes: GraphNode[], topic: string): GraphNode[] {
  return nodes.filter((n) => n.topic === topic);
}

function filterEdgesByNodes(edges: GraphEdge[], nodes: GraphNode[]): GraphEdge[] {
  const nodeIds = new Set(nodes.map((n) => n.id));
  return edges.filter((e) => nodeIds.has(e.from) || nodeIds.has(e.to));
}

function serveStaticFile(res: ServerResponse, filePath: string, contentType: string): void {
  try {
    const isBinary = contentType.startsWith('image/') || contentType === 'application/octet-stream';
    const content = isBinary ? fs.readFileSync(filePath) : fs.readFileSync(filePath, 'utf8');
    const etag = `"${Date.now()}"`;

    const fullContentType = isBinary ? contentType : `${contentType}; charset=utf-8`;

    res.writeHead(200, {
      'Content-Type': fullContentType,
      'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
      ETag: etag,
    });
    res.end(content);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[GraphAPI] Static file error: ${message}`);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Error loading file: ' + message);
  }
}

function handleViewerRequest(_req: IncomingMessage, res: ServerResponse): void {
  serveStaticFile(res, VIEWER_HTML_PATH, 'text/html');
}

function handleCssRequest(_req: IncomingMessage, res: ServerResponse): void {
  serveStaticFile(res, VIEWER_CSS_PATH, 'text/css');
}

function handleJsRequest(_req: IncomingMessage, res: ServerResponse): void {
  serveStaticFile(res, VIEWER_JS_PATH, 'application/javascript');
}

async function handleGraphRequest(
  _req: IncomingMessage,
  res: ServerResponse,
  params: URLSearchParams
): Promise<void> {
  const startTime = Date.now();

  try {
    await initDB();

    let nodes = await getAllNodes();
    let edges = await getAllEdges();

    const topicFilter = params.get('topic');
    if (topicFilter) {
      nodes = filterNodesByTopic(nodes, topicFilter);
      edges = filterEdgesByNodes(edges, nodes);
    }

    const includeCluster = params.get('cluster') === 'true';
    let similarityEdges: SimilarityEdge[] = [];
    if (includeCluster) {
      similarityEdges = await getSimilarityEdges();
      const nodeIds = new Set(nodes.map((n) => n.id));
      similarityEdges = similarityEdges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));
    }

    const allTopics = topicFilter ? [topicFilter] : getUniqueTopics(nodes);
    const meta = {
      total_nodes: nodes.length,
      total_edges: edges.length,
      similarity_edges: similarityEdges.length,
      topics: allTopics,
    };

    const latency = Date.now() - startTime;

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        nodes,
        edges,
        similarityEdges,
        meta,
        latency,
      })
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[GraphAPI] Error: ${message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: true,
        code: 'INTERNAL_ERROR',
        message,
      })
    );
  }
}

function readBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  // When mounted as Express middleware, body is already parsed by express.json()
  const expressBody = (req as unknown as { body?: Record<string, unknown> }).body;
  if (expressBody && typeof expressBody === 'object') {
    return Promise.resolve(expressBody);
  }

  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => {
      data += chunk;
      if (data.length > 1_048_576) {
        req.destroy();
        reject(new Error('Request body too large (max 1MB)'));
        return;
      }
    });
    req.on('end', () => {
      try {
        resolve(JSON.parse(data) as Record<string, unknown>);
      } catch {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

async function handleUpdateRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);

    if (!body.id || !body.outcome) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: true,
          code: 'INVALID_REQUEST',
          message: 'Missing required fields: id, outcome',
        })
      );
      return;
    }

    await initDB();

    await mama.updateOutcome(body.id, {
      outcome: body.outcome,
      failure_reason: body.reason,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        success: true,
        id: body.id,
        outcome: String(body.outcome).toUpperCase(),
      })
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[GraphAPI] Update error: ${message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: true,
        code: 'UPDATE_FAILED',
        message,
      })
    );
  }
}

async function getSimilarityEdges(): Promise<SimilarityEdge[]> {
  const adapter = getAdapter();

  const stmt = adapter.prepare(`
    SELECT id, topic, decision FROM decisions
    ORDER BY created_at DESC
    LIMIT 100
  `);
  const decisions = stmt.all() as Array<{ id: string; topic: string; decision: string }>;

  if (decisions.length < 2) {
    return [];
  }

  const similarityEdges: SimilarityEdge[] = [];
  const similarityEdgeKeys = new Set<string>();

  for (const decision of decisions.slice(0, 50)) {
    try {
      const query = `${decision.topic} ${decision.decision}`;
      const embedding = await generateEmbedding(query);
      const similar = (await vectorSearch(embedding, 3, 0.7)) as Array<{
        id: string;
        similarity: number;
      }>;

      for (const s of similar) {
        if (s.id !== decision.id && s.similarity > 0.7) {
          const edgeKey = [decision.id, s.id].sort().join('|');
          if (!similarityEdgeKeys.has(edgeKey)) {
            similarityEdges.push({
              from: decision.id,
              to: s.id,
              relationship: 'similar',
              similarity: s.similarity,
            });
            similarityEdgeKeys.add(edgeKey);
          }
        }
      }
    } catch (e: unknown) {
      const msg = e instanceof Error ? e.message : String(e);
      console.error(`[GraphAPI] Similarity search error for ${decision.id}:`, msg);
    }
  }

  return similarityEdges;
}

async function handleSimilarRequest(
  _req: IncomingMessage,
  res: ServerResponse,
  params: URLSearchParams
): Promise<void> {
  const startTime = Date.now();
  try {
    const decisionId = params.get('id');
    console.log(`[GraphAPI] Similar request for decision: ${decisionId}`);

    if (!decisionId) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: true,
          code: 'MISSING_ID',
          message: 'Missing required parameter: id',
        })
      );
      return;
    }

    console.log(`[GraphAPI] Initializing DB...`);
    await initDB();

    console.log(`[GraphAPI] Fetching decision ${decisionId}...`);
    const adapter = getAdapter();
    const stmt = adapter.prepare(`
      SELECT topic, decision, reasoning FROM decisions WHERE id = ?
    `);
    const decision = stmt.get(decisionId) as
      | { topic: string; decision: string; reasoning: string }
      | undefined;

    if (!decision) {
      console.log(`[GraphAPI] Decision ${decisionId} not found`);
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: true,
          code: 'NOT_FOUND',
          message: 'Decision not found',
        })
      );
      return;
    }

    const searchQuery = `${decision.topic} ${decision.decision}`;
    console.log(
      `[GraphAPI] Searching for similar decisions with query: "${searchQuery.substring(0, 50)}..."`
    );

    const searchStart = Date.now();
    const results = await mama.suggest(searchQuery, {
      limit: 6,
      threshold: 0.5,
    });
    console.log(`[GraphAPI] Semantic search completed in ${Date.now() - searchStart}ms`);

    let similar: Array<{
      id: string;
      topic: string;
      decision: string;
      similarity: number;
      outcome: string | null;
    }> = [];
    if (results && results.results) {
      similar = (results.results as Array<Record<string, unknown>>)
        .filter((r) => r.id !== decisionId)
        .slice(0, 5)
        .map((r) => ({
          id: r.id as string,
          topic: r.topic as string,
          decision: r.decision as string,
          similarity: (r.similarity ?? r.final_score ?? 0.5) as number,
          outcome: (r.outcome ?? null) as string | null,
        }));
    }

    console.log(
      `[GraphAPI] Found ${similar.length} similar decisions (total time: ${Date.now() - startTime}ms)`
    );

    res.writeHead(200, {
      'Content-Type': 'application/json',
    });
    res.end(
      JSON.stringify({
        id: decisionId,
        similar,
        count: similar.length,
      })
    );
    console.log(`[GraphAPI] Response sent for ${decisionId}`);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    const stack = error instanceof Error ? error.stack : undefined;
    console.error(`[GraphAPI] Similar error: ${message}`);
    console.error(`[GraphAPI] Similar error stack:`, stack);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: true,
        code: 'SEARCH_FAILED',
        message,
      })
    );
  }
}

async function handleMamaSearchRequest(
  _req: IncomingMessage,
  res: ServerResponse,
  params: URLSearchParams
): Promise<void> {
  try {
    const query = params.get('q');
    const limit = Math.min(parseInt(params.get('limit') || '10', 10), 20);

    if (!query) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: true,
          code: 'MISSING_QUERY',
          message: 'Missing required parameter: q',
        })
      );
      return;
    }

    await initDB();

    const searchResults = await mama.suggest(query, {
      limit: limit,
      threshold: 0.3,
    });

    let results: Array<{
      id: string;
      topic: string;
      decision: string;
      reasoning: string;
      outcome: string | null;
      confidence: number | null;
      similarity: number;
      created_at: number;
    }> = [];
    if (searchResults && searchResults.results) {
      results = (searchResults.results as Array<Record<string, unknown>>).map((r) => ({
        id: r.id as string,
        topic: r.topic as string,
        decision: r.decision as string,
        reasoning: r.reasoning as string,
        outcome: (r.outcome ?? null) as string | null,
        confidence: (r.confidence ?? null) as number | null,
        similarity: (r.similarity ?? r.final_score ?? 0.5) as number,
        created_at: r.created_at as number,
      }));
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        query,
        results,
        count: results.length,
      })
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[GraphAPI] MAMA search error: ${message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: true,
        code: 'SEARCH_FAILED',
        message,
      })
    );
  }
}

async function handleMamaSaveRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const body = await readBody(req);

    if (!body.topic || !body.decision || !body.reasoning) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: true,
          code: 'MISSING_FIELDS',
          message: 'Missing required fields: topic, decision, reasoning',
        })
      );
      return;
    }

    await initDB();

    const result = await mama.saveDecision({
      topic: body.topic,
      decision: body.decision,
      reasoning: body.reasoning,
      confidence: body.confidence ?? 0.8,
    });

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        success: true,
        id: result.id,
        message: 'Decision saved successfully',
      })
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[GraphAPI] MAMA save error: ${message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: true,
        code: 'SAVE_FAILED',
        message,
      })
    );
  }
}

async function handleCheckpointSaveRequest(
  req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  try {
    const body = await readBody(req);

    if (!body.summary) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: true,
          code: 'MISSING_FIELDS',
          message: 'Missing required field: summary',
        })
      );
      return;
    }

    await initDB();

    const checkpointId = await mama.saveCheckpoint(
      body.summary,
      body.open_files || [],
      body.next_steps || ''
    );

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        success: true,
        id: checkpointId,
        message: 'Checkpoint saved successfully',
      })
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[GraphAPI] Checkpoint save error: ${message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: true,
        code: 'SAVE_FAILED',
        message,
      })
    );
  }
}

async function handleCheckpointLoadRequest(
  _req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  try {
    await initDB();

    const checkpoint = await mama.loadCheckpoint();

    if (!checkpoint) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: true,
          code: 'NO_CHECKPOINT',
          message: 'No checkpoint found',
        })
      );
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        success: true,
        checkpoint,
      })
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[GraphAPI] Checkpoint load error: ${message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: true,
        code: 'LOAD_FAILED',
        message,
      })
    );
  }
}

async function handleCheckpointsRequest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    await initDB();

    const checkpoints = await getAllCheckpoints();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        checkpoints,
        count: checkpoints.length,
      })
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[GraphAPI] Checkpoints error: ${message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: true,
        code: 'CHECKPOINTS_FAILED',
        message,
      })
    );
  }
}

function createGraphHandler(options: GraphHandlerOptions = {}): GraphHandlerFn {
  return async function graphHandler(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
    if (!req.url) {
      res.writeHead(400, { 'Content-Type': 'text/plain' });
      res.end('Bad Request');
      return true;
    }

    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const params = url.searchParams;

    console.log('[GraphHandler] Request:', req.method, pathname);

    // Set CORS headers — restrict to localhost origins only
    const origin = req.headers.origin || '';
    const isLocalhost = /^https?:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(origin);
    if (isLocalhost) {
      res.setHeader('Access-Control-Allow-Origin', origin);
    }
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

    // Handle preflight OPTIONS requests
    if (req.method === 'OPTIONS') {
      res.writeHead(204);
      res.end();
      return true;
    }

    // Route: GET / - redirect to /viewer
    if (pathname === '/' && req.method === 'GET') {
      console.log('[GraphHandler] Redirecting / to /viewer');
      res.writeHead(302, { Location: '/viewer' });
      res.end();
      return true;
    }

    // Route: GET /viewer - serve HTML viewer
    if (pathname === '/viewer' && req.method === 'GET') {
      console.log('[GraphHandler] Serving viewer.html');
      handleViewerRequest(req, res);
      return true;
    }

    // Route: GET/HEAD /viewer/viewer.css - serve stylesheet
    if (pathname === '/viewer/viewer.css' && (req.method === 'GET' || req.method === 'HEAD')) {
      handleCssRequest(req, res);
      return true;
    }

    // Route: GET/HEAD /viewer.css - serve stylesheet (legacy path)
    if (pathname === '/viewer.css' && (req.method === 'GET' || req.method === 'HEAD')) {
      handleCssRequest(req, res);
      return true;
    }

    // Route: GET/HEAD /viewer.js - serve JavaScript
    if (pathname === '/viewer.js' && (req.method === 'GET' || req.method === 'HEAD')) {
      handleJsRequest(req, res);
      return true;
    }

    // Route: GET/HEAD /sw.js - serve Service Worker
    if (pathname === '/sw.js' && (req.method === 'GET' || req.method === 'HEAD')) {
      serveStaticFile(res, SW_JS_PATH, 'application/javascript');
      return true;
    }

    // Route: GET/HEAD /viewer/sw.js - serve Service Worker (alternative path)
    if (pathname === '/viewer/sw.js' && (req.method === 'GET' || req.method === 'HEAD')) {
      serveStaticFile(res, SW_JS_PATH, 'application/javascript');
      return true;
    }

    // Route: GET/HEAD /viewer/manifest.json - serve PWA manifest
    if (pathname === '/viewer/manifest.json' && (req.method === 'GET' || req.method === 'HEAD')) {
      serveStaticFile(res, MANIFEST_JSON_PATH, 'application/json');
      return true;
    }

    // Route: GET/HEAD /favicon.ico - serve favicon
    if (pathname === '/favicon.ico' && (req.method === 'GET' || req.method === 'HEAD')) {
      serveStaticFile(res, FAVICON_PATH, 'image/x-icon');
      return true;
    }

    // Route: GET/HEAD /viewer/icons/*.png - serve PWA icons
    if (
      pathname.startsWith('/viewer/icons/') &&
      pathname.endsWith('.png') &&
      (req.method === 'GET' || req.method === 'HEAD')
    ) {
      const fileName = pathname.split('/').pop()!;
      const filePath = path.join(__dirname, '../../public/viewer/icons', fileName);
      serveStaticFile(res, filePath, 'image/png');
      return true;
    }

    // Route: GET/HEAD /viewer/icons/*.svg - serve SVG icons
    if (
      pathname.startsWith('/viewer/icons/') &&
      pathname.endsWith('.svg') &&
      (req.method === 'GET' || req.method === 'HEAD')
    ) {
      const fileName = pathname.split('/').pop()!;
      const filePath = path.join(__dirname, '../../public/viewer/icons', fileName);
      serveStaticFile(res, filePath, 'image/svg+xml');
      return true;
    }

    // Route: GET/HEAD /viewer/js/utils/*.js - serve utility modules
    if (
      pathname.startsWith('/viewer/js/utils/') &&
      pathname.endsWith('.js') &&
      (req.method === 'GET' || req.method === 'HEAD')
    ) {
      const fileName = pathname.split('/').pop()!;
      const filePath = path.join(VIEWER_DIR, 'js', 'utils', fileName);
      serveStaticFile(res, filePath, 'application/javascript');
      return true;
    }

    // Route: GET/HEAD /viewer/js/modules/*.js - serve feature modules
    if (
      pathname.startsWith('/viewer/js/modules/') &&
      pathname.endsWith('.js') &&
      (req.method === 'GET' || req.method === 'HEAD')
    ) {
      const fileName = pathname.split('/').pop()!;
      const filePath = path.join(VIEWER_DIR, 'js', 'modules', fileName);
      serveStaticFile(res, filePath, 'application/javascript');
      return true;
    }

    // Route: GET/HEAD /js/utils/*.js - serve utility modules (legacy path)
    if (
      pathname.startsWith('/js/utils/') &&
      pathname.endsWith('.js') &&
      (req.method === 'GET' || req.method === 'HEAD')
    ) {
      const fileName = pathname.split('/').pop()!;
      const filePath = path.join(VIEWER_DIR, 'js', 'utils', fileName);
      serveStaticFile(res, filePath, 'application/javascript');
      return true;
    }

    // Route: GET/HEAD /js/modules/*.js - serve feature modules (legacy path)
    if (
      pathname.startsWith('/js/modules/') &&
      pathname.endsWith('.js') &&
      (req.method === 'GET' || req.method === 'HEAD')
    ) {
      const fileName = pathname.split('/').pop()!;
      const filePath = path.join(VIEWER_DIR, 'js', 'modules', fileName);
      serveStaticFile(res, filePath, 'application/javascript');
      return true;
    }

    // Route: GET /graph/similar - find similar decisions (check before /graph)
    if (pathname === '/graph/similar' && req.method === 'GET') {
      console.log('[GraphHandler] Routing to handleSimilarRequest');
      await handleSimilarRequest(req, res, params);
      return true;
    }

    // Route: POST /graph/update - update decision outcome
    if (pathname === '/graph/update' && req.method === 'POST') {
      await handleUpdateRequest(req, res);
      return true;
    }

    // Route: GET /graph - API endpoint
    if (pathname === '/graph' && req.method === 'GET') {
      await handleGraphRequest(req, res, params);
      return true;
    }

    // Alias: GET /api/graph -> /graph
    if (pathname === '/api/graph' && req.method === 'GET') {
      await handleGraphRequest(req, res, params);
      return true;
    }

    // Route: GET /checkpoints - list all checkpoints
    if (pathname === '/checkpoints' && req.method === 'GET') {
      await handleCheckpointsRequest(req, res);
      return true;
    }

    // Alias: GET /api/checkpoints -> /checkpoints
    if (pathname === '/api/checkpoints' && req.method === 'GET') {
      await handleCheckpointsRequest(req, res);
      return true;
    }

    // Route: GET /api/mama/search - semantic search for decisions
    if (pathname === '/api/mama/search' && req.method === 'GET') {
      await handleMamaSearchRequest(req, res, params);
      return true;
    }

    // Alias: GET /api/search -> /api/mama/search (with query param conversion)
    if (pathname === '/api/search' && req.method === 'GET') {
      const query = params.get('query');
      if (query) {
        params.set('q', query);
      }
      await handleMamaSearchRequest(req, res, params);
      return true;
    }

    // Route: POST /api/mama/save - save a new decision
    if (pathname === '/api/mama/save' && req.method === 'POST') {
      await handleMamaSaveRequest(req, res);
      return true;
    }

    // Alias: POST /api/save -> /api/mama/save
    if (pathname === '/api/save' && req.method === 'POST') {
      await handleMamaSaveRequest(req, res);
      return true;
    }

    // Alias: POST /api/update -> /graph/update
    if (pathname === '/api/update' && req.method === 'POST') {
      await handleUpdateRequest(req, res);
      return true;
    }

    // Route: POST /api/checkpoint/save - save session checkpoint
    if (pathname === '/api/checkpoint/save' && req.method === 'POST') {
      await handleCheckpointSaveRequest(req, res);
      return true;
    }

    // Route: GET /api/checkpoint/load - load latest checkpoint
    if (pathname === '/api/checkpoint/load' && req.method === 'GET') {
      await handleCheckpointLoadRequest(req, res);
      return true;
    }

    // Route: GET /api/health - health check
    if (pathname === '/api/health' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ status: 'ok', service: 'MAMA Graph API' }));
      return true;
    }

    // Route: GET /api/dashboard/status - dashboard status
    if (pathname === '/api/dashboard/status' && req.method === 'GET') {
      await handleDashboardStatusRequest(req, res);
      return true;
    }

    // Route: GET /api/config - get current config
    if (pathname === '/api/config' && req.method === 'GET') {
      await handleGetConfigRequest(req, res);
      return true;
    }

    // Route: PUT /api/config - update config
    if (pathname === '/api/config' && req.method === 'PUT') {
      await handleUpdateConfigRequest(req, res);
      return true;
    }

    // Route: POST /api/restart - graceful restart via mama CLI
    if (pathname === '/api/restart' && req.method === 'POST') {
      if (!isAuthenticated(req)) {
        res.writeHead(401, { 'Content-Type': 'application/json' });
        res.end(
          JSON.stringify({ error: true, code: 'UNAUTHORIZED', message: 'Authentication required' })
        );
        return true;
      }
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ success: true, message: 'Restarting...' }));
      // Prefer systemd restart when running as a service; otherwise spawn detached daemon.
      setTimeout(() => {
        console.log('[API] Restart requested via API — spawning new daemon');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { spawn: spawnChild } = require('node:child_process');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { openSync, writeFileSync } = require('node:fs');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { homedir: getHome } = require('node:os');
        // eslint-disable-next-line @typescript-eslint/no-require-imports
        const { join: joinPath } = require('node:path');

        const isSystemd =
          Boolean(process.env.INVOCATION_ID) || Boolean(process.env.SYSTEMD_EXEC_PID);

        if (isSystemd) {
          spawnChild('systemctl', ['--user', 'restart', 'mama-os'], {
            detached: true,
            stdio: 'ignore',
          }).unref();
          process.exit(0);
          return;
        }

        // Spawn detached daemon directly, then exit current process
        // Cannot use `mama start` because it checks PID (current process still alive)
        const script = process.argv[1];
        const logDir = joinPath(getHome(), '.mama', 'logs');
        const logFile = joinPath(logDir, 'daemon.log');
        const out = openSync(logFile, 'a');
        const child = spawnChild(process.execPath, [script, 'daemon'], {
          detached: true,
          stdio: ['ignore', out, out],
          cwd: getHome(),
          env: { ...process.env, MAMA_DAEMON: '1' },
        });
        child.unref();
        if (child.pid) {
          const pidFile = joinPath(getHome(), '.mama', 'mama.pid');
          writeFileSync(pidFile, String(child.pid));
        }
        process.exit(0);
      }, 500);
      return true;
    }

    // Route: GET /api/memory/export - export decisions
    if (pathname === '/api/memory/export' && req.method === 'GET') {
      await handleExportRequest(req, res, params);
      return true;
    }

    // Route: GET /api/multi-agent/status - get multi-agent system status
    if (pathname === '/api/multi-agent/status' && req.method === 'GET') {
      await handleMultiAgentStatusRequest(req, res, options);
      return true;
    }

    // Route: GET /api/multi-agent/agents - get all agents config
    if (pathname === '/api/multi-agent/agents' && req.method === 'GET') {
      await handleMultiAgentAgentsRequest(req, res);
      return true;
    }

    // Route: PUT /api/multi-agent/agents/:id - update agent config
    if (pathname.startsWith('/api/multi-agent/agents/') && req.method === 'PUT') {
      await handleMultiAgentUpdateAgentRequest(req, res, pathname);
      return true;
    }

    // Route: GET /api/multi-agent/delegations - get recent delegations
    if (pathname === '/api/multi-agent/delegations' && req.method === 'GET') {
      await handleMultiAgentDelegationsRequest(req, res, options);
      return true;
    }

    // Route: GET /api/mcp-servers - get available MCP servers from config
    if (pathname === '/api/mcp-servers' && req.method === 'GET') {
      await handleMCPServersRequest(req, res);
      return true;
    }

    // Route: DELETE /api/mcp-servers/:name - remove MCP server from config
    if (pathname.startsWith('/api/mcp-servers/') && req.method === 'DELETE') {
      await handleDeleteMCPServerRequest(req, res, pathname);
      return true;
    }

    return false;
  };
}

async function handleDashboardStatusRequest(
  _req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  try {
    const config = loadMAMAConfig();

    await initDB();
    const memoryStats = await getMemoryStats();

    const gateways = {
      discord: {
        configured: !!config.discord?.token,
        enabled: config.discord?.enabled ?? false,
        channel: config.discord?.default_channel_id || null,
      },
      slack: {
        configured: !!config.slack?.bot_token,
        enabled: config.slack?.enabled ?? false,
        channel: config.slack?.default_channel || null,
      },
      telegram: {
        configured: !!config.telegram?.token,
        enabled: config.telegram?.enabled ?? false,
        chats: config.telegram?.allowed_chats || [],
      },
      chatwork: {
        configured: !!config.chatwork?.api_token,
        enabled: config.chatwork?.enabled ?? false,
        rooms: config.chatwork?.room_ids || [],
      },
    };

    const heartbeat = {
      enabled: config.heartbeat?.enabled ?? false,
      interval: config.heartbeat?.interval ?? 1800000,
      quietStart: config.heartbeat?.quiet_start ?? 23,
      quietEnd: config.heartbeat?.quiet_end ?? 8,
    };

    const agent = {
      model: config.agent?.model || 'claude-sonnet-4-20250514',
      maxTurns: config.agent?.max_turns ?? 10,
      timeout: config.agent?.timeout ?? 300000,
      tools: config.agent?.tools || { gateway: ['*'], mcp: [] },
    };

    const sessionStats = getSessionStats();

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        gateways,
        heartbeat,
        agent,
        memory: memoryStats,
        sessions: sessionStats,
        database: {
          path: config.database?.path ?? '~/.claude/mama-memory.db',
        },
      })
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`[GraphAPI] Dashboard status error: ${message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: true,
        code: 'DASHBOARD_ERROR',
        message,
      })
    );
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function loadMAMAConfig(): Record<string, any> {
  try {
    if (!fs.existsSync(MAMA_CONFIG_PATH)) {
      console.log('[GraphAPI] Config file not found:', MAMA_CONFIG_PATH);
      return {};
    }
    const content = fs.readFileSync(MAMA_CONFIG_PATH, 'utf8');
    return (yaml.load(content) as Record<string, unknown>) || {};
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[GraphAPI] Config load error:', message);
    return {};
  }
}

async function getMemoryStats(): Promise<MemoryStats> {
  try {
    const adapter = getAdapter();

    const now = Date.now();
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const monthAgo = now - 30 * 24 * 60 * 60 * 1000;

    const totalResult = adapter.prepare('SELECT COUNT(*) as count FROM decisions').get() as
      | { count: number }
      | undefined;
    const total = totalResult?.count ?? 0;

    const weekResult = adapter
      .prepare('SELECT COUNT(*) as count FROM decisions WHERE created_at > ?')
      .get(weekAgo) as { count: number } | undefined;
    const thisWeek = weekResult?.count ?? 0;

    const monthResult = adapter
      .prepare('SELECT COUNT(*) as count FROM decisions WHERE created_at > ?')
      .get(monthAgo) as { count: number } | undefined;
    const thisMonth = monthResult?.count ?? 0;

    const outcomeResults = adapter
      .prepare(
        `
      SELECT outcome, COUNT(*) as count
      FROM decisions
      WHERE outcome IS NOT NULL
      GROUP BY outcome
    `
      )
      .all() as Array<{ outcome: string | null; count: number }>;

    const outcomes: Record<string, number> = {};
    for (const row of outcomeResults) {
      outcomes[row.outcome?.toLowerCase() ?? 'unknown'] = row.count;
    }

    const topicResults = adapter
      .prepare(
        `
      SELECT topic, COUNT(*) as count
      FROM decisions
      WHERE topic IS NOT NULL
      GROUP BY topic
      ORDER BY count DESC
      LIMIT 5
    `
      )
      .all() as Array<{ topic: string; count: number }>;

    const checkpointResult = adapter.prepare('SELECT COUNT(*) as count FROM checkpoints').get() as
      | { count: number }
      | undefined;
    const checkpoints = checkpointResult?.count ?? 0;

    return {
      total,
      thisWeek,
      thisMonth,
      checkpoints,
      outcomes,
      topTopics: topicResults,
    };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[GraphAPI] Memory stats error:', message);
    return {
      total: 0,
      thisWeek: 0,
      thisMonth: 0,
      checkpoints: 0,
      outcomes: {},
      topTopics: [],
    };
  }
}

function getSessionStats(): SessionStats {
  try {
    const config = loadMAMAConfig();
    const memoryDbPath: string = config.database?.path || '~/.claude/mama-memory.db';
    const expandedPath = memoryDbPath.startsWith('~/')
      ? path.join(os.homedir(), memoryDbPath.slice(2))
      : memoryDbPath;
    const sessionsDbPath = expandedPath.replace('mama-memory.db', 'mama-sessions.db');

    if (!fs.existsSync(sessionsDbPath)) {
      return { total: 0, bySource: {}, channels: [] };
    }

    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const Database = require('better-sqlite3');
    const sessionsDb = new Database(sessionsDbPath);

    const bySourceRows = sessionsDb
      .prepare(
        `
        SELECT source, COUNT(*) as count
        FROM messenger_sessions
        GROUP BY source
      `
      )
      .all() as Array<{ source: string; count: number }>;

    const bySource: Record<string, number> = {};
    let total = 0;
    for (const row of bySourceRows) {
      bySource[row.source] = row.count;
      total += row.count;
    }

    const channelRows = sessionsDb
      .prepare(
        `
        SELECT
          source,
          channel_id,
          channel_name,
          last_active,
          json_array_length(context) as message_count
        FROM messenger_sessions
        ORDER BY last_active DESC
        LIMIT 10
      `
      )
      .all() as Array<{
      source: string;
      channel_id: string;
      channel_name: string | null;
      last_active: number;
      message_count: number;
    }>;

    const channels = channelRows.map((row) => ({
      source: row.source,
      channelId: row.channel_id,
      channelName: row.channel_name || null,
      lastActive: row.last_active,
      messageCount: row.message_count || 0,
    }));

    sessionsDb.close();

    return { total, bySource, channels };
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[GraphAPI] Session stats error:', message);
    return { total: 0, bySource: {}, channels: [] };
  }
}

async function handleGetConfigRequest(_req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    const config = loadMAMAConfig();

    const maskedConfig = {
      version: config.version || 1,
      agent: {
        ...(config.agent || {}),
        tools: config.agent?.tools || {
          gateway: ['*'],
          mcp: [],
          mcp_config: '~/.mama/mama-mcp-config.json',
        },
      },
      database: config.database || {},
      logging: config.logging || {},
      discord: config.discord
        ? {
            enabled: config.discord.enabled || false,
            token: config.discord.token ? maskToken(config.discord.token) : '',
            default_channel_id: config.discord.default_channel_id || '',
          }
        : { enabled: false, token: '', default_channel_id: '' },
      slack: config.slack
        ? {
            enabled: config.slack.enabled || false,
            bot_token: config.slack.bot_token ? maskToken(config.slack.bot_token) : '',
            app_token: config.slack.app_token ? maskToken(config.slack.app_token) : '',
          }
        : { enabled: false, bot_token: '', app_token: '' },
      telegram: config.telegram
        ? {
            enabled: config.telegram.enabled || false,
            token: config.telegram.token ? maskToken(config.telegram.token) : '',
          }
        : { enabled: false, token: '' },
      chatwork: config.chatwork
        ? {
            enabled: config.chatwork.enabled || false,
            api_token: config.chatwork.api_token ? maskToken(config.chatwork.api_token) : '',
          }
        : { enabled: false, api_token: '' },
      heartbeat: config.heartbeat || {
        enabled: false,
        interval: 1800000,
        quiet_start: 23,
        quiet_end: 8,
      },
      roles: config.roles || {
        definitions: {
          os_agent: {
            model: 'claude-sonnet-4-20250514',
            maxTurns: 20,
            allowedTools: ['*'],
            systemControl: true,
            sensitiveAccess: true,
          },
          chat_bot: {
            model: 'claude-sonnet-4-20250514',
            maxTurns: 10,
            allowedTools: ['mama_*', 'Read', 'discord_send'],
            blockedTools: ['Bash', 'Write'],
            systemControl: false,
            sensitiveAccess: false,
          },
        },
        sourceMapping: {
          viewer: 'os_agent',
          discord: 'chat_bot',
          telegram: 'chat_bot',
          slack: 'chat_bot',
          chatwork: 'chat_bot',
        },
      },
      multi_agent: config.multi_agent
        ? {
            enabled: config.multi_agent.enabled || false,
            agents: maskAgentsTokens(config.multi_agent.agents || {}),
            loop_prevention: config.multi_agent.loop_prevention || {
              max_chain_length: 3,
              global_cooldown_ms: 2000,
              chain_window_ms: 60000,
            },
            free_chat: config.multi_agent.free_chat || false,
            default_agent: config.multi_agent.default_agent || null,
            mention_delegation: config.multi_agent.mention_delegation || false,
            max_mention_depth: config.multi_agent.max_mention_depth || 3,
          }
        : undefined,
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(maskedConfig));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[GraphAPI] Get config error:', message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: true,
        code: 'CONFIG_ERROR',
        message,
      })
    );
  }
}

async function handleUpdateConfigRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    // Verify authentication for config modifications
    if (!isAuthenticated(req)) {
      res.writeHead(401, {
        'Content-Type': 'application/json',
        'WWW-Authenticate': 'Bearer realm="MAMA API"',
      });
      res.end(
        JSON.stringify({
          error: true,
          code: 'UNAUTHORIZED',
          message:
            'Authentication required. Set MAMA_AUTH_TOKEN or MAMA_SERVER_TOKEN environment variable ' +
            'and provide it in the Authorization header.',
        })
      );
      return;
    }

    const body = await readBody(req);

    const currentConfig = loadMAMAConfig();

    let updatedConfig: Record<string, unknown>;
    try {
      updatedConfig = mergeConfigUpdates(currentConfig, body);
    } catch (err) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: true,
          code: 'VALIDATION_ERROR',
          message: err instanceof Error ? err.message : String(err),
        })
      );
      return;
    }

    const errors = validateConfigUpdate(updatedConfig);
    if (errors.length > 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: true,
          code: 'VALIDATION_ERROR',
          message: errors.join(', '),
        })
      );
      return;
    }

    saveMAMAConfig(updatedConfig);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        success: true,
        message: 'Configuration saved successfully',
      })
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[GraphAPI] Update config error:', message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: true,
        code: 'CONFIG_ERROR',
        message,
      })
    );
  }
}

function maskToken(token: string): string {
  if (!token || token.length < 4) {
    return '***[redacted]***';
  }
  return '***[redacted]***';
}

function isLocalRequest(req: IncomingMessage): boolean {
  const remoteAddr = req.socket?.remoteAddress;
  return remoteAddr === '127.0.0.1' || remoteAddr === '::1' || remoteAddr === '::ffff:127.0.0.1';
}

function isAuthenticated(req: IncomingMessage): boolean {
  const adminToken = process.env.MAMA_AUTH_TOKEN || process.env.MAMA_SERVER_TOKEN;
  if (!adminToken) {
    // Allow local requests without token (setup wizard, local dashboard)
    if (isLocalRequest(req)) {
      return true;
    }
    console.warn(
      '[GraphAPI] No admin token configured. Set MAMA_AUTH_TOKEN or MAMA_SERVER_TOKEN environment variable.'
    );
    return false;
  }

  const authHeader = req.headers.authorization;
  if (!authHeader) {
    return false;
  }

  // Support both "Bearer token" and "token" formats
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7) : authHeader;

  // Use timing-safe comparison to prevent timing side-channel attacks
  if (token.length !== adminToken.length) {
    return false;
  }
  return timingSafeEqual(Buffer.from(token), Buffer.from(adminToken));
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function maskAgentsTokens(agents: Record<string, any>): Record<string, any> {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const masked: Record<string, any> = {};
  for (const [id, agent] of Object.entries(agents)) {
    masked[id] = { ...agent };
    if (agent.bot_token) {
      masked[id].bot_token = maskToken(agent.bot_token);
    }
    if (agent.slack_bot_token) {
      masked[id].slack_bot_token = maskToken(agent.slack_bot_token);
    }
    if (agent.slack_app_token) {
      masked[id].slack_app_token = maskToken(agent.slack_app_token);
    }
  }
  return masked;
}

/* eslint-disable @typescript-eslint/no-explicit-any */
function mergeConfigUpdates(
  current: Record<string, any>,
  updates: Record<string, unknown>
): Record<string, any> {
  /* eslint-enable @typescript-eslint/no-explicit-any */
  const merged = { ...current };

  if (updates.use_claude_cli !== undefined) {
    if (typeof updates.use_claude_cli !== 'boolean') {
      throw new Error('use_claude_cli must be a boolean');
    }
    merged.use_claude_cli = updates.use_claude_cli;
  }

  if (updates.agent) {
    merged.agent = {
      ...current.agent,
      ...(updates.agent as Record<string, unknown>),
    };
  }

  if (updates.heartbeat) {
    merged.heartbeat = {
      ...current.heartbeat,
      ...(updates.heartbeat as Record<string, unknown>),
    };
  }

  if (updates.discord) {
    const discordUpdates = updates.discord as Record<string, unknown>;
    merged.discord = {
      ...current.discord,
      enabled: discordUpdates.enabled,
      default_channel_id: discordUpdates.default_channel_id || current.discord?.default_channel_id,
    };
    if (discordUpdates.token && typeof discordUpdates.token === 'string') {
      const isMasked =
        discordUpdates.token === '***[redacted]***' ||
        (discordUpdates.token.startsWith('***[') && discordUpdates.token.endsWith(']***'));
      if (!isMasked) {
        merged.discord.token = discordUpdates.token;
      }
    }
  }

  if (updates.slack) {
    const slackUpdates = updates.slack as Record<string, unknown>;
    merged.slack = {
      ...current.slack,
      enabled: slackUpdates.enabled,
    };
    if (slackUpdates.bot_token && typeof slackUpdates.bot_token === 'string') {
      const isMasked =
        slackUpdates.bot_token === '***[redacted]***' ||
        (slackUpdates.bot_token.startsWith('***[') && slackUpdates.bot_token.endsWith(']***'));
      if (!isMasked) {
        merged.slack.bot_token = slackUpdates.bot_token;
      }
    }
    if (slackUpdates.app_token && typeof slackUpdates.app_token === 'string') {
      const isMasked =
        slackUpdates.app_token === '***[redacted]***' ||
        (slackUpdates.app_token.startsWith('***[') && slackUpdates.app_token.endsWith(']***'));
      if (!isMasked) {
        merged.slack.app_token = slackUpdates.app_token;
      }
    }
  }

  if (updates.telegram) {
    const telegramUpdates = updates.telegram as Record<string, unknown>;
    merged.telegram = {
      ...current.telegram,
      enabled: telegramUpdates.enabled,
    };
    if (telegramUpdates.token && typeof telegramUpdates.token === 'string') {
      const isMasked =
        telegramUpdates.token === '***[redacted]***' ||
        (telegramUpdates.token.startsWith('***[') && telegramUpdates.token.endsWith(']***'));
      if (!isMasked) {
        merged.telegram.token = telegramUpdates.token;
      }
    }
  }

  if (updates.chatwork) {
    const chatworkUpdates = updates.chatwork as Record<string, unknown>;
    merged.chatwork = {
      ...current.chatwork,
      enabled: chatworkUpdates.enabled,
    };
    if (chatworkUpdates.api_token && typeof chatworkUpdates.api_token === 'string') {
      const isMasked =
        chatworkUpdates.api_token === '***[redacted]***' ||
        (chatworkUpdates.api_token.startsWith('***[') &&
          chatworkUpdates.api_token.endsWith(']***'));
      if (!isMasked) {
        merged.chatwork.api_token = chatworkUpdates.api_token;
      }
    }
  }

  if (updates.multi_agent) {
    const multiAgentUpdates = updates.multi_agent as Record<string, unknown>;
    merged.multi_agent = {
      ...current.multi_agent,
      ...multiAgentUpdates,
    };

    if (multiAgentUpdates.agents) {
      const agentUpdatesMap = multiAgentUpdates.agents as Record<string, Record<string, unknown>>;
      merged.multi_agent.agents = { ...current.multi_agent?.agents };
      for (const [agentId, agentUpdates] of Object.entries(agentUpdatesMap)) {
        const currentAgent = current.multi_agent?.agents?.[agentId] || {};
        merged.multi_agent.agents[agentId] = {
          ...currentAgent,
          ...agentUpdates,
        };

        if (agentUpdates.bot_token && typeof agentUpdates.bot_token === 'string') {
          const isMasked =
            agentUpdates.bot_token === '***[redacted]***' ||
            (agentUpdates.bot_token.startsWith('***[') && agentUpdates.bot_token.endsWith(']***'));
          if (isMasked) {
            merged.multi_agent.agents[agentId].bot_token = currentAgent.bot_token;
          }
        }
        if (agentUpdates.slack_bot_token && typeof agentUpdates.slack_bot_token === 'string') {
          const isMasked =
            agentUpdates.slack_bot_token === '***[redacted]***' ||
            (agentUpdates.slack_bot_token.startsWith('***[') &&
              agentUpdates.slack_bot_token.endsWith(']***'));
          if (isMasked) {
            merged.multi_agent.agents[agentId].slack_bot_token = currentAgent.slack_bot_token;
          }
        }
        if (agentUpdates.slack_app_token && typeof agentUpdates.slack_app_token === 'string') {
          const isMasked =
            agentUpdates.slack_app_token === '***[redacted]***' ||
            (agentUpdates.slack_app_token.startsWith('***[') &&
              agentUpdates.slack_app_token.endsWith(']***'));
          if (isMasked) {
            merged.multi_agent.agents[agentId].slack_app_token = currentAgent.slack_app_token;
          }
        }
      }
    }
  }

  return merged;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function validateConfigUpdate(config: Record<string, any>): string[] {
  const errors: string[] = [];

  if (config.agent) {
    if (config.agent.max_turns && (config.agent.max_turns < 1 || config.agent.max_turns > 100)) {
      errors.push('max_turns must be between 1 and 100');
    }
    if (config.agent.timeout && config.agent.timeout < 1000) {
      errors.push('timeout must be at least 1000ms');
    }
  }

  if (config.heartbeat) {
    if (config.heartbeat.interval && config.heartbeat.interval < 60000) {
      errors.push('heartbeat interval must be at least 60000ms (1 minute)');
    }
  }

  if (config.use_claude_cli !== undefined && typeof config.use_claude_cli !== 'boolean') {
    errors.push('use_claude_cli must be a boolean');
  }

  return errors;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function saveMAMAConfig(config: Record<string, any>): void {
  const configDir = path.dirname(MAMA_CONFIG_PATH);

  if (!fs.existsSync(configDir)) {
    fs.mkdirSync(configDir, { recursive: true });
  }

  const content = yaml.dump(config, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
  });

  const fileContent = `# MAMA Configuration
# Updated: ${new Date().toISOString()}
# Documentation: https://github.com/jungjaehoon-lifegamez/MAMA

${content}`;

  fs.writeFileSync(MAMA_CONFIG_PATH, fileContent, 'utf8');
  console.log('[GraphAPI] Config saved to:', MAMA_CONFIG_PATH);
}

async function handleExportRequest(
  _req: IncomingMessage,
  res: ServerResponse,
  params: URLSearchParams
): Promise<void> {
  try {
    const format = params.get('format') || 'json';

    await initDB();

    const decisions = await getAllNodes();

    let content: string;
    let contentType: string;
    let filename: string;

    switch (format) {
      case 'markdown':
        content = exportToMarkdown(decisions);
        contentType = 'text/markdown';
        filename = `mama-decisions-${new Date().toISOString().split('T')[0]}.md`;
        break;
      case 'csv':
        content = exportToCSV(decisions);
        contentType = 'text/csv';
        filename = `mama-decisions-${new Date().toISOString().split('T')[0]}.csv`;
        break;
      case 'json':
      default:
        content = JSON.stringify({ decisions, exported_at: new Date().toISOString() }, null, 2);
        contentType = 'application/json';
        filename = `mama-decisions-${new Date().toISOString().split('T')[0]}.json`;
        break;
    }

    res.writeHead(200, {
      'Content-Type': contentType,
      'Content-Disposition': `attachment; filename="${filename}"`,
    });
    res.end(content);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[GraphAPI] Export error:', message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: true,
        code: 'EXPORT_ERROR',
        message,
      })
    );
  }
}

function exportToMarkdown(decisions: GraphNode[]): string {
  const lines = [
    '# MAMA Decisions Export',
    '',
    `Exported: ${new Date().toISOString()}`,
    `Total Decisions: ${decisions.length}`,
    '',
    '---',
    '',
  ];

  for (const d of decisions) {
    lines.push(`## ${d.topic || 'Untitled'}`);
    lines.push('');
    lines.push(`**Decision:** ${d.decision || 'N/A'}`);
    lines.push('');
    if (d.reasoning) {
      lines.push(`**Reasoning:**`);
      lines.push('');
      lines.push(d.reasoning);
      lines.push('');
    }
    lines.push(`- **Outcome:** ${d.outcome || 'Pending'}`);
    lines.push(`- **Confidence:** ${d.confidence || 'N/A'}`);
    lines.push(`- **Created:** ${d.created_at ? new Date(d.created_at).toISOString() : 'N/A'}`);
    lines.push(`- **ID:** \`${d.id}\``);
    lines.push('');
    lines.push('---');
    lines.push('');
  }

  return lines.join('\n');
}

async function handleMultiAgentStatusRequest(
  _req: IncomingMessage,
  res: ServerResponse,
  options: GraphHandlerOptions = {}
): Promise<void> {
  try {
    const config = loadMAMAConfig();
    const multiAgentConfig = config.multi_agent || { enabled: false, agents: {} };

    const agentStatesMap = options.getAgentStates ? options.getAgentStates() : null;

    const agents: Array<{
      id: string;
      name: string;
      tier: number;
      model: string;
      status: string;
      lastActivity: null;
    }> = [];
    if (multiAgentConfig.enabled && multiAgentConfig.agents) {
      for (const [id, agentConfig] of Object.entries(multiAgentConfig.agents) as Array<
        [string, Record<string, unknown>]
      >) {
        let status = 'online';
        if (agentConfig.enabled === false) {
          status = 'disabled';
        } else if (agentStatesMap && agentStatesMap.has(id)) {
          status = agentStatesMap.get(id)!;
        }

        agents.push({
          id,
          name: (agentConfig.name as string) || id,
          tier: (agentConfig.tier as number) || 1,
          model: (agentConfig.model as string) || config.agent?.model || 'claude-sonnet-4-20250514',
          status,
          lastActivity: null,
        });
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        enabled: multiAgentConfig.enabled || false,
        agents,
        recentDelegations: [],
        activeChains: 0,
      })
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[GraphAPI] Multi-agent status error:', message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: true,
        code: 'MULTI_AGENT_STATUS_ERROR',
        message,
      })
    );
  }
}

async function handleMultiAgentAgentsRequest(
  _req: IncomingMessage,
  res: ServerResponse
): Promise<void> {
  try {
    const config = loadMAMAConfig();
    const multiAgentConfig = config.multi_agent || { enabled: false, agents: {} };

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const agentsList: Array<Record<string, any>> = [];
    if (multiAgentConfig.agents) {
      for (const [id, agentConfig] of Object.entries(multiAgentConfig.agents) as Array<
        [string, Record<string, unknown>]
      >) {
        agentsList.push({
          id,
          name: agentConfig.name || id,
          display_name: agentConfig.display_name || agentConfig.name || id,
          tier: agentConfig.tier || 1,
          model: agentConfig.model || null,
          enabled: agentConfig.enabled !== false,
          persona_file: agentConfig.persona_file || null,
          trigger_prefix: agentConfig.trigger_prefix || null,
          bot_token: agentConfig.bot_token ? maskToken(agentConfig.bot_token as string) : null,
          slack_bot_token: agentConfig.slack_bot_token
            ? maskToken(agentConfig.slack_bot_token as string)
            : null,
          slack_app_token: agentConfig.slack_app_token
            ? maskToken(agentConfig.slack_app_token as string)
            : null,
          auto_respond_keywords: agentConfig.auto_respond_keywords || [],
          cooldown_ms: agentConfig.cooldown_ms || 5000,
          can_delegate: agentConfig.can_delegate || false,
          tool_permissions: agentConfig.tool_permissions || null,
        });
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ agents: agentsList }));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[GraphAPI] Multi-agent agents list error:', message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: true,
        code: 'MULTI_AGENT_AGENTS_ERROR',
        message,
      })
    );
  }
}

async function handleMultiAgentUpdateAgentRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): Promise<void> {
  try {
    // Security: require authentication for config-writing endpoint
    if (!isAuthenticated(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: true,
          code: 'UNAUTHORIZED',
          message: 'Authentication required. Set Authorization header with valid token.',
        })
      );
      return;
    }

    const match = pathname.match(/\/api\/multi-agent\/agents\/([^/]+)/);
    if (!match) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: true,
          code: 'INVALID_URL',
          message: 'Invalid agent ID in URL',
        })
      );
      return;
    }

    const agentId = match[1];

    if (!/^[a-z0-9_-]+$/i.test(agentId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: true,
          code: 'INVALID_AGENT_ID',
          message: 'Invalid agent ID format',
        })
      );
      return;
    }

    const body = await readBody(req);

    const config = loadMAMAConfig();
    if (!config.multi_agent) {
      config.multi_agent = { enabled: false, agents: {} };
    }
    if (!config.multi_agent.agents) {
      config.multi_agent.agents = {};
    }
    if (!config.multi_agent.agents[agentId]) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: true,
          code: 'AGENT_NOT_FOUND',
          message: `Agent '${agentId}' not found`,
        })
      );
      return;
    }

    const currentAgent = config.multi_agent.agents[agentId];
    const updatedAgent = { ...currentAgent };

    // Validate critical field types before applying
    const validationErrors: string[] = [];
    if (
      body.tier !== undefined &&
      (typeof body.tier !== 'number' || body.tier < 1 || body.tier > 3)
    ) {
      validationErrors.push('tier must be a number between 1 and 3');
    }
    if (body.enabled !== undefined && typeof body.enabled !== 'boolean') {
      validationErrors.push('enabled must be a boolean');
    }
    if (
      body.cooldown_ms !== undefined &&
      (typeof body.cooldown_ms !== 'number' || body.cooldown_ms < 0)
    ) {
      validationErrors.push('cooldown_ms must be a non-negative number');
    }
    if (body.can_delegate !== undefined && typeof body.can_delegate !== 'boolean') {
      validationErrors.push('can_delegate must be a boolean');
    }

    if (validationErrors.length > 0) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: true,
          code: 'VALIDATION_ERROR',
          message: validationErrors.join(', '),
        })
      );
      return;
    }

    if (body.name !== undefined) updatedAgent.name = body.name;
    if (body.display_name !== undefined) updatedAgent.display_name = body.display_name;
    if (body.tier !== undefined) updatedAgent.tier = body.tier;
    if (body.model !== undefined) updatedAgent.model = body.model;
    if (body.enabled !== undefined) updatedAgent.enabled = body.enabled;
    if (body.persona_file !== undefined) updatedAgent.persona_file = body.persona_file;
    if (body.trigger_prefix !== undefined) updatedAgent.trigger_prefix = body.trigger_prefix;
    if (body.auto_respond_keywords !== undefined)
      updatedAgent.auto_respond_keywords = body.auto_respond_keywords;
    if (body.cooldown_ms !== undefined) updatedAgent.cooldown_ms = body.cooldown_ms;
    if (body.can_delegate !== undefined) updatedAgent.can_delegate = body.can_delegate;
    if (body.tool_permissions !== undefined) updatedAgent.tool_permissions = body.tool_permissions;

    const isMaskedToken = (token: unknown): boolean => {
      if (typeof token !== 'string') return false;
      return token === '***[redacted]***' || (token.startsWith('***[') && token.endsWith(']***'));
    };

    if (body.bot_token && !isMaskedToken(body.bot_token)) {
      updatedAgent.bot_token = body.bot_token;
    }
    if (body.slack_bot_token && !isMaskedToken(body.slack_bot_token)) {
      updatedAgent.slack_bot_token = body.slack_bot_token;
    }
    if (body.slack_app_token && !isMaskedToken(body.slack_app_token)) {
      updatedAgent.slack_app_token = body.slack_app_token;
    }

    config.multi_agent.agents[agentId] = updatedAgent;
    saveMAMAConfig(config);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        success: true,
        message: `Agent '${agentId}' updated successfully`,
      })
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[GraphAPI] Multi-agent update agent error:', message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: true,
        code: 'MULTI_AGENT_UPDATE_ERROR',
        message,
      })
    );
  }
}

async function handleMultiAgentDelegationsRequest(
  req: IncomingMessage,
  res: ServerResponse,
  options: GraphHandlerOptions = {}
): Promise<void> {
  try {
    const url = new URL(req.url!, `http://${req.headers.host}`);
    const limit = parseInt(url.searchParams.get('limit') || '20', 10);

    let delegations: Array<{
      id: string;
      description: string;
      category: string;
      wave: number;
      status: string;
      claimedBy: string | null;
      claimedAt: number | null;
      completedAt: number | null;
      result: string | null;
    }> = [];
    if (options.getSwarmTasks) {
      try {
        const tasks = options.getSwarmTasks(limit);
        delegations = tasks.map((task) => ({
          id: task.id,
          description: task.description,
          category: task.category,
          wave: task.wave,
          status: task.status,
          claimedBy: task.claimed_by,
          claimedAt: task.claimed_at,
          completedAt: task.completed_at,
          result: task.result,
        }));
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error('[GraphAPI] Failed to fetch swarm tasks:', msg);
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        delegations,
        count: delegations.length,
      })
    );
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.error('[GraphAPI] Multi-agent delegations error:', message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: true,
        code: 'MULTI_AGENT_DELEGATIONS_ERROR',
        message,
      })
    );
  }
}

function exportToCSV(decisions: GraphNode[]): string {
  const escapeCSV = (str: string | null | undefined): string => {
    if (!str) {
      return '';
    }
    const escaped = String(str).replace(/"/g, '""');
    return escaped.includes(',') || escaped.includes('\n') || escaped.includes('"')
      ? `"${escaped}"`
      : escaped;
  };

  const headers = ['id', 'topic', 'decision', 'reasoning', 'outcome', 'confidence', 'created_at'];
  const lines = [headers.join(',')];

  for (const d of decisions) {
    const row = [
      escapeCSV(d.id),
      escapeCSV(d.topic),
      escapeCSV(d.decision),
      escapeCSV(d.reasoning),
      escapeCSV(d.outcome),
      d.confidence ?? '',
      d.created_at ? new Date(d.created_at).toISOString() : '',
    ];
    lines.push(row.join(','));
  }

  return lines.join('\n');
}

/**
 * Handle GET /api/mcp-servers - return available MCP servers from config
 * Security: Requires authentication, redacts sensitive fields (command, url, configPath)
 */
async function handleMCPServersRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  try {
    // Security: require authentication for config endpoint
    if (!isAuthenticated(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: true,
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        })
      );
      return;
    }

    const config = loadMAMAConfig();
    const mcpConfigPath = config.agent?.tools?.mcp_config || '~/.mama/mama-mcp-config.json';
    const resolvedPath = mcpConfigPath.replace(/^~/, os.homedir());

    let mcpServers: Record<string, unknown> = {};

    if (fs.existsSync(resolvedPath)) {
      const content = fs.readFileSync(resolvedPath, 'utf8');
      const mcpConfig = JSON.parse(content);
      mcpServers = mcpConfig.mcpServers || {};
    }

    // Transform to array with server names - redact sensitive fields
    const servers = Object.entries(mcpServers).map(([name, serverConfig]) => {
      const cfg = serverConfig as Record<string, unknown>;
      return {
        name,
        type: cfg.type || 'stdio',
        // Redact command and url to prevent credential leakage
        hasCommand: !!cfg.command,
        hasUrl: !!cfg.url,
        // Mask args to prevent credential leakage (show count only)
        hasArgs: Array.isArray(cfg.args) && cfg.args.length > 0,
        argCount: Array.isArray(cfg.args) ? cfg.args.length : 0,
      };
    });

    // Remove configPath from response to prevent path disclosure
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ servers }));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('MCP servers list error:', message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: true,
        code: 'MCP_SERVERS_ERROR',
        message,
      })
    );
  }
}

/**
 * Handle DELETE /api/mcp-servers/:name - remove MCP server from config
 */
async function handleDeleteMCPServerRequest(
  req: IncomingMessage,
  res: ServerResponse,
  pathname: string
): Promise<void> {
  try {
    // Security: require authentication for config-writing endpoint
    if (!isAuthenticated(req)) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(
        JSON.stringify({
          error: true,
          code: 'UNAUTHORIZED',
          message: 'Authentication required',
        })
      );
      return;
    }

    const match = pathname.match(/\/api\/mcp-servers\/([^/]+)/);
    if (!match) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: true, message: 'Invalid server name' }));
      return;
    }

    // Safely decode URI component - malformed percent-encoding throws URIError
    let serverName: string;
    try {
      serverName = decodeURIComponent(match[1]);
    } catch (e) {
      if (e instanceof URIError) {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: true, message: 'Invalid server name encoding' }));
        return;
      }
      throw e; // Re-throw non-decoding errors
    }

    // Validate serverName format (same pattern as agentId validation)
    const SERVER_NAME_PATTERN = /^[a-z0-9_-]+$/i;
    if (!SERVER_NAME_PATTERN.test(serverName)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: true, message: 'Invalid server name format' }));
      return;
    }

    const config = loadMAMAConfig();
    const mcpConfigPath = config.agent?.tools?.mcp_config || '~/.mama/mama-mcp-config.json';
    const resolvedPath = mcpConfigPath.replace(/^~/, os.homedir());

    if (!fs.existsSync(resolvedPath)) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: true, message: 'MCP config not found' }));
      return;
    }

    const content = fs.readFileSync(resolvedPath, 'utf8');
    const mcpConfig = JSON.parse(content);

    if (!mcpConfig.mcpServers || !mcpConfig.mcpServers[serverName]) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: true, message: `Server "${serverName}" not found` }));
      return;
    }

    delete mcpConfig.mcpServers[serverName];
    fs.writeFileSync(resolvedPath, JSON.stringify(mcpConfig, null, 2), 'utf8');

    logger.info('Removed MCP server:', serverName);
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ deleted: true, name: serverName }));
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    logger.error('Delete MCP server error:', message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ error: true, message }));
  }
}

export {
  createGraphHandler,
  getAllNodes,
  getAllEdges,
  getAllCheckpoints,
  getUniqueTopics,
  filterNodesByTopic,
  filterEdgesByNodes,
  VIEWER_HTML_PATH,
  VIEWER_CSS_PATH,
  VIEWER_JS_PATH,
};

export type {
  GraphNode,
  GraphEdge,
  SimilarityEdge,
  CheckpointData,
  GraphHandlerOptions,
} from './graph-api-types.js';
