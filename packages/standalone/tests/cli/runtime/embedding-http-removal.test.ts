import fs, { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it, vi } from 'vitest';

const PACKAGE_ROOT = join(dirname(fileURLToPath(import.meta.url)), '../../..');
const REPOSITORY_ROOT = join(PACKAGE_ROOT, '../..');

function source(path: string): string {
  return readFileSync(join(PACKAGE_ROOT, path), 'utf8');
}

describe('TG-03/TG-05/TG-06: retired HTTP embedding and viewer session runtime', () => {
  it('keeps upload filesystem and timer initialization lazy until router construction', async () => {
    vi.resetModules();
    const mkdirSpy = vi.spyOn(fs, 'mkdirSync');
    const intervalSpy = vi.spyOn(globalThis, 'setInterval');
    try {
      const upload = await import('../../../src/api/upload-handler.js');

      expect(mkdirSpy).not.toHaveBeenCalledWith(upload.INBOUND_DIR, { recursive: true });
      expect(mkdirSpy).not.toHaveBeenCalledWith(upload.OUTBOUND_DIR, { recursive: true });
      expect(intervalSpy).not.toHaveBeenCalled();

      upload.createUploadRouter();

      expect(mkdirSpy).toHaveBeenCalledWith(upload.INBOUND_DIR, { recursive: true });
      expect(mkdirSpy).toHaveBeenCalledWith(upload.OUTBOUND_DIR, { recursive: true });
      expect(intervalSpy).toHaveBeenCalledOnce();

      upload.createUploadRouter();
      expect(intervalSpy).toHaveBeenCalledOnce();
    } finally {
      mkdirSpy.mockRestore();
      intervalSpy.mockRestore();
    }
  });

  it('removes 3849 lifecycle ownership while retaining the 3847 operational API', () => {
    const runtimeSources = [
      'src/cli/commands/start.ts',
      'src/cli/commands/stop.ts',
      'src/cli/runtime/utilities.ts',
      'src/cli/runtime/shutdown.ts',
      'src/cli/runtime/server-start.ts',
      'src/cli/runtime/api-routes-init.ts',
      'src/cli/runtime/metrics-init.ts',
      'src/observability/health-check.ts',
    ].map(source);
    const joined = runtimeSources.join('\n');

    expect(joined).not.toContain('3849');
    expect(joined).not.toMatch(/EMBEDDING_PORT|startEmbeddingServer|embeddingServer/);
    expect(joined).not.toMatch(
      /checkAndTakeoverExistingServer|warmModel|MAMA_SHUTDOWN_TOKEN|path:\s*['"]\/shutdown['"]/
    );
    expect(source('src/cli/runtime/utilities.ts')).toContain('export const API_PORT = 3847;');
    expect(source('src/cli/runtime/server-start.ts')).toContain('await apiServer.start()');
  });

  it('removes WebSocket and direct viewer-session routes while retaining operational routes', () => {
    const serverStart = source('src/cli/runtime/server-start.ts');
    const apiRoutes = source('src/cli/runtime/api-routes-init.ts');
    const apiIndex = source('src/api/index.ts');
    const authMiddleware = source('src/api/auth-middleware.ts');
    const retainedApi = `${apiIndex}\n${apiRoutes}`;

    expect(serverStart).not.toMatch(/\.on\(['"]upgrade['"]|\/ws|WebSocket/);
    expect(apiRoutes).not.toMatch(/\/api\/sessions|\/api\/session|Session API proxied/);
    expect(apiRoutes).not.toMatch(/http\.request/);
    expect(authMiddleware).not.toContain('allowQueryToken');
    expect(retainedApi).toMatch(/app\.use\(\s*['"]\/api\/report['"]/);
    expect(retainedApi).toMatch(/app\.use\(\s*['"]\/api\/agent\/raw['"]/);
    expect(retainedApi).toContain('graphHandler(req, res)');
    expect(retainedApi).toMatch(/app\.get\(\s*['"]\/health['"]/);
    expect(retainedApi).toContain('createUploadRouter');
    expect(source('src/gateways/session-store.ts')).toContain('export class SessionStore');
  });

  it('has no direct WebSocket dependency or removed core runtime import', () => {
    const packageJson = JSON.parse(source('package.json')) as {
      dependencies: Record<string, string>;
      devDependencies: Record<string, string>;
    };

    expect(packageJson.dependencies).not.toHaveProperty('ws');
    expect(packageJson.devDependencies).not.toHaveProperty('@types/ws');
    expect(
      existsSync(join(REPOSITORY_ROOT, 'packages/mama-core/src/embedding-server/index.ts'))
    ).toBe(false);
  });
});
