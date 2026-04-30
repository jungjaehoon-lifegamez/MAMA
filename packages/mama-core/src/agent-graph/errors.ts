export class AgentGraphValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AgentGraphValidationError';
  }
}
