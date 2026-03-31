/**
 * mama memory command
 *
 * Subcommands:
 *   mama memory search <query>  — semantic search over memory
 *   mama memory stats           — show record/edge/scope counts
 */

import { Command } from 'commander';

export function memoryCommand(): Command {
  const cmd = new Command('memory').description('Query and inspect MAMA memory');

  cmd
    .command('search')
    .description('Semantic search over saved memories')
    .argument('<query...>', 'Search query')
    .option('-n, --limit <n>', 'Max results', '10')
    .action(async (queryParts: string[], options: { limit: string }) => {
      const query = queryParts.join(' ');
      const limit = Math.min(Math.max(parseInt(options.limit, 10) || 10, 1), 50);

      try {
        // Lazy-load mama-core to avoid startup cost when not needed
        const { recallMemory } = await import('@jungjaehoon/mama-core');

        console.log(`\nSearching for: "${query}" (limit ${limit})\n`);

        const bundle = await recallMemory(query);
        const memories = bundle.memories.slice(0, limit);

        if (memories.length === 0) {
          console.log('No matching memories found.');
          return;
        }

        for (const [i, mem] of memories.entries()) {
          const date =
            mem.event_date ||
            (typeof mem.created_at === 'number'
              ? new Date(mem.created_at).toISOString().slice(0, 10)
              : String(mem.created_at).slice(0, 10));
          const conf = typeof mem.confidence === 'number' ? mem.confidence.toFixed(2) : '?';
          const scopeStr = mem.scopes.map((s) => `${s.kind}:${s.id}`).join(', ') || 'none';

          console.log(`  ${i + 1}. [${mem.kind || 'decision'}] ${mem.topic}`);
          console.log(`     ${mem.summary}`);
          console.log(
            `     confidence=${conf}  status=${mem.status}  date=${date}  scopes=${scopeStr}`
          );
          console.log(`     id: ${mem.id}`);
          console.log('');
        }

        console.log(`Returned ${memories.length} of ${bundle.memories.length} total matches.`);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${msg}`);
        process.exit(1);
      }
    });

  cmd
    .command('stats')
    .description('Show memory database statistics')
    .action(async () => {
      try {
        const { initDB, getAdapter } = await import('@jungjaehoon/mama-core/memory-store');
        await initDB();
        const adapter = getAdapter();

        const recordCount = (
          adapter.prepare('SELECT COUNT(*) as cnt FROM decisions').get() as { cnt: number }
        ).cnt;

        const edgeCount = (
          adapter.prepare('SELECT COUNT(*) as cnt FROM decision_edges').get() as { cnt: number }
        ).cnt;

        let scopeCount = 0;
        try {
          scopeCount = (
            adapter.prepare('SELECT COUNT(*) as cnt FROM memory_scopes').get() as { cnt: number }
          ).cnt;
        } catch {
          // Table may not exist in older schemas
        }

        let activeCount = 0;
        try {
          activeCount = (
            adapter
              .prepare(
                "SELECT COUNT(*) as cnt FROM decisions WHERE status = 'active' OR status IS NULL"
              )
              .get() as { cnt: number }
          ).cnt;
        } catch {
          activeCount = recordCount;
        }

        let truthCount = 0;
        try {
          truthCount = (
            adapter.prepare('SELECT COUNT(*) as cnt FROM memory_truth').get() as { cnt: number }
          ).cnt;
        } catch {
          // Table may not exist
        }

        console.log('\n  MAMA Memory Statistics\n');
        console.log(`  Records (total):   ${recordCount}`);
        console.log(`  Records (active):  ${activeCount}`);
        console.log(`  Edges:             ${edgeCount}`);
        console.log(`  Scopes:            ${scopeCount}`);
        console.log(`  Truth projections: ${truthCount}`);
        console.log('');
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        console.error(`Error: ${msg}`);
        process.exit(1);
      }
    });

  return cmd;
}
