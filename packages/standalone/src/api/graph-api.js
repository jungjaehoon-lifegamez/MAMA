/**
 * MAMA Graph API
 *
 * HTTP API endpoints for Graph Viewer.
 * Provides /graph endpoint for fetching decisions and edges data.
 * Provides /viewer endpoint for serving HTML viewer.
 *
 * Story 1.1: Graph API 엔드포인트 추가
 * Story 1.3: Viewer HTML 서빙
 *
 * @module graph-api
 * @version 1.1.0
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const yaml = require('js-yaml');
const { getAdapter, initDB, vectorSearch } = require('@jungjaehoon/mama-core/memory-store');
const { generateEmbedding } = require('@jungjaehoon/mama-core/embeddings');
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

/**
 * Get all decisions as graph nodes
 *
 * @returns {Promise<Array>} Array of node objects
 */
async function getAllNodes() {
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

  const rows = stmt.all();

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

/**
 * Get all decision edges
 *
 * @returns {Promise<Array>} Array of edge objects
 */
async function getAllEdges() {
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

  const rows = stmt.all();

  return rows.map((row) => ({
    from: row.from_id,
    to: row.to_id,
    relationship: row.relationship,
    reason: row.reason,
  }));
}

/**
 * Get all checkpoints
 *
 * @returns {Promise<Array>} Array of checkpoint objects
 */
async function getAllCheckpoints() {
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

  const rows = stmt.all();

  return rows.map((row) => ({
    id: row.id,
    timestamp: row.timestamp,
    summary: row.summary,
    open_files: row.open_files ? JSON.parse(row.open_files) : [],
    next_steps: row.next_steps,
    status: row.status,
  }));
}

/**
 * Get unique topics from nodes
 *
 * @param {Array} nodes - Array of node objects
 * @returns {Array<string>} Unique topics
 */
function getUniqueTopics(nodes) {
  const topicSet = new Set(nodes.map((n) => n.topic));
  return Array.from(topicSet).sort();
}

/**
 * Filter nodes by topic
 *
 * @param {Array} nodes - Array of node objects
 * @param {string} topic - Topic to filter by
 * @returns {Array} Filtered nodes
 */
function filterNodesByTopic(nodes, topic) {
  return nodes.filter((n) => n.topic === topic);
}

/**
 * Filter edges to only include those connected to given nodes
 *
 * @param {Array} edges - Array of edge objects
 * @param {Array} nodes - Array of node objects (filtered)
 * @returns {Array} Filtered edges
 */
function filterEdgesByNodes(edges, nodes) {
  const nodeIds = new Set(nodes.map((n) => n.id));
  return edges.filter((e) => nodeIds.has(e.from) || nodeIds.has(e.to));
}

/**
 * Serve static file with appropriate content type
 *
 * @param {Object} res - HTTP response
 * @param {string} filePath - Path to file
 * @param {string} contentType - MIME type
 */
function serveStaticFile(res, filePath, contentType) {
  try {
    // Binary content types should be read without encoding
    const isBinary = contentType.startsWith('image/') || contentType === 'application/octet-stream';
    const content = isBinary ? fs.readFileSync(filePath) : fs.readFileSync(filePath, 'utf8');
    const etag = `"${Date.now()}"`; // Force browser to reload

    // Only add charset for text content types
    const fullContentType = isBinary ? contentType : `${contentType}; charset=utf-8`;

    res.writeHead(200, {
      'Content-Type': fullContentType,
      'Cache-Control': 'no-cache, no-store, must-revalidate, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
      ETag: etag,
    });
    res.end(content);
  } catch (error) {
    console.error(`[GraphAPI] Static file error: ${error.message}`);
    res.writeHead(500, { 'Content-Type': 'text/plain' });
    res.end('Error loading file: ' + error.message);
  }
}

/**
 * Handle GET /viewer request - serve HTML viewer
 *
 * @param {Object} req - HTTP request
 * @param {Object} res - HTTP response
 */
function handleViewerRequest(req, res) {
  serveStaticFile(res, VIEWER_HTML_PATH, 'text/html');
}

/**
 * Handle GET /viewer.css request
 *
 * @param {Object} req - HTTP request
 * @param {Object} res - HTTP response
 */
function handleCssRequest(req, res) {
  serveStaticFile(res, VIEWER_CSS_PATH, 'text/css');
}

/**
 * Handle GET /viewer.js request
 *
 * @param {Object} req - HTTP request
 * @param {Object} res - HTTP response
 */
function handleJsRequest(req, res) {
  serveStaticFile(res, VIEWER_JS_PATH, 'application/javascript');
}

/**
 * Handle GET /graph request
 *
 * @param {Object} req - HTTP request
 * @param {Object} res - HTTP response
 * @param {URLSearchParams} params - Query parameters
 */
async function handleGraphRequest(req, res, params) {
  const startTime = Date.now();

  try {
    // Ensure DB is initialized
    await initDB();

    // Get all data
    let nodes = await getAllNodes();
    let edges = await getAllEdges();

    // Apply topic filter if provided
    const topicFilter = params.get('topic');
    if (topicFilter) {
      nodes = filterNodesByTopic(nodes, topicFilter);
      edges = filterEdgesByNodes(edges, nodes);
    }

    // Add similarity edges for clustering if requested
    const includeCluster = params.get('cluster') === 'true';
    let similarityEdges = [];
    if (includeCluster) {
      similarityEdges = await getSimilarityEdges();
      // Filter to only include edges for visible nodes
      const nodeIds = new Set(nodes.map((n) => n.id));
      similarityEdges = similarityEdges.filter((e) => nodeIds.has(e.from) && nodeIds.has(e.to));
    }

    // Build meta object
    const allTopics = topicFilter ? [topicFilter] : getUniqueTopics(nodes);
    const meta = {
      total_nodes: nodes.length,
      total_edges: edges.length,
      similarity_edges: similarityEdges.length,
      topics: allTopics,
    };

    const latency = Date.now() - startTime;

    // Send response
    res.writeHead(200);
    res.end(
      JSON.stringify({
        nodes,
        edges,
        similarityEdges,
        meta,
        latency,
      })
    );
  } catch (error) {
    console.error(`[GraphAPI] Error: ${error.message}`);
    res.writeHead(500);
    res.end(
      JSON.stringify({
        error: true,
        code: 'INTERNAL_ERROR',
        message: error.message,
      })
    );
  }
}

/**
 * Read request body as JSON
 */
function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk) => (data += chunk));
    req.on('end', () => {
      try {
        resolve(JSON.parse(data));
      } catch (e) {
        reject(new Error('Invalid JSON'));
      }
    });
    req.on('error', reject);
  });
}

