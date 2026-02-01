/**
 * MAMA Core - Main exports
 *
 * Shared modules for Memory-Augmented MCP Assistant.
 * Used by mcp-server, claude-code-plugin, and standalone packages.
 *
 * @module mama-core
 * @version 1.0.0
 */

const embeddings = require('./embeddings');
const embeddingCache = require('./embedding-cache');
const embeddingClient = require('./embedding-client');

const dbManager = require('./db-manager');
const dbAdapter = require('./db-adapter');
const memoryStore = require('./memory-store');

const mamaApi = require('./mama-api');
const configLoader = require('./config-loader');
const relevanceScorer = require('./relevance-scorer');
const decisionTracker = require('./decision-tracker');
const tierValidator = require('./tier-validator');
const progressIndicator = require('./progress-indicator');

module.exports = {
  ...embeddings,
  embeddingCache,
  ...embeddingClient,

  ...dbManager,
  ...dbAdapter,
  ...memoryStore,

  ...mamaApi,
  ...configLoader,
  ...relevanceScorer,
  ...decisionTracker,
  ...tierValidator,
  ...progressIndicator,
};
