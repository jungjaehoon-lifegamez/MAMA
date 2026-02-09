import {
  extractContracts,
  EDIT_TOOLS,
  isLowPriorityPath,
  CONTRACT_SAVE_LIMIT,
  type ExtractedContract,
} from './contract-extractor.js';

type ExecuteToolFn = (name: string, input: Record<string, unknown>) => Promise<unknown>;

interface PostToolHandlerConfig {
  enabled: boolean;
  contractSaveLimit?: number;
}

interface SearchResultItem {
  topic?: string;
  decision?: string;
  similarity?: number;
}

interface SearchResponse {
  results?: SearchResultItem[];
}

export class PostToolHandler {
  private readonly executeTool: ExecuteToolFn;
  private readonly enabled: boolean;
  private readonly contractSaveLimit: number;

  constructor(executeTool: ExecuteToolFn, config: PostToolHandlerConfig) {
    this.executeTool = executeTool;
    this.enabled = config.enabled;
    this.contractSaveLimit = config.contractSaveLimit ?? CONTRACT_SAVE_LIMIT;
  }

  /**
   * Synchronous entry point — fires background processing without blocking.
   * MUST NOT be async. MUST NOT return a Promise. MUST NOT throw.
   */
  processInBackground(toolName: string, input: unknown, result: unknown): void {
    if (!this.enabled) {
      return;
    }

    this.processAsync(toolName, input, result).catch(() => {});
  }

  private async processAsync(toolName: string, input: unknown, result: unknown): Promise<void> {
    if (!this.isEditTool(toolName)) {
      return;
    }

    const filePath = this.extractFilePath(input);
    if (!filePath) {
      return;
    }

    if (isLowPriorityPath(filePath)) {
      return;
    }

    const content = this.extractContent(result);
    if (!content) {
      return;
    }

    const extracted = extractContracts(content, filePath);
    const contracts = this.flattenContracts(extracted);
    if (contracts.length === 0) {
      return;
    }

    const limited = contracts.slice(0, this.contractSaveLimit);

    for (const contract of limited) {
      const formatted = this.formatForMama(contract, filePath);
      if (!formatted) {
        continue;
      }

      const isDupe = await this.isDuplicate(formatted.topic, formatted.decision);
      if (isDupe) {
        continue;
      }

      await this.saveContract(formatted);
    }
  }

  private isEditTool(toolName: string): boolean {
    return EDIT_TOOLS.some((tool) => toolName.includes(tool));
  }

  private extractFilePath(input: unknown): string | undefined {
    if (!input || typeof input !== 'object') {
      return undefined;
    }
    const obj = input as Record<string, unknown>;
    const raw = obj['path'] ?? obj['file_path'] ?? obj['filePath'];
    return typeof raw === 'string' ? raw : undefined;
  }

  private extractContent(result: unknown): string | undefined {
    if (typeof result === 'string') {
      return result.length > 0 ? result : undefined;
    }
    if (result && typeof result === 'object') {
      const obj = result as Record<string, unknown>;
      if (typeof obj['content'] === 'string' && obj['content'].length > 0) {
        return obj['content'];
      }
      const serialized = JSON.stringify(result);
      return serialized.length > 2 ? serialized : undefined;
    }
    return undefined;
  }

  private flattenContracts(extracted: ReturnType<typeof extractContracts>): ExtractedContract[] {
    const all: ExtractedContract[] = [];

    if (extracted.apiEndpoints) {
      all.push(...(extracted.apiEndpoints as ExtractedContract[]));
    }
    if (extracted.functionSignatures) {
      all.push(...(extracted.functionSignatures as ExtractedContract[]));
    }
    if (extracted.typeDefinitions) {
      all.push(...(extracted.typeDefinitions as ExtractedContract[]));
    }
    if (extracted.sqlSchemas) {
      all.push(...(extracted.sqlSchemas as ExtractedContract[]));
    }
    if (extracted.graphqlSchemas) {
      all.push(...(extracted.graphqlSchemas as ExtractedContract[]));
    }

    return all;
  }

  private formatForMama(
    contract: ExtractedContract,
    filePath: string
  ): { topic: string; decision: string; reasoning: string; confidence: number } | undefined {
    const type = contract.type;

    if (type === 'api_endpoint') {
      const c = contract as ExtractedContract & {
        method: string;
        path: string;
        request: string;
        response: string;
      };
      return {
        topic: `contract_${c.method.toLowerCase()}_${c.path.replace(/[^a-z0-9]/gi, '_')}`,
        decision: `${c.method} ${c.path} expects ${c.request}, returns ${c.response}`,
        reasoning: `Auto-extracted from ${filePath}. Frontend/backend must use exact schema.`,
        confidence: contract.confidence ?? 0.7,
      };
    }

    if (type === 'function_signature') {
      const c = contract as ExtractedContract & { name: string; params: string[] };
      return {
        topic: `contract_function_${c.name}`,
        decision: `${c.name}(${c.params.join(', ')}) defined in ${filePath}`,
        reasoning: `Auto-extracted function signature. Callers must match exact signature.`,
        confidence: contract.confidence ?? 0.7,
      };
    }

    if (type === 'type_definition') {
      const c = contract as ExtractedContract & {
        name: string;
        kind: string;
        fields: string[];
      };
      return {
        topic: `contract_type_${c.name}`,
        decision: `${c.kind} ${c.name} { ${c.fields.join('; ')} }`,
        reasoning: `Auto-extracted type definition from ${filePath}. All usages must match.`,
        confidence: contract.confidence ?? 0.7,
      };
    }

    if (type === 'sql_schema') {
      const c = contract as ExtractedContract & {
        table: string;
        operation: string;
        columns: string[];
      };
      const op = c.operation === 'CREATE_TABLE' ? 'CREATE TABLE' : 'ALTER TABLE';
      return {
        topic: `contract_sql_${c.table}`,
        decision: `${op} ${c.table} (${c.columns.join(', ')})`,
        reasoning: `Auto-extracted SQL schema from ${filePath}. Database operations must match exact schema.`,
        confidence: contract.confidence ?? 0.7,
      };
    }

    if (type === 'graphql_schema') {
      const c = contract as ExtractedContract & {
        name: string;
        kind: string;
        fields: string[];
      };
      return {
        topic: `contract_graphql_${c.name}`,
        decision: `${c.kind} ${c.name} { ${c.fields.join(', ')} }`,
        reasoning: `Auto-extracted GraphQL schema from ${filePath}. Queries/mutations must match schema.`,
        confidence: contract.confidence ?? 0.7,
      };
    }

    return undefined;
  }

  private async isDuplicate(topic: string, decision: string): Promise<boolean> {
    try {
      const response = (await this.executeTool('mama_search', {
        query: topic,
        type: 'decision',
        limit: 3,
      })) as SearchResponse | undefined;

      if (!response?.results || response.results.length === 0) {
        return false;
      }

      return response.results.some((item) => item.topic === topic && item.decision === decision);
    } catch {
      return false;
    }
  }

  private async saveContract(formatted: {
    topic: string;
    decision: string;
    reasoning: string;
    confidence: number;
  }): Promise<void> {
    try {
      await this.executeTool('mama_save', {
        type: 'decision',
        topic: formatted.topic,
        decision: formatted.decision,
        reasoning: formatted.reasoning,
        confidence: formatted.confidence,
      });
    } catch {}
  }
}