/**
 * Handle POST /graph/update request - update decision outcome
 *
 * @param {Object} req - HTTP request
 * @param {Object} res - HTTP response
 */
async function handleUpdateRequest(req, res) {
  try {
    const body = await readBody(req);

    if (!body.id || !body.outcome) {
      res.writeHead(400);
      res.end(
        JSON.stringify({
          error: true,
          code: 'INVALID_REQUEST',
          message: 'Missing required fields: id, outcome',
        })
      );
      return;
    }

    // Ensure DB is initialized
    await initDB();

    // Update outcome using mama-api
    await mama.updateOutcome(body.id, {
      outcome: body.outcome,
      failure_reason: body.reason,
    });

    res.writeHead(200);
    res.end(
      JSON.stringify({
        success: true,
        id: body.id,
        outcome: body.outcome.toUpperCase(),
      })
    );
  } catch (error) {
    console.error(`[GraphAPI] Update error: ${error.message}`);
    res.writeHead(500);
    res.end(
      JSON.stringify({
        error: true,
        code: 'UPDATE_FAILED',
        message: error.message,
      })
    );
  }
}

/**
 * Get similarity edges for layout clustering
 * Returns edges between highly similar decisions (threshold > 0.7)
 *
 * @returns {Promise<Array>} Array of similarity edge objects
 */
async function getSimilarityEdges() {
  const adapter = getAdapter();

  // Get all decisions (embeddings stored in vss_memories table)
  const stmt = adapter.prepare(`
    SELECT id, topic, decision FROM decisions
    ORDER BY created_at DESC
    LIMIT 100
  `);
  const decisions = stmt.all(); // better-sqlite3 is synchronous

  if (decisions.length < 2) {
    return [];
  }

  const similarityEdges = [];
  const similarityEdgeKeys = new Set(); // O(1) duplicate checking

  // For each decision, find its most similar peers
  for (const decision of decisions.slice(0, 50)) {
    // Limit to first 50 for performance
    try {
      const query = `${decision.topic} ${decision.decision}`;
      const embedding = await generateEmbedding(query);
      const similar = await vectorSearch(embedding, 3, 0.7); // Top 3 with >70% similarity

      for (const s of similar) {
        if (s.id !== decision.id && s.similarity > 0.7) {
          // Avoid duplicates (A->B and B->A) using Set for O(1) lookup
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
    } catch (e) {
      console.error(`[GraphAPI] Similarity search error for ${decision.id}:`, e.message);
    }
  }

  return similarityEdges;
}

/**
 * Handle GET /graph/similar request - find similar decisions
 *
 * @param {Object} req - HTTP request
 * @param {Object} res - HTTP response
 * @param {URLSearchParams} params - Query parameters (id required)
 */
async function handleSimilarRequest(req, res, params) {
  const startTime = Date.now();
  try {
    const decisionId = params.get('id');
    console.log(`[GraphAPI] Similar request for decision: ${decisionId}`);

    if (!decisionId) {
      res.writeHead(400);
      res.end(
        JSON.stringify({
          error: true,
          code: 'MISSING_ID',
          message: 'Missing required parameter: id',
        })
      );
      return;
    }

    // Ensure DB is initialized
    console.log(`[GraphAPI] Initializing DB...`);
    await initDB();

    // Get the decision by ID
    console.log(`[GraphAPI] Fetching decision ${decisionId}...`);
    const adapter = getAdapter();
    const stmt = adapter.prepare(`
      SELECT topic, decision, reasoning FROM decisions WHERE id = ?
    `);
    const decision = stmt.get(decisionId);

    if (!decision) {
      console.log(`[GraphAPI] Decision ${decisionId} not found`);
      res.writeHead(404);
      res.end(
        JSON.stringify({
          error: true,
          code: 'NOT_FOUND',
          message: 'Decision not found',
        })
      );
      return;
    }

    // Build search query from decision content
    const searchQuery = `${decision.topic} ${decision.decision}`;
    console.log(
      `[GraphAPI] Searching for similar decisions with query: "${searchQuery.substring(0, 50)}..."`
    );

    // Use mama.suggest for semantic search
    const searchStart = Date.now();
    const results = await mama.suggest(searchQuery, {
      limit: 6, // Get 6 to filter out self
      threshold: 0.5,
    });
    console.log(`[GraphAPI] Semantic search completed in ${Date.now() - searchStart}ms`);

    // Filter out the current decision and format results
    let similar = [];
    if (results && results.results) {
      similar = results.results
        .filter((r) => r.id !== decisionId)
        .slice(0, 5)
        .map((r) => ({
          id: r.id,
          topic: r.topic,
          decision: r.decision,
          similarity: r.similarity || r.final_score || 0.5,
          outcome: r.outcome,
        }));
    }

    console.log(
      `[GraphAPI] Found ${similar.length} similar decisions (total time: ${Date.now() - startTime}ms)`
    );

    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
    });
    res.end(
      JSON.stringify({
        id: decisionId,
        similar,
        count: similar.length,
      })
    );
    console.log(`[GraphAPI] Response sent for ${decisionId}`);
  } catch (error) {
    console.error(`[GraphAPI] Similar error: ${error.message}`);
    console.error(`[GraphAPI] Similar error stack:`, error.stack);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: true,
        code: 'SEARCH_FAILED',
        message: error.message,
      })
    );
  }
}

