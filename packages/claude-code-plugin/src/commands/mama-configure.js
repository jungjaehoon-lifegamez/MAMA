/**
 * /mama-configure Command
 *
 * Story M3.1: MAMA Commands Suite
 * Manage MAMA configuration, tier status, and embedding model selection
 *
 * Usage:
 *   mamaConfigureCommand({ show, model, dimension, cacheDir })
 *
 * @module commands/mama-configure
 */

const { loadConfig, updateConfig, getConfigPath } = require('../core/config-loader');
const { info, warn, error: logError } = require('../core/debug-logger');
const { getDB } = require('../core/memory-store');

/**
 * Detect current tier status
 *
 * @returns {Object} Tier information
 */
function detectTier() {
  try {
    const config = loadConfig();
    const db = getDB();

    // Tier 1: Full functionality (embeddings + database)
    if (config && db) {
      return {
        tier: 1,
        status: 'Full functionality',
        features: {
          vectorSearch: true,
          graphTraversal: true,
          keywordFallback: true,
          semanticSimilarity: true,
        },
      };
    }

    // Tier 2: Database only (no embeddings)
    if (db) {
      return {
        tier: 2,
        status: 'Degraded - embeddings unavailable',
        features: {
          vectorSearch: false,
          graphTraversal: true,
          keywordFallback: true,
          semanticSimilarity: false,
        },
        fixInstructions: [
          'Install Transformers.js: npm install @xenova/transformers',
          'Configure model in ~/.mama/config.json',
          'Restart Claude Code to reload configuration',
        ],
      };
    }

    // Tier 3: Fully disabled
    return {
      tier: 3,
      status: 'Disabled - database unavailable',
      features: {
        vectorSearch: false,
        graphTraversal: false,
        keywordFallback: false,
        semanticSimilarity: false,
      },
      fixInstructions: [
        'Check database file exists: ~/.mama/mama-memory.db',
        'Verify file permissions',
        'Restart Claude Code',
      ],
    };
  } catch (err) {
    warn(`[mama-configure] Failed to detect tier: ${err.message}`);
    return {
      tier: 3,
      status: 'Error detecting tier',
      error: err.message,
    };
  }
}

/**
 * Display current MAMA configuration
 *
 * @returns {Object} Current configuration with tier status
 */
function showConfig() {
  const config = loadConfig();
  const configPath = getConfigPath();
  const tierInfo = detectTier();

  info('[mama-configure] Current MAMA Configuration:');
  info(`[mama-configure] Config file: ${configPath}`);
  info(`[mama-configure] Model: ${config.modelName}`);
  info(`[mama-configure] Embedding dimension: ${config.embeddingDim}`);
  info(`[mama-configure] Cache directory: ${config.cacheDir}`);
  info(`[mama-configure] Tier: ${tierInfo.tier} - ${tierInfo.status}`);

  return {
    config,
    configPath,
    tier: tierInfo,
  };
}

/**
 * Update MAMA configuration
 *
 * @param {Object} updates - Configuration updates
 * @param {string} updates.modelName - New model name
 * @param {number} updates.embeddingDim - New embedding dimension
 * @param {string} updates.cacheDir - New cache directory
 * @returns {boolean} Success status
 */
function configureModel(updates) {
  info('[mama-configure] Updating MAMA configuration...');

  const success = updateConfig(updates);

  if (success) {
    info('[mama-configure] ✅ Configuration updated successfully');
    showConfig();
  } else {
    logError('[mama-configure] ❌ Failed to update configuration');
  }

  return success;
}

/**
 * Get supported models list
 *
 * @returns {Array} Supported models with metadata
 */
function getSupportedModels() {
  return [
    {
      name: 'Xenova/multilingual-e5-small',
      dimension: 384,
      size: '~120MB',
      languages: ['English', 'Korean', 'Japanese', 'Chinese', '100+ languages'],
      recommended: true,
      description: 'Default model - balanced accuracy and performance',
    },
    {
      name: 'Xenova/all-MiniLM-L6-v2',
      dimension: 384,
      size: '~90MB',
      languages: ['English'],
      recommended: false,
      description: 'Smaller, faster, English-only',
    },
    {
      name: 'Xenova/all-mpnet-base-v2',
      dimension: 768,
      size: '~420MB',
      languages: ['English'],
      recommended: false,
      description: 'Highest accuracy, larger size, English-only',
    },
  ];
}

