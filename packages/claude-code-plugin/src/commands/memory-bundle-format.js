const { sanitizeForPrompt } = require('../core/prompt-sanitizer');

function hasBundleMemories(bundle) {
  return Boolean(bundle && Array.isArray(bundle.memories) && bundle.memories.length > 0);
}

function buildSuggestionsFromBundle(bundle, limit = 5) {
  if (!hasBundleMemories(bundle)) {
    return [];
  }

  return bundle.memories.slice(0, limit).map((memory) => ({
    id: memory.id,
    topic: memory.topic,
    decision: memory.summary,
    reasoning: memory.details,
    confidence: memory.confidence,
    similarity: 1,
    created_at: memory.created_at,
  }));
}

function pushRecordList(lines, items, formatter) {
  if (!Array.isArray(items) || items.length === 0) {
    lines.push('- None');
    return;
  }

  for (const item of items) {
    lines.push(formatter(item));
  }
}

function formatMemoryBundleMessage({ title, query, bundle, suggestions = [] }) {
  const profile = bundle?.profile || { static: [], dynamic: [], evidence: [] };
  const graphContext = bundle?.graph_context || { primary: [], expanded: [], edges: [] };
  const searchMeta = bundle?.search_meta || { retrieval_sources: [], scope_order: [] };
  const lines = [`## ${title}`, '', `Query: \`${sanitizeForPrompt(query)}\``];

  if (Array.isArray(searchMeta.retrieval_sources) && searchMeta.retrieval_sources.length > 0) {
    lines.push(`Sources: ${searchMeta.retrieval_sources.join(', ')}`);
  }
  if (Array.isArray(searchMeta.scope_order) && searchMeta.scope_order.length > 0) {
    lines.push(`Scopes: ${searchMeta.scope_order.join(' → ')}`);
  }

  lines.push('', '### MAMA Profile', '', '#### Static Profile');
  pushRecordList(
    lines,
    profile.static,
    (item) => `- ${sanitizeForPrompt(item.summary || item.topic)}`
  );

  lines.push('', '#### Dynamic Profile');
  pushRecordList(
    lines,
    profile.dynamic,
    (item) => `- ${sanitizeForPrompt(item.summary || item.topic)}`
  );

  lines.push('', '#### Evidence');
  pushRecordList(
    lines,
    profile.evidence,
    (item) =>
      `- ${sanitizeForPrompt(item.topic || item.memory_id || 'memory')}: ${sanitizeForPrompt(item.why_included || 'included in profile')}`
  );

  lines.push('', '### Related Memories');
  if (!hasBundleMemories(bundle)) {
    lines.push('- None');
  } else {
    bundle.memories.forEach((memory, index) => {
      lines.push(
        `${index + 1}. [${sanitizeForPrompt(memory.topic)}] ${sanitizeForPrompt(memory.summary || memory.details || 'Memory')}`
      );
      if (memory.details) {
        lines.push(`   ${sanitizeForPrompt(memory.details)}`);
      }
    });
  }

  lines.push('', '### Graph Context');
  lines.push(`- Primary: ${graphContext.primary?.length || 0}`);
  lines.push(`- Expanded: ${graphContext.expanded?.length || 0}`);
  lines.push(`- Edges: ${graphContext.edges?.length || 0}`);

  if (Array.isArray(suggestions) && suggestions.length > 0) {
    lines.push('', '### Ranked Suggestions');
    suggestions.forEach((suggestion, index) => {
      const score = Math.round((suggestion.similarity || 0) * 100);
      lines.push(
        `${index + 1}. ${sanitizeForPrompt(suggestion.topic || 'unknown_topic')} (${score}% match)`
      );
    });
  }

  return lines.join('\n');
}

module.exports = {
  hasBundleMemories,
  buildSuggestionsFromBundle,
  formatMemoryBundleMessage,
};