/**
 * Handle GET /api/mama/search request - semantic search for decisions
 * Story 4-1: Memory tab search for mobile chat
 *
 * @param {Object} req - HTTP request
 * @param {Object} res - HTTP response
 * @param {URLSearchParams} params - Query parameters (q required, limit optional)
 */
async function handleMamaSearchRequest(req, res, params) {
  try {
    const query = params.get('q');
    const limit = Math.min(parseInt(params.get('limit') || '10', 10), 20);

    if (!query) {
      res.writeHead(400);
      res.end(
        JSON.stringify({
          error: true,
          code: 'MISSING_QUERY',
          message: 'Missing required parameter: q',
        })
      );
      return;
    }

    // Ensure DB is initialized
    await initDB();

    // Use mama.suggest for semantic search
    const searchResults = await mama.suggest(query, {
      limit: limit,
      threshold: 0.3, // Lower threshold to show more results
    });

    // Format results for mobile display
    let results = [];
    if (searchResults && searchResults.results) {
      results = searchResults.results.map((r) => ({
        id: r.id,
        topic: r.topic,
        decision: r.decision,
        reasoning: r.reasoning,
        outcome: r.outcome,
        confidence: r.confidence,
        similarity: r.similarity || r.final_score || 0.5,
        created_at: r.created_at,
      }));
    }

    res.writeHead(200);
    res.end(
      JSON.stringify({
        query,
        results,
        count: results.length,
      })
    );
  } catch (error) {
    console.error(`[GraphAPI] MAMA search error: ${error.message}`);
    res.writeHead(500);
    res.end(
      JSON.stringify({
        error: true,
        code: 'SEARCH_FAILED',
        message: error.message,
      })
    );
  }
}

/**
 * Handle POST /api/mama/save request - save a new decision
 * Story 4-2: Save decisions from mobile chat UI
 *
 * @param {Object} req - HTTP request
 * @param {Object} res - HTTP response
 */
async function handleMamaSaveRequest(req, res) {
  try {
    const body = await readBody(req);

    // Validate required fields
    if (!body.topic || !body.decision || !body.reasoning) {
      res.writeHead(400);
      res.end(
        JSON.stringify({
          error: true,
          code: 'MISSING_FIELDS',
          message: 'Missing required fields: topic, decision, reasoning',
        })
      );
      return;
    }

    // Ensure DB is initialized
    await initDB();

    // Save decision using mama.saveDecision
    const result = await mama.saveDecision({
      topic: body.topic,
      decision: body.decision,
      reasoning: body.reasoning,
      confidence: body.confidence || 0.8,
    });

    res.writeHead(200);
    res.end(
      JSON.stringify({
        success: true,
        id: result.id,
        message: 'Decision saved successfully',
      })
    );
  } catch (error) {
    console.error(`[GraphAPI] MAMA save error: ${error.message}`);
    res.writeHead(500);
    res.end(
      JSON.stringify({
        error: true,
        code: 'SAVE_FAILED',
        message: error.message,
      })
    );
  }
}

