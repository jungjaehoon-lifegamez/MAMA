/**
 * Quick test for MAMA provider without needing LLM API keys
 * Tests: initialize → ingest → awaitIndexing → search → clear
 */

import { MAMAProvider } from "./src/providers/mama/index.ts"

const provider = new MAMAProvider()

const CONTAINER_TAG = `test_${Date.now()}`

const testSessions = [
  {
    sessionId: "sess1",
    messages: [
      { role: "user", content: "What is my favorite color?" },
      { role: "assistant", content: "Based on our previous conversations, your favorite color is blue." },
      { role: "user", content: "And my favorite food?" },
      { role: "assistant", content: "You mentioned that you love Korean BBQ, especially samgyeopsal." }
    ],
    metadata: { date: "2026-01-15T10:00:00Z", formattedDate: "January 15, 2026" }
  },
  {
    sessionId: "sess2",
    messages: [
      { role: "user", content: "I'm planning a trip to Japan next month." },
      { role: "assistant", content: "That's exciting! Japan in February is beautiful, especially if you're interested in winter festivals." },
      { role: "user", content: "My budget is around $3000." },
      { role: "assistant", content: "That's a reasonable budget for a week-long trip to Japan." }
    ],
    metadata: { date: "2026-02-01T15:00:00Z", formattedDate: "February 1, 2026" }
  }
]

async function run() {
  console.log("🧪 MAMA Provider Test Starting...\n")

  // 1. Initialize
  console.log("1️⃣  Initializing...")
  await provider.initialize({ apiKey: "local", baseUrl: "http://localhost:3847" })
  console.log("   ✅ Initialize OK\n")

  // 2. Ingest
  console.log("2️⃣  Ingesting 2 sessions...")
  const ingestResult = await provider.ingest(testSessions, { containerTag: CONTAINER_TAG })
  console.log(`   ✅ Ingested: ${ingestResult.documentIds.length} documents`)
  console.log(`   IDs: ${ingestResult.documentIds.join(", ")}\n`)

  // 3. AwaitIndexing
  console.log("3️⃣  Awaiting indexing...")
  await provider.awaitIndexing(ingestResult, CONTAINER_TAG, (progress) => {
    console.log(`   Progress: ${progress.completedIds.length}/${progress.total}`)
  })
  console.log("   ✅ Indexing complete\n")

  // 4. Search
  console.log("4️⃣  Searching: 'favorite color'...")
  const results1 = await provider.search("favorite color", { containerTag: CONTAINER_TAG, limit: 5 })
  console.log(`   Found ${results1.length} results`)
  if (results1.length > 0) {
    const r = results1[0]
    console.log(`   Top result: "${String(r.content || "").slice(0, 100)}..."`)
  }

  console.log("\n4️⃣b Searching: 'Japan trip budget'...")
  const results2 = await provider.search("Japan trip budget", { containerTag: CONTAINER_TAG, limit: 5 })
  console.log(`   Found ${results2.length} results`)
  if (results2.length > 0) {
    const r = results2[0]
    console.log(`   Top result: "${String(r.content || "").slice(0, 100)}..."`)
  }

  // 5. Clear
  console.log("\n5️⃣  Clearing test data...")
  await provider.clear(CONTAINER_TAG)
  console.log("   ✅ Clear OK\n")

  console.log("🎉 All tests passed! MAMA provider is ready for benchmarking.")
  console.log("\n📋 Next step: Provide ANTHROPIC_API_KEY to run full benchmark")
  console.log("   export ANTHROPIC_API_KEY=sk-ant-...")
  console.log("   cd ~/.mama/workspace/memorybench")
  console.log("   npx tsx src/index.ts run -p mama -b longmemeval -j sonnet-4.5 -m sonnet-4.5 -r mama-bench-v1 --limit 10")
}

run().catch((e) => {
  console.error("❌ Test failed:", e)
  process.exit(1)
})
