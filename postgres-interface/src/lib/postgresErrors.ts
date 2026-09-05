export class PostgresRecoveryRequiredError extends Error {
  constructor() {
    super('PostgreSQL recovery is required');
    this.name = 'PostgresRecoveryRequiredError';
  }
}