/**
 * Handle POST /api/checkpoint/save request - save session checkpoint
 * Story 4-3: Auto checkpoint feature for mobile chat
 *
 * @param {Object} req - HTTP request
 * @param {Object} res - HTTP response
 */
async function handleCheckpointSaveRequest(req, res) {
  try {
    const body = await readBody(req);

    // Validate required fields
    if (!body.summary) {
      res.writeHead(400);
      res.end(
        JSON.stringify({
          error: true,
          code: 'MISSING_FIELDS',
          message: 'Missing required field: summary',
        })
      );
      return;
    }

    // Ensure DB is initialized
    await initDB();

    // Save checkpoint using mama.saveCheckpoint
    const checkpointId = await mama.saveCheckpoint(
      body.summary,
      body.open_files || [],
      body.next_steps || ''
    );

    res.writeHead(200);
    res.end(
      JSON.stringify({
        success: true,
        id: checkpointId,
        message: 'Checkpoint saved successfully',
      })
    );
  } catch (error) {
    console.error(`[GraphAPI] Checkpoint save error: ${error.message}`);
    res.writeHead(500);
    res.end(
      JSON.stringify({
        error: true,
        code: 'SAVE_FAILED',
        message: error.message,
      })
    );
  }
}

/**
 * Handle GET /api/checkpoint/load request - load latest checkpoint
 * Story 4-3: Session resume feature for mobile chat
 *
 * @param {Object} req - HTTP request
 * @param {Object} res - HTTP response
 */
async function handleCheckpointLoadRequest(req, res) {
  try {
    // Ensure DB is initialized
    await initDB();

    // Load latest checkpoint using mama.loadCheckpoint
    const checkpoint = await mama.loadCheckpoint();

    if (!checkpoint) {
      res.writeHead(404);
      res.end(
        JSON.stringify({
          error: true,
          code: 'NO_CHECKPOINT',
          message: 'No checkpoint found',
        })
      );
      return;
    }

    res.writeHead(200);
    res.end(
      JSON.stringify({
        success: true,
        checkpoint,
      })
    );
  } catch (error) {
    console.error(`[GraphAPI] Checkpoint load error: ${error.message}`);
    res.writeHead(500);
    res.end(
      JSON.stringify({
        error: true,
        code: 'LOAD_FAILED',
        message: error.message,
      })
    );
  }
}

/**
 * Handle GET /checkpoints request - list all checkpoints
 *
 * @param {Object} req - HTTP request
 * @param {Object} res - HTTP response
 */
async function handleCheckpointsRequest(req, res) {
  try {
    // Ensure DB is initialized
    await initDB();

    const checkpoints = await getAllCheckpoints();

    res.writeHead(200);
    res.end(
      JSON.stringify({
        checkpoints,
        count: checkpoints.length,
      })
    );
  } catch (error) {
    console.error(`[GraphAPI] Checkpoints error: ${error.message}`);
    res.writeHead(500);
    res.end(
      JSON.stringify({
        error: true,
        code: 'CHECKPOINTS_FAILED',
        message: error.message,
      })
    );
  }
}

/**
 * Create route handler for graph API
 *
 * Returns a function that handles /graph and /viewer requests within the existing
 * embedding-http-server request handler.
 *
 * @returns {Function} Route handler function
 */
