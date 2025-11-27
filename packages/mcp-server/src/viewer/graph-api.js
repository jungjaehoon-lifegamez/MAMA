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
const { getAdapter, initDB, vectorSearch } = require('../mama/memory-store');
const { generateEmbedding } = require('../mama/embeddings');
const mama = require('../mama/mama-api.js');

// Paths to viewer files
const VIEWER_HTML_PATH = path.join(__dirname, 'viewer.html');
const VIEWER_CSS_PATH = path.join(__dirname, 'viewer.css');
const VIEWER_JS_PATH = path.join(__dirname, 'viewer.js');

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
    const content = fs.readFileSync(filePath, 'utf8');
    res.writeHead(200, {
      'Content-Type': `${contentType}; charset=utf-8`,
      'Cache-Control': 'public, max-age=3600', // Cache for 1 hour
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
  try {
    const decisionId = params.get('id');
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
    await initDB();

    // Get the decision by ID
    const adapter = getAdapter();
    const stmt = adapter.prepare(`
      SELECT topic, decision, reasoning FROM decisions WHERE id = ?
    `);
    const decision = stmt.get(decisionId);

    if (!decision) {
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

    // Use mama.suggest for semantic search
    const results = await mama.suggest(searchQuery, {
      limit: 6, // Get 6 to filter out self
      threshold: 0.5,
    });

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

    res.writeHead(200);
    res.end(
      JSON.stringify({
        id: decisionId,
        similar,
        count: similar.length,
      })
    );
  } catch (error) {
    console.error(`[GraphAPI] Similar error: ${error.message}`);
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

    // Route: GET /viewer - serve HTML viewer
    if (pathname === '/viewer' && req.method === 'GET') {
      handleViewerRequest(req, res);
      return true; // Request handled
    }

    // Route: GET /viewer.css - serve stylesheet
    if (pathname === '/viewer.css' && req.method === 'GET') {
      handleCssRequest(req, res);
      return true; // Request handled
    }

    // Route: GET /viewer.js - serve JavaScript
    if (pathname === '/viewer.js' && req.method === 'GET') {
      handleJsRequest(req, res);
      return true; // Request handled
    }

    // Route: GET /graph - API endpoint
    if (pathname === '/graph' && req.method === 'GET') {
      await handleGraphRequest(req, res, params);
      return true; // Request handled
    }

    // Route: POST /graph/update - update decision outcome (Story 3.3)
    if (pathname === '/graph/update' && req.method === 'POST') {
      await handleUpdateRequest(req, res);
      return true; // Request handled
    }

    // Route: GET /graph/similar - find similar decisions
    if (pathname === '/graph/similar' && req.method === 'GET') {
      await handleSimilarRequest(req, res, params);
      return true; // Request handled
    }

    return false; // Request not handled
  };
}

module.exports = {
  createGraphHandler,
  // Exported for testing
  getAllNodes,
  getAllEdges,
  getUniqueTopics,
  filterNodesByTopic,
  filterEdgesByNodes,
  VIEWER_HTML_PATH,
  VIEWER_CSS_PATH,
  VIEWER_JS_PATH,
};