/**
 * MAMA Configure command
 *
 * @param {Object} args - Command arguments
 * @param {boolean} [args.show] - Show current configuration
 * @param {string} [args.model] - Model name to set
 * @param {number} [args.dimension] - Embedding dimension
 * @param {string} [args.cacheDir] - Cache directory
 * @param {boolean} [args.listModels] - List supported models
 * @returns {Promise<Object>} Command result
 */
async function mamaConfigureCommand(args = {}) {
  try {
    // List supported models
    if (args.listModels) {
      const models = getSupportedModels();
      return {
        success: true,
        models,
        message: formatModelsMessage(models),
      };
    }

    // Show current configuration (default)
    if (args.show || Object.keys(args).length === 0) {
      const { config, configPath, tier } = showConfig();
      return {
        success: true,
        config,
        configPath,
        tier,
        message: formatConfigMessage(config, configPath, tier),
      };
    }

    // Update configuration
    if (args.model || args.dimension || args.cacheDir) {
      const updates = {};

      if (args.model) {
        // Validate model name
        const supported = getSupportedModels();
        const isValid = supported.some((m) => m.name === args.model);

        if (!isValid) {
          warn(`[mama-configure] Model ${args.model} not in recommended list`);
          info('[mama-configure] Tip: Use --listModels to see supported models');
        }

        updates.modelName = args.model;
      }

      if (args.dimension) {
        updates.embeddingDim = parseInt(args.dimension, 10);
      }

      if (args.cacheDir) {
        updates.cacheDir = args.cacheDir;
      }

      const success = configureModel(updates);

      if (success) {
        const { config, configPath, tier } = showConfig();
        return {
          success: true,
          config,
          message: formatUpdateSuccessMessage(updates, config, tier),
        };
      } else {
        return {
          success: false,
          message: formatUpdateErrorMessage(),
        };
      }
    }

    // No valid arguments
    return {
      success: false,
      message: formatUsageHelp(),
    };
  } catch (err) {
    logError(`[mama-configure] ❌ Failed to configure MAMA: ${err.message}`);

    return {
      success: false,
      error: err.message,
      message: formatErrorMessage(err),
    };
  }
}

/**
 * Format configuration message
 *
 * @param {Object} config - Configuration
 * @param {string} configPath - Config file path
 * @param {Object} tier - Tier information
 * @returns {string} Formatted message
 */
function formatConfigMessage(config, configPath, tier) {
  const tierBadge = {
    1: '🟢 Tier 1',
    2: '🟡 Tier 2',
    3: '🔴 Tier 3',
  }[tier.tier] || '⚪ Unknown';

  let message = `## ⚙️ MAMA Configuration\n\n`;
  message += `**Config File:** \`${configPath}\`\n\n`;
  message += `### Embedding Model\n\n`;
  message += `- **Model:** \`${config.modelName}\`\n`;
  message += `- **Dimension:** ${config.embeddingDim}\n`;
  message += `- **Cache:** \`${config.cacheDir}\`\n\n`;
  message += `### Tier Status\n\n`;
  message += `**${tierBadge}** - ${tier.status}\n\n`;

  if (tier.features) {
    message += `**Features:**\n`;
    message += `- Vector Search: ${tier.features.vectorSearch ? '✅' : '❌'}\n`;
    message += `- Graph Traversal: ${tier.features.graphTraversal ? '✅' : '❌'}\n`;
    message += `- Keyword Fallback: ${tier.features.keywordFallback ? '✅' : '❌'}\n`;
    message += `- Semantic Similarity: ${tier.features.semanticSimilarity ? '✅' : '❌'}\n\n`;
  }

  if (tier.tier > 1 && tier.fixInstructions) {
    message += `### ⚠️ How to Fix\n\n`;
    tier.fixInstructions.forEach((instruction, i) => {
      message += `${i + 1}. ${instruction}\n`;
    });
    message += `\n`;
  }

  message += `### Quick Actions\n\n`;
  message += `- List models: \`/mama-configure --listModels\`\n`;
  message += `- Change model: \`/mama-configure --model MODEL_NAME\`\n`;
  message += `- Help: \`/mama-configure --help\`\n`;

  return message.trim();
}

/**
 * Format models message
 *
 * @param {Array} models - Supported models
 * @returns {string} Formatted message
 */