function createGraphHandler() {
  return async function graphHandler(req, res) {
    // Parse URL
    const url = new URL(req.url, `http://${req.headers.host}`);
    const pathname = url.pathname;
    const params = url.searchParams;

    console.log('[GraphHandler] Request:', req.method, pathname);

    // Route: GET / - redirect to /viewer
    if (pathname === '/' && req.method === 'GET') {
      console.log('[GraphHandler] Redirecting / to /viewer');
      res.writeHead(302, { Location: '/viewer' });
      res.end();
      return true; // Request handled
    }

    // Route: GET /viewer - serve HTML viewer
    if (pathname === '/viewer' && req.method === 'GET') {
      console.log('[GraphHandler] Serving viewer.html');
      handleViewerRequest(req, res);
      return true; // Request handled
    }

    // Route: GET/HEAD /viewer/viewer.css - serve stylesheet
    if (pathname === '/viewer/viewer.css' && (req.method === 'GET' || req.method === 'HEAD')) {
      handleCssRequest(req, res);
      return true; // Request handled
    }

    // Route: GET/HEAD /viewer.css - serve stylesheet (legacy path)
    if (pathname === '/viewer.css' && (req.method === 'GET' || req.method === 'HEAD')) {
      handleCssRequest(req, res);
      return true; // Request handled
    }

    // Route: GET/HEAD /viewer.js - serve JavaScript
    if (pathname === '/viewer.js' && (req.method === 'GET' || req.method === 'HEAD')) {
      handleJsRequest(req, res);
      return true; // Request handled
    }

    // Route: GET/HEAD /sw.js - serve Service Worker
    if (pathname === '/sw.js' && (req.method === 'GET' || req.method === 'HEAD')) {
      serveStaticFile(res, SW_JS_PATH, 'application/javascript');
      return true; // Request handled
    }

    // Route: GET/HEAD /viewer/sw.js - serve Service Worker (alternative path)
    if (pathname === '/viewer/sw.js' && (req.method === 'GET' || req.method === 'HEAD')) {
      serveStaticFile(res, SW_JS_PATH, 'application/javascript');
      return true; // Request handled
    }

    // Route: GET/HEAD /viewer/manifest.json - serve PWA manifest
    if (pathname === '/viewer/manifest.json' && (req.method === 'GET' || req.method === 'HEAD')) {
      serveStaticFile(res, MANIFEST_JSON_PATH, 'application/json');
      return true; // Request handled
    }

    // Route: GET/HEAD /favicon.ico - serve favicon
    if (pathname === '/favicon.ico' && (req.method === 'GET' || req.method === 'HEAD')) {
      serveStaticFile(res, FAVICON_PATH, 'image/x-icon');
      return true; // Request handled
    }

    // Route: GET/HEAD /viewer/icons/*.png - serve PWA icons
    if (
      pathname.startsWith('/viewer/icons/') &&
      pathname.endsWith('.png') &&
      (req.method === 'GET' || req.method === 'HEAD')
    ) {
      const fileName = pathname.split('/').pop();
      const filePath = path.join(__dirname, '../../public/viewer/icons', fileName);
      serveStaticFile(res, filePath, 'image/png');
      return true; // Request handled
    }

    // Route: GET/HEAD /viewer/icons/*.svg - serve SVG icons
    if (
      pathname.startsWith('/viewer/icons/') &&
      pathname.endsWith('.svg') &&
      (req.method === 'GET' || req.method === 'HEAD')
    ) {
      const fileName = pathname.split('/').pop();
      const filePath = path.join(__dirname, '../../public/viewer/icons', fileName);
      serveStaticFile(res, filePath, 'image/svg+xml');
      return true; // Request handled
    }

    // Route: GET/HEAD /viewer/js/utils/*.js - serve utility modules
    if (
      pathname.startsWith('/viewer/js/utils/') &&
      pathname.endsWith('.js') &&
      (req.method === 'GET' || req.method === 'HEAD')
    ) {
      const fileName = pathname.split('/').pop();
      const filePath = path.join(VIEWER_DIR, 'js', 'utils', fileName);
      serveStaticFile(res, filePath, 'application/javascript');
      return true; // Request handled
    }

    // Route: GET/HEAD /viewer/js/modules/*.js - serve feature modules
    if (
      pathname.startsWith('/viewer/js/modules/') &&
      pathname.endsWith('.js') &&
      (req.method === 'GET' || req.method === 'HEAD')
    ) {
      const fileName = pathname.split('/').pop();
      const filePath = path.join(VIEWER_DIR, 'js', 'modules', fileName);
      serveStaticFile(res, filePath, 'application/javascript');
      return true; // Request handled
    }

    // Route: GET/HEAD /js/utils/*.js - serve utility modules (legacy path)
    if (
      pathname.startsWith('/js/utils/') &&
      pathname.endsWith('.js') &&
      (req.method === 'GET' || req.method === 'HEAD')
    ) {
      const fileName = pathname.split('/').pop();
      const filePath = path.join(VIEWER_DIR, 'js', 'utils', fileName);
      serveStaticFile(res, filePath, 'application/javascript');
      return true; // Request handled
    }

    // Route: GET/HEAD /js/modules/*.js - serve feature modules (legacy path)
    if (
      pathname.startsWith('/js/modules/') &&
      pathname.endsWith('.js') &&
      (req.method === 'GET' || req.method === 'HEAD')
    ) {
      const fileName = pathname.split('/').pop();
      const filePath = path.join(VIEWER_DIR, 'js', 'modules', fileName);
      serveStaticFile(res, filePath, 'application/javascript');
      return true; // Request handled
    }

    // Route: GET /viewer.css - serve stylesheet (legacy path)
    if (pathname === '/viewer.css' && req.method === 'GET') {
      handleCssRequest(req, res);
      return true; // Request handled
    }

    // Route: GET /viewer.js - serve JavaScript
    if (pathname === '/viewer.js' && req.method === 'GET') {
      handleJsRequest(req, res);
      return true; // Request handled
    }

    // Route: GET /sw.js - serve Service Worker
    if (pathname === '/sw.js' && req.method === 'GET') {
      serveStaticFile(res, SW_JS_PATH, 'application/javascript');
      return true; // Request handled
    }

    // Route: GET /viewer/sw.js - serve Service Worker (alternative path)
    if (pathname === '/viewer/sw.js' && req.method === 'GET') {
      serveStaticFile(res, SW_JS_PATH, 'application/javascript');
      return true; // Request handled
    }

    // Route: GET /viewer/manifest.json - serve PWA manifest
    if (pathname === '/viewer/manifest.json' && req.method === 'GET') {
      serveStaticFile(res, MANIFEST_JSON_PATH, 'application/json');
      return true; // Request handled
    }

    // Route: GET /viewer/icons/*.png - serve PWA icons
    if (
      pathname.startsWith('/viewer/icons/') &&
      pathname.endsWith('.png') &&
      req.method === 'GET'
    ) {
      const fileName = pathname.split('/').pop();
      const filePath = path.join(__dirname, '../../public/viewer/icons', fileName);
      serveStaticFile(res, filePath, 'image/png');
      return true; // Request handled
    }

    // Route: GET /viewer/icons/*.svg - serve SVG icons
    if (
      pathname.startsWith('/viewer/icons/') &&
      pathname.endsWith('.svg') &&
      req.method === 'GET'
    ) {
      const fileName = pathname.split('/').pop();
      const filePath = path.join(__dirname, '../../public/viewer/icons', fileName);
      serveStaticFile(res, filePath, 'image/svg+xml');
      return true; // Request handled
    }

    // Route: GET /viewer/js/utils/*.js - serve utility modules
    if (
      pathname.startsWith('/viewer/js/utils/') &&
      pathname.endsWith('.js') &&
      req.method === 'GET'
    ) {
      const fileName = pathname.split('/').pop();
      const filePath = path.join(VIEWER_DIR, 'js', 'utils', fileName);
      serveStaticFile(res, filePath, 'application/javascript');
      return true; // Request handled
    }

    // Route: GET /viewer/js/modules/*.js - serve feature modules
    if (
      pathname.startsWith('/viewer/js/modules/') &&
      pathname.endsWith('.js') &&
      req.method === 'GET'
    ) {
      const fileName = pathname.split('/').pop();
      const filePath = path.join(VIEWER_DIR, 'js', 'modules', fileName);
      serveStaticFile(res, filePath, 'application/javascript');
      return true; // Request handled
    }

    // Route: GET /js/utils/*.js - serve utility modules (legacy path)
    if (pathname.startsWith('/js/utils/') && pathname.endsWith('.js') && req.method === 'GET') {
      const fileName = pathname.split('/').pop();
      const filePath = path.join(VIEWER_DIR, 'js', 'utils', fileName);
      serveStaticFile(res, filePath, 'application/javascript');
      return true; // Request handled
    }

    // Route: GET /js/modules/*.js - serve feature modules (legacy path)
    if (pathname.startsWith('/js/modules/') && pathname.endsWith('.js') && req.method === 'GET') {
      const fileName = pathname.split('/').pop();
      const filePath = path.join(VIEWER_DIR, 'js', 'modules', fileName);
      serveStaticFile(res, filePath, 'application/javascript');
      return true; // Request handled
    }

    // Route: GET /graph/similar - find similar decisions (check before /graph)
    if (pathname === '/graph/similar' && req.method === 'GET') {
      console.log('[GraphHandler] Routing to handleSimilarRequest');
      await handleSimilarRequest(req, res, params);
      return true; // Request handled
    }

    // Route: POST /graph/update - update decision outcome (Story 3.3)
    if (pathname === '/graph/update' && req.method === 'POST') {
      await handleUpdateRequest(req, res);
      return true; // Request handled
    }

    // Route: GET /graph - API endpoint
    if (pathname === '/graph' && req.method === 'GET') {
      await handleGraphRequest(req, res, params);
      return true;
    }

    // Alias: GET /api/graph → /graph
    if (pathname === '/api/graph' && req.method === 'GET') {
      await handleGraphRequest(req, res, params);
      return true;
    }

    // Route: GET /checkpoints - list all checkpoints
    if (pathname === '/checkpoints' && req.method === 'GET') {
      await handleCheckpointsRequest(req, res);
      return true;
    }

    // Alias: GET /api/checkpoints → /checkpoints
    if (pathname === '/api/checkpoints' && req.method === 'GET') {
      await handleCheckpointsRequest(req, res);
      return true;
    }

    // Route: GET /api/mama/search - semantic search for decisions (Story 4-1)
    if (pathname === '/api/mama/search' && req.method === 'GET') {
      await handleMamaSearchRequest(req, res, params);
      return true;
    }

    // Alias: GET /api/search → /api/mama/search (with query param conversion)
    if (pathname === '/api/search' && req.method === 'GET') {
      const query = params.get('query');
      if (query) {
        params.set('q', query);
      }
      await handleMamaSearchRequest(req, res, params);
      return true;
    }

    // Route: POST /api/mama/save - save a new decision (Story 4-2)
    if (pathname === '/api/mama/save' && req.method === 'POST') {
      await handleMamaSaveRequest(req, res);
      return true;
    }

    // Alias: POST /api/save → /api/mama/save
    if (pathname === '/api/save' && req.method === 'POST') {
      await handleMamaSaveRequest(req, res);
      return true;
    }

    // Alias: POST /api/update → /graph/update
    if (pathname === '/api/update' && req.method === 'POST') {
      await handleUpdateRequest(req, res);
      return true;
    }

    // Route: POST /api/checkpoint/save - save session checkpoint (Story 4-3)
    if (pathname === '/api/checkpoint/save' && req.method === 'POST') {
      await handleCheckpointSaveRequest(req, res);
      return true;
    }

    // Route: GET /api/checkpoint/load - load latest checkpoint (Story 4-3)
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

    // Route: GET /api/dashboard/status - dashboard status (Phase 4)
    if (pathname === '/api/dashboard/status' && req.method === 'GET') {
      await handleDashboardStatusRequest(req, res);
      return true;
    }

    // Route: GET /api/config - get current config (Phase 5)
    if (pathname === '/api/config' && req.method === 'GET') {
      await handleGetConfigRequest(req, res);
      return true;
    }

    // Route: PUT /api/config - update config (Phase 5)
    if (pathname === '/api/config' && req.method === 'PUT') {
      await handleUpdateConfigRequest(req, res);
      return true;
    }

    // Route: GET /api/memory/export - export decisions (Phase 6)
    if (pathname === '/api/memory/export' && req.method === 'GET') {
      await handleExportRequest(req, res, params);
      return true;
    }

    return false; // Request not handled
  };
}

