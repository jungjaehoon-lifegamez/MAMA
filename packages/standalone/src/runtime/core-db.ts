import { isAbsolute } from 'node:path';
import {
  declareProductionDatabasePath,
  isTestMode,
  openDatabase,
  type DatabaseHandle,
} from '@jungjaehoon/mama-core/db-manager';
import { STANDALONE_MIGRATION_SOURCE } from '../storage/migrations-source.js';

export interface CoreDatabaseConfig {
  path: string;
}

export type CoreDatabase = DatabaseHandle;

/** Open one product-owned core database and the standalone-owned schema. */
export async function openCoreDatabase(config: CoreDatabaseConfig): Promise<CoreDatabase> {
  if (!isAbsolute(config.path)) {
    throw new Error(`database.path must be an absolute resolved path: ${config.path}`);
  }
  if (!isTestMode()) declareProductionDatabasePath(config.path);
  return openDatabase({
    path: config.path,
    migrations: [STANDALONE_MIGRATION_SOURCE],
    // MAMA OS alone opens this database, so a newer schema means an older install.
    refuseNewerSchema: true,
  });
}
