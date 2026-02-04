/**
 * MAMA MCP Client
 *
 * Direct stdio communication with MAMA MCP server
 * for hook-based contract saving.
 *
 * No session token needed - uses stdio transport.
 */

const { spawn } = require('child_process');

/**
 * Call MAMA MCP tool via stdio
 *
 * @param {string} toolName - Tool name (save, search, update, load_checkpoint)
 * @param {Object} params - Tool parameters
 * @param {number} timeout - Timeout in ms (default: 5000)
 * @returns {Promise<Object>} Tool result
 */
async function callMamaTool(toolName, params, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const timeoutId = setTimeout(() => {
      mcp.kill();
      reject(new Error(`MCP call timeout after ${timeout}ms`));
    }, timeout);

    // Spawn MAMA MCP server
    const mcp = spawn('npx', ['-y', '@jungjaehoon/mama-server'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });

    let stdout = '';
    let stderr = '';

    mcp.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    mcp.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    // MCP protocol: Initialize
    const initMessage = {
      jsonrpc: '2.0',
      id: 1,
      method: 'initialize',
      params: {
        protocolVersion: '2024-11-05',
        capabilities: {},
        clientInfo: {
          name: 'mama-hook',
          version: '1.0.0',
        },
      },
    };

    mcp.stdin.write(JSON.stringify(initMessage) + '\n');

    // Wait a bit for init (reduce to 200ms for speed)
    setTimeout(() => {
      // MCP protocol: Call tool
      const toolCallMessage = {
        jsonrpc: '2.0',
        id: 2,
        method: 'tools/call',
        params: {
          name: toolName,
          arguments: params,
        },
      };

      mcp.stdin.write(JSON.stringify(toolCallMessage) + '\n');
      mcp.stdin.end();
    }, 200);

    mcp.on('close', (code) => {
      clearTimeout(timeoutId);

      if (code !== 0 && code !== null) {
        reject(new Error(`MCP exited with code ${code}: ${stderr}`));
        return;
      }

      // Parse responses
      const lines = stdout.split('\n').filter((line) => line.trim());
      const responses = lines
        .map((line) => {
          try {
            return JSON.parse(line);
          } catch (err) {
            return null;
          }
        })
        .filter((r) => r !== null);

      // Find tool call response (id: 2)
      const toolResponse = responses.find((r) => r.id === 2);

      if (!toolResponse) {
        reject(new Error('No tool response received from MCP'));
        return;
      }

      if (toolResponse.error) {
        reject(new Error(`MCP error: ${toolResponse.error.message}`));
        return;
      }

      // Extract result from content array
      if (toolResponse.result && toolResponse.result.content) {
        const content = toolResponse.result.content[0];
        if (content && content.type === 'text') {
          try {
            const result = JSON.parse(content.text);
            resolve(result);
          } catch (err) {
            resolve({ raw: content.text });
          }
        } else {
          resolve(toolResponse.result);
        }
      } else {
        resolve(toolResponse.result);
      }
    });

    mcp.on('error', (err) => {
      clearTimeout(timeoutId);
      reject(new Error(`MCP spawn failed: ${err.message}`));
    });
  });
}

/**
 * Save decision to MAMA
 *
 * @param {Object} decision - Decision data
 * @returns {Promise<Object>} Save result
 */
async function saveDecision(decision) {
  return callMamaTool('save', {
    type: 'decision',
    ...decision,
  });
}

/**
 * Search MAMA decisions
 *
 * @param {string} query - Search query
 * @param {number} limit - Max results (default: 5)
 * @returns {Promise<Object>} Search results
 */
async function searchDecisions(query, limit = 5) {
  return callMamaTool('search', {
    query,
    limit,
  });
}

/**
 * Batch save multiple contracts
 *
 * Saves contracts sequentially to avoid overwhelming MCP server.
 * Only saves high-confidence contracts (>= 0.7).
 *
 * @param {Array<Object>} contracts - Array of contracts to save
 * @returns {Promise<Object>} Batch save results
 */
async function batchSaveContracts(contracts) {
  const results = {
    saved: [],
    skipped: [],
    errors: [],
  };

  // Filter high-confidence contracts
  const highConfidence = contracts.filter((c) => c.confidence >= 0.7);
  const lowConfidence = contracts.filter((c) => c.confidence < 0.7);

  results.skipped = lowConfidence.map((c) => ({
    ...c,
    reason: 'Low confidence (<0.7)',
  }));

  // Save sequentially (to avoid race conditions)
  for (const contract of highConfidence) {
    try {
      const result = await saveDecision(contract);
      results.saved.push({
        contract,
        result,
      });
    } catch (error) {
      results.errors.push({
        contract,
        error: error.message,
      });
    }
  }

  return results;
}

module.exports = {
  callMamaTool,
  saveDecision,
  searchDecisions,
  batchSaveContracts,
};