/**
 * Handle GET /api/dashboard/status - get system status for dashboard
 * Phase 4: Simplified config-based status (no process monitoring)
 *
 * @param {Object} req - HTTP request
 * @param {Object} res - HTTP response
 */
async function handleDashboardStatusRequest(req, res) {
  try {
    // Load config
    const config = loadMAMAConfig();

    // Get memory stats from database
    await initDB();
    const memoryStats = await getMemoryStats();

    // Build gateway status from config (simplified: config exists = configured)
    const gateways = {
      discord: {
        configured: !!config.discord?.token,
        enabled: config.discord?.enabled ?? false,
      },
      slack: {
        configured: !!config.slack?.bot_token,
        enabled: config.slack?.enabled ?? false,
      },
      telegram: {
        configured: !!config.telegram?.token,
        enabled: config.telegram?.enabled ?? false,
      },
      chatwork: {
        configured: !!config.chatwork?.api_token,
        enabled: config.chatwork?.enabled ?? false,
      },
    };

    // Heartbeat status
    const heartbeat = {
      enabled: config.heartbeat?.enabled ?? false,
      interval: config.heartbeat?.interval ?? 1800000,
      quietStart: config.heartbeat?.quiet_start ?? 23,
      quietEnd: config.heartbeat?.quiet_end ?? 8,
    };

    // Agent config
    const agent = {
      model: config.agent?.model ?? 'claude-sonnet-4-20250514',
      maxTurns: config.agent?.max_turns ?? 10,
      timeout: config.agent?.timeout ?? 300000,
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        timestamp: new Date().toISOString(),
        gateways,
        heartbeat,
        agent,
        memory: memoryStats,
        database: {
          path: config.database?.path ?? '~/.claude/mama-memory.db',
        },
      })
    );
  } catch (error) {
    console.error(`[GraphAPI] Dashboard status error: ${error.message}`);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: true,
        code: 'DASHBOARD_ERROR',
        message: error.message,
      })
    );
  }
}

