/**
 * mama_add — Auto-extract and save facts from conversation content.
 *
 * Uses Haiku (via mama-core HaikuClient) to extract structured facts,
 * then saves each via mama.save(). Falls back gracefully when Haiku
 * is unavailable.
 */

const mama = require('@jungjaehoon/mama-core/mama-api');

let HaikuClient;
let extractFacts;
try {
  HaikuClient = require('@jungjaehoon/mama-core/haiku-client').HaikuClient;
  extractFacts = require('@jungjaehoon/mama-core/fact-extractor').extractFacts;
} catch {
  // mama-core may not have these modules yet
  HaikuClient = null;
  extractFacts = null;
}

const TOOL_DEFINITION = {
  name: 'mama_add',
  description:
    'Ingest conversation content. MAMA automatically extracts and saves important decisions and facts. Use after completing meaningful tasks. Do NOT use for greetings or trivial chat.',
  inputSchema: {
    type: 'object',
    properties: {
      content: {
        type: 'string',
        description: 'Conversation content or summary to extract facts from',
      },
    },
    required: ['content'],
  },
};

let haikuInstance = null;

function getHaiku() {
  if (!HaikuClient) {
    return null;
  }
  if (!haikuInstance) {
    haikuInstance = new HaikuClient();
  }
  return haikuInstance;
}

async function execute(input) {
  const { content } = input;

  if (!content || typeof content !== 'string') {
    return { success: false, error: 'content is required and must be a string' };
  }

  const haiku = getHaiku();
  if (!haiku || !haiku.available() || !extractFacts) {
    return {
      success: false,
      error: 'Smart memory unavailable. Use mama_save to save decisions manually.',
    };
  }

  try {
    const facts = await extractFacts(content, haiku);

    if (facts.length === 0) {
      return { success: true, extracted: 0, saved: 0, message: 'No facts worth saving found.' };
    }

    let saved = 0;
    let skippedDuplicates = 0;

    for (const fact of facts) {
      try {
        // Search for existing similar decisions
        const existing = await mama.suggest(fact.topic, { limit: 3 });
        const isDuplicate =
          existing?.results?.some((r) => r.topic === fact.topic && r.similarity > 0.9) ?? false;

        if (isDuplicate) {
          skippedDuplicates++;
          continue;
        }

        await mama.save({
          topic: fact.topic,
          decision: fact.decision,
          reasoning: `[auto-extracted] ${fact.reasoning}`,
          confidence: fact.confidence,
          is_static: fact.is_static ? 1 : 0,
        });
        saved++;
      } catch (err) {
        // Continue with other facts if one fails
        console.error(`[mama_add] Failed to save fact "${fact.topic}": ${err.message}`);
      }
    }

    return {
      success: true,
      extracted: facts.length,
      saved,
      skipped_duplicates: skippedDuplicates,
    };
  } catch (err) {
    return {
      success: false,
      error: `Extraction failed: ${err.message}`,
    };
  }
}

module.exports = { TOOL_DEFINITION, execute };