function formatModelsMessage(models) {
  let message = `## 🎯 Supported Embedding Models\n\n`;

  models.forEach((model, index) => {
    message += `### ${index + 1}. ${model.name}`;
    if (model.recommended) {
      message += ` ⭐ **Recommended**`;
    }
    message += `\n\n`;
    message += `- **Dimension:** ${model.dimension}\n`;
    message += `- **Size:** ${model.size}\n`;
    message += `- **Languages:** ${model.languages.join(', ')}\n`;
    message += `- **Description:** ${model.description}\n\n`;
    message += `**Set as active:**\n`;
    message += `\`\`\`\nmamaConfigureCommand({ model: '${model.name}' })\n\`\`\`\n\n`;
    message += `---\n\n`;
  });

  message += `### Notes\n\n`;
  message += `1. Model download happens automatically on first use\n`;
  message += `2. Models are cached in \`~/.mama/cache/\`\n`;
  message += `3. After changing model, restart Claude Code\n`;

  return message.trim();
}

/**
 * Format update success message
 *
 * @param {Object} updates - Updates applied
 * @param {Object} config - New configuration
 * @param {Object} tier - Tier information
 * @returns {string} Formatted message
 */
function formatUpdateSuccessMessage(updates, config, tier) {
  let message = `## ✅ Configuration Updated\n\n`;

  if (updates.modelName) {
    message += `**Model changed to:** \`${config.modelName}\`\n`;
  }

  if (updates.embeddingDim) {
    message += `**Dimension changed to:** ${config.embeddingDim}\n`;
  }

  if (updates.cacheDir) {
    message += `**Cache directory changed to:** \`${config.cacheDir}\`\n`;
  }

  message += `\n⚠️ **Restart Claude Code** to apply changes\n\n`;
  message += `**New Tier:** ${tier.tier} - ${tier.status}\n`;

  return message.trim();
}

/**
 * Format update error message
 *
 * @returns {string} Formatted message
 */
function formatUpdateErrorMessage() {
  return `
## ❌ Configuration Update Failed

Failed to update MAMA configuration. Possible causes:

1. Config file is read-only
2. Invalid model name or dimension
3. Cache directory doesn't exist

Check logs for details and try again.
`.trim();
}

/**
 * Format error message
 *
 * @param {Error} err - Error object
 * @returns {string} Formatted message
 */
function formatErrorMessage(err) {
  return `
## ❌ Configuration Error

${err.message}

See usage help: \`/mama-configure --help\`
`.trim();
}

/**
 * Format usage help
 *
 * @returns {string} Help text
 */
function formatUsageHelp() {
  return `
## /mama-configure - Manage MAMA Configuration

View and update MAMA configuration, check tier status, and switch embedding models.

### Usage

\`\`\`javascript
mamaConfigureCommand({
  show: true,  // Show current config (default)
  listModels: true,  // List supported models
  model: 'MODEL_NAME',  // Change embedding model
  dimension: 384,  // Change embedding dimension
  cacheDir: '/path/to/cache'  // Change cache directory
})
\`\`\`

### Examples

\`\`\`javascript
// Show current configuration (default)
mamaConfigureCommand()
mamaConfigureCommand({ show: true })

// List supported models
mamaConfigureCommand({ listModels: true })

// Change embedding model
mamaConfigureCommand({ model: 'Xenova/multilingual-e5-small' })

// Change multiple settings
mamaConfigureCommand({
  model: 'Xenova/all-MiniLM-L6-v2',
  dimension: 384
})
\`\`\`

### Tier System

MAMA operates in three tiers:

- **Tier 1 (🟢)**: Full functionality
  - Vector search enabled
  - Semantic similarity working
  - Graph traversal enabled
  - Best user experience

- **Tier 2 (🟡)**: Degraded mode
  - Vector search disabled
  - Keyword fallback only
  - Graph traversal enabled
  - ~30% less accurate

- **Tier 3 (🔴)**: Disabled
  - All features disabled
  - MAMA not functional
  - Fix required

### Supported Models

See full list: \`/mama-configure --listModels\`

Default: **Xenova/multilingual-e5-small**
- 384 dimensions
- ~120MB download
- Supports 100+ languages
- Balanced accuracy/performance

### Important Notes

1. **Restart required**: Changes take effect after Claude Code restart
2. **Model download**: First use downloads model (~120MB)
3. **Cache location**: Models cached in \`~/.mama/cache/\`
4. **Tier detection**: Automatic on startup

### Related Commands

- \`/mama-save\` - Save a decision
- \`/mama-suggest\` - Semantic search (requires Tier 1)
- \`/mama-list\` - List recent decisions
`.trim();
}

module.exports = {
  mamaConfigureCommand,
  showConfig,
  configureModel,
  detectTier,
  getSupportedModels,
  formatConfigMessage,
  formatModelsMessage,
  formatUsageHelp,
};