/**
 * Load MAMA config from ~/.mama/config.yaml
 * Returns empty object if file doesn't exist
 */
function loadMAMAConfig() {
  try {
    if (!fs.existsSync(MAMA_CONFIG_PATH)) {
      console.log('[GraphAPI] Config file not found:', MAMA_CONFIG_PATH);
      return {};
    }
    const content = fs.readFileSync(MAMA_CONFIG_PATH, 'utf8');
    return yaml.load(content) || {};
  } catch (error) {
    console.error('[GraphAPI] Config load error:', error.message);
    return {};
  }
}

/**
 * Get memory statistics from database
 */
async function getMemoryStats() {
  try {
    const adapter = getAdapter();

    const now = Date.now();
    const weekAgo = now - 7 * 24 * 60 * 60 * 1000;
    const monthAgo = now - 30 * 24 * 60 * 60 * 1000;

    // Total decisions
    const totalResult = adapter.prepare('SELECT COUNT(*) as count FROM decisions').get();
    const total = totalResult?.count ?? 0;

    // This week
    const weekResult = adapter
      .prepare('SELECT COUNT(*) as count FROM decisions WHERE created_at > ?')
      .get(weekAgo);
    const thisWeek = weekResult?.count ?? 0;

    // This month
    const monthResult = adapter
      .prepare('SELECT COUNT(*) as count FROM decisions WHERE created_at > ?')
      .get(monthAgo);
    const thisMonth = monthResult?.count ?? 0;

    // Outcomes
    const outcomeResults = adapter
      .prepare(
        `
      SELECT outcome, COUNT(*) as count
      FROM decisions
      WHERE outcome IS NOT NULL
      GROUP BY outcome
    `
      )
      .all();

    const outcomes = {};
    for (const row of outcomeResults) {
      outcomes[row.outcome?.toLowerCase() ?? 'unknown'] = row.count;
    }

    // Top topics
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
      .all();

    // Total checkpoints
    const checkpointResult = adapter.prepare('SELECT COUNT(*) as count FROM checkpoints').get();
    const checkpoints = checkpointResult?.count ?? 0;

    return {
      total,
      thisWeek,
      thisMonth,
      checkpoints,
      outcomes,
      topTopics: topicResults,
    };
  } catch (error) {
    console.error('[GraphAPI] Memory stats error:', error.message);
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

/**
 * Handle GET /api/config - get current configuration
 * Phase 5: Settings Management
 */
async function handleGetConfigRequest(req, res) {
  try {
    const config = loadMAMAConfig();

    // Mask sensitive tokens (show only last 4 chars)
    const maskedConfig = {
      version: config.version || 1,
      agent: {
        ...(config.agent || {}),
        // Expose tools config for transparency (no black box)
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
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(maskedConfig));
  } catch (error) {
    console.error('[GraphAPI] Get config error:', error.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: true,
        code: 'CONFIG_ERROR',
        message: error.message,
      })
    );
  }
}

/**
 * Handle PUT /api/config - update configuration
 * Phase 5: Settings Management
 */
async function handleUpdateConfigRequest(req, res) {
  try {
    const body = await readBody(req);

    // Load current config
    const currentConfig = loadMAMAConfig();

    // Merge updates (preserve existing tokens if masked value sent)
    const updatedConfig = mergeConfigUpdates(currentConfig, body);

    // Validate
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

    // Save config
    saveMAMAConfig(updatedConfig);

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        success: true,
        message: 'Configuration saved successfully',
      })
    );
  } catch (error) {
    console.error('[GraphAPI] Update config error:', error.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: true,
        code: 'CONFIG_ERROR',
        message: error.message,
      })
    );
  }
}

/**
 * Mask a token to show only last 4 characters
 */
function maskToken(token) {
  if (!token || token.length < 8) {
    return '****';
  }
  return '****' + token.slice(-4);
}

/**
 * Merge config updates, preserving existing tokens if masked value sent
 */
function mergeConfigUpdates(current, updates) {
  const merged = { ...current };

  // Agent config
  if (updates.agent) {
    merged.agent = {
      ...current.agent,
      ...updates.agent,
    };
  }

  // Heartbeat config
  if (updates.heartbeat) {
    merged.heartbeat = {
      ...current.heartbeat,
      ...updates.heartbeat,
    };
  }

  // Discord config
  if (updates.discord) {
    merged.discord = {
      ...current.discord,
      enabled: updates.discord.enabled,
      default_channel_id: updates.discord.default_channel_id || current.discord?.default_channel_id,
    };
    // Only update token if not masked
    if (updates.discord.token && !updates.discord.token.startsWith('****')) {
      merged.discord.token = updates.discord.token;
    }
  }

  // Slack config
  if (updates.slack) {
    merged.slack = {
      ...current.slack,
      enabled: updates.slack.enabled,
    };
    if (updates.slack.bot_token && !updates.slack.bot_token.startsWith('****')) {
      merged.slack.bot_token = updates.slack.bot_token;
    }
    if (updates.slack.app_token && !updates.slack.app_token.startsWith('****')) {
      merged.slack.app_token = updates.slack.app_token;
    }
  }

  // Telegram config
  if (updates.telegram) {
    merged.telegram = {
      ...current.telegram,
      enabled: updates.telegram.enabled,
    };
    if (updates.telegram.token && !updates.telegram.token.startsWith('****')) {
      merged.telegram.token = updates.telegram.token;
    }
  }

  // Chatwork config
  if (updates.chatwork) {
    merged.chatwork = {
      ...current.chatwork,
      enabled: updates.chatwork.enabled,
    };
    if (updates.chatwork.api_token && !updates.chatwork.api_token.startsWith('****')) {
      merged.chatwork.api_token = updates.chatwork.api_token;
    }
  }

  return merged;
}

/**
 * Validate config update
 */
function validateConfigUpdate(config) {
  const errors = [];

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

  return errors;
}

/**
 * Save MAMA config to ~/.mama/config.yaml
 */
function saveMAMAConfig(config) {
  const configDir = path.dirname(MAMA_CONFIG_PATH);

  // Ensure directory exists
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

/**
 * Handle GET /api/memory/export - export decisions
 * Phase 6: Memory Analytics
 * Supports formats: json, markdown, csv
 */
async function handleExportRequest(req, res, params) {
  try {
    const format = params.get('format') || 'json';

    // Ensure DB is initialized
    await initDB();

    // Get all decisions
    const decisions = await getAllNodes();

    let content, contentType, filename;

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
  } catch (error) {
    console.error('[GraphAPI] Export error:', error.message);
    res.writeHead(500, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        error: true,
        code: 'EXPORT_ERROR',
        message: error.message,
      })
    );
  }
}

/**
 * Export decisions to Markdown format
 */
function exportToMarkdown(decisions) {
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

/**
 * Export decisions to CSV format
 */
function exportToCSV(decisions) {
  const escapeCSV = (str) => {
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

module.exports = {
  createGraphHandler,
  // Exported for testing
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
