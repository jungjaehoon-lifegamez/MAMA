import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, rmSync } from "node:fs"
import { join } from "node:path"
import { tmpdir } from "node:os"

import { MAMAProvider } from "./index"

interface MockSearchRow {
  id: string
  topic: string
  decision: string
  reasoning: string
  similarity: number
  created_at: number
}

function createResponse(body: unknown) {
  return {
    ok: true,
    async json() {
      return body
    },
  }
}

test("MAMAProvider.search should keep only matching container results", async () => {
  const provider = new MAMAProvider()
  ;(provider as unknown as { baseUrl: string }).baseUrl = "http://localhost:3847"

  const originalFetch = globalThis.fetch
  let requestCount = 0
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    requestCount++
    const url = String(input)
    if (url.includes("topicPrefix=bench_target-container_")) {
      return createResponse({ results: [] })
    }
    return createResponse({
      results: [
        {
          id: "other",
          topic: "bench_other-session_1",
          decision: "other result",
          reasoning: "other reasoning",
          similarity: 0.99,
          created_at: 1,
        },
        {
          id: "match",
          topic: "bench_target-container_session_1",
          decision: "target result",
          reasoning: "target reasoning",
          similarity: 0.88,
          created_at: 2,
        },
      ] satisfies MockSearchRow[],
    })
  }) as typeof fetch

  try {
    const results = await provider.search("query", { containerTag: "target-container", limit: 10 })
    assert.equal(results.length, 1)
    assert.equal((results[0] as { id: string }).id, "match")
    assert.equal(requestCount, 2)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("MAMAProvider.search should return empty array when container results are absent", async () => {
  const provider = new MAMAProvider()
  ;(provider as unknown as { baseUrl: string }).baseUrl = "http://localhost:3847"

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    const url = String(input)
    if (url.includes("topicPrefix=bench_target-container_")) {
      return createResponse({ results: [] })
    }
    return createResponse({
      results: [
        {
          id: "other",
          topic: "bench_other-session_1",
          decision: "other result",
          reasoning: "other reasoning",
          similarity: 0.99,
          created_at: 1,
        },
      ] satisfies MockSearchRow[],
    })
  }) as typeof fetch

  try {
    const results = await provider.search("query", { containerTag: "target-container", limit: 10 })
    assert.deepEqual(results, [])
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("MAMAProvider.search should request a wider result window for large containers", async () => {
  const provider = new MAMAProvider()
  ;(provider as unknown as { baseUrl: string }).baseUrl = "http://localhost:3847"
  ;(provider as unknown as { savedIds: Map<string, string[]> }).savedIds.set(
    "target-container",
    Array.from({ length: 51 }, (_, index) => `id-${index}`)
  )

  const originalFetch = globalThis.fetch
  let requestedUrl = ""
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    requestedUrl = String(input)
    return createResponse({ results: [] })
  }) as typeof fetch

  try {
    await provider.search("query", { containerTag: "target-container", limit: 10 })
    const url = new URL(requestedUrl)
    assert.equal(url.searchParams.get("limit"), "255")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("MAMAProvider.search should use server-side scoped search when topicPrefix results exist", async () => {
  const provider = new MAMAProvider()
  ;(provider as unknown as { baseUrl: string }).baseUrl = "http://localhost:3847"

  const originalFetch = globalThis.fetch
  const requests: string[] = []
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    const url = String(input)
    requests.push(url)

    if (url.includes("topicPrefix=bench_target-container_")) {
      return createResponse({
        results: [
          {
            id: "match",
            topic: "bench_target-container_session_1",
            decision: "target result",
            reasoning: "target reasoning",
            similarity: 0.88,
            created_at: 2,
          },
        ] satisfies MockSearchRow[],
      })
    }

    return createResponse({ results: [] })
  }) as typeof fetch

  try {
    const results = await provider.search("query", { containerTag: "target-container", limit: 10 })
    assert.equal(results.length, 1)
    assert.equal((results[0] as { id: string }).id, "match")
    assert.equal(requests.length, 1)
    assert.match(requests[0], /topicPrefix=bench_target-container_/)
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("MAMAProvider.search should fall back to local scoped ranking when MAMA returns no isolated hits", async () => {
  const provider = new MAMAProvider()
  ;(provider as unknown as { baseUrl: string }).baseUrl = "http://localhost:3847"
  ;(
    provider as unknown as {
      localRecords: Map<
        string,
        Array<{ id: string; topic: string; content: string; created_at: number }>
      >
    }
  ).localRecords.set("target-container", [
    {
      id: "local-1",
      topic: "bench_target-container_session_1",
      content: "user: How long did I wait for the decision on my asylum application?\nassistant: You waited over a year for the decision.",
      created_at: 10,
    },
    {
      id: "local-2",
      topic: "bench_target-container_session_2",
      content: "user: Tell me about Swedish immigration policies.\nassistant: Here are several policy notes.",
      created_at: 11,
    },
  ])

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => createResponse({ results: [] })) as typeof fetch

  try {
    const results = await provider.search("How long did I wait for the decision on my asylum application?", {
      containerTag: "target-container",
      limit: 5,
    })

    assert.equal(results.length, 1)
    assert.equal((results[0] as { id: string }).id, "local-1")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("MAMAProvider.ingest should preserve late-session facts for scoped fallback search", async () => {
  const provider = new MAMAProvider()
  ;(provider as unknown as { baseUrl: string }).baseUrl = "http://localhost:3847"

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    const url = String(input)
    if (url.endsWith("/api/mama/save")) {
      return createResponse({ success: true, id: "saved-1" })
    }
    return createResponse({ results: [] })
  }) as typeof fetch

  try {
    const longPrefix = "x".repeat(2100)
    await provider.ingest(
      [
        {
          sessionId: "session-1",
          messages: [
            { role: "user", content: longPrefix },
            {
              role: "assistant",
              content: "My asylum application finally got approved after over a year of waiting.",
            },
          ],
          metadata: { date: "2026-01-01T00:00:00Z", formattedDate: "January 1, 2026" },
        },
      ],
      { containerTag: "target-container" }
    )

    const results = await provider.search("How long did I wait for the decision on my asylum application?", {
      containerTag: "target-container",
      limit: 5,
    })

    assert.equal(results.length, 1)
    assert.equal((results[0] as { id: string }).id, "saved-1")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("MAMAProvider.search should apply semantic rerank to local scoped candidates", async () => {
  const provider = new MAMAProvider()
  ;(provider as unknown as { baseUrl: string }).baseUrl = "http://localhost:3847"
  ;(
    provider as unknown as {
      localRecords: Map<
        string,
        Array<{ id: string; topic: string; content: string; created_at: number }>
      >
    }
  ).localRecords.set("target-container", [
    {
      id: "lexical-top",
      topic: "bench_target-container_session_1",
      content:
        "user: I need dinner ideas for this weekend with ingredients to serve. assistant: Here are dinner ingredients and weekend serving ideas, but nothing about homegrown produce.",
      created_at: 10,
    },
    {
      id: "semantic-best",
      topic: "bench_target-container_session_2",
      content:
        "user: I harvested homegrown cherry tomatoes, basil, and mint. assistant: You should serve a dinner that showcases those ingredients.",
      created_at: 11,
    },
  ])

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => createResponse({ results: [] })) as typeof fetch
  ;(provider as unknown as {
    semanticRerankLocalRecords?: (
      query: string,
      candidates: Array<{ id: string; topic: string; content: string; created_at: number; score: number }>
    ) => Promise<Array<{ id: string; topic: string; content: string; created_at: number; score: number }>>
  }).semanticRerankLocalRecords = async (_query, candidates) => [
    candidates.find((candidate) => candidate.id === "semantic-best")!,
    candidates.find((candidate) => candidate.id === "lexical-top")!,
  ]

  try {
    const results = await provider.search("What should I serve for dinner this weekend with my homegrown ingredients?", {
      containerTag: "target-container",
      limit: 5,
    })

    assert.equal((results[0] as { id: string }).id, "semantic-best")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("MAMAProvider.search should expand preference-style queries to include domain-specific candidates", async () => {
  const provider = new MAMAProvider()
  ;(provider as unknown as { baseUrl: string }).baseUrl = "http://localhost:3847"
  ;(
    provider as unknown as {
      localRecords: Map<
        string,
        Array<{ id: string; topic: string; content: string; created_at: number }>
      >
    }
  ).localRecords.set("target-container", [
    {
      id: "sony-flash",
      topic: "bench_target-container_session_35",
      content:
        "user: I'm looking to upgrade my camera flash. Can you recommend some good options that are compatible with my Sony A7R IV? assistant: Here are several Sony-compatible flash options and accessories for your camera setup.",
      created_at: 35,
    },
    {
      id: "generic-tips",
      topic: "bench_target-container_session_8",
      content:
        "user: I'd like to know more about how to style the scene for my candle photos. assistant: Here are props and backdrops for candle photography.",
      created_at: 8,
    },
  ])

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async () => createResponse({ results: [] })) as typeof fetch

  try {
    const results = await provider.search(
      "Can you suggest some accessories that would complement my current photography setup?",
      {
        containerTag: "target-container",
        limit: 5,
      }
    )

    const ids = results.map((result) => (result as { id: string }).id)
    assert.ok(ids.includes("sony-flash"))
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("MAMAProvider.search should apply semantic rerank to ambiguous server-scoped results", async () => {
  const provider = new MAMAProvider()
  ;(provider as unknown as { baseUrl: string }).baseUrl = "http://localhost:3847"

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    const url = String(input)
    if (url.includes("topicPrefix=bench_target-container_")) {
      return createResponse({
        results: [
          {
            id: "lexical-top",
            topic: "bench_target-container_session_1",
            decision:
              "You asked for dinner ideas for this weekend with ingredients to serve, but there was no mention of homegrown produce.",
            reasoning: "Lexically close but wrong fact cluster.",
            similarity: 8,
            created_at: 10,
          },
          {
            id: "semantic-best",
            topic: "bench_target-container_session_2",
            decision:
              "You harvested homegrown cherry tomatoes, basil, and mint and wanted dinner ideas that showcase those ingredients.",
            reasoning: "Exact preference-bearing detail.",
            similarity: 7,
            created_at: 11,
          },
        ] satisfies MockSearchRow[],
      })
    }
    return createResponse({ results: [] })
  }) as typeof fetch

  ;(provider as unknown as {
    semanticRerankLocalRecords?: (
      query: string,
      candidates: Array<{ id: string; topic: string; content: string; created_at: number; score: number }>
    ) => Promise<Array<{ id: string; topic: string; content: string; created_at: number; score: number }>>
  }).semanticRerankLocalRecords = async (_query, candidates) => [
    candidates.find((candidate) => candidate.id === "semantic-best")!,
    candidates.find((candidate) => candidate.id === "lexical-top")!,
  ]

  try {
    const results = await provider.search("What should I serve for dinner this weekend with my homegrown ingredients?", {
      containerTag: "target-container",
      limit: 5,
    })

    assert.equal((results[0] as { id: string }).id, "semantic-best")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("MAMAProvider.search should merge local expanded candidates for preference queries before reranking", async () => {
  const provider = new MAMAProvider()
  ;(provider as unknown as { baseUrl: string }).baseUrl = "http://localhost:3847"
  ;(
    provider as unknown as {
      localRecords: Map<
        string,
        Array<{ id: string; topic: string; content: string; created_at: number }>
      >
    }
  ).localRecords.set("target-container", [
    {
      id: "sony-flash",
      topic: "bench_target-container_session_35",
      content:
        "user: I'm looking to upgrade my camera flash. Can you recommend some good options that are compatible with my Sony A7R IV? assistant: Here are several Sony-compatible flash options and accessories for your camera setup.",
      created_at: 35,
    },
  ])

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    const url = String(input)
    if (url.includes("topicPrefix=bench_target-container_")) {
      return createResponse({
        results: [
          {
            id: "generic-tips",
            topic: "bench_target-container_session_8",
            decision: "Here are props and backdrops for candle photography.",
            reasoning: "Lexically matched but not the best gear preference memory.",
            similarity: 8,
            created_at: 8,
          },
        ] satisfies MockSearchRow[],
      })
    }
    return createResponse({ results: [] })
  }) as typeof fetch

  ;(provider as unknown as {
    semanticRerankLocalRecords?: (
      query: string,
      candidates: Array<{ id: string; topic: string; content: string; created_at: number; score: number }>
    ) => Promise<Array<{ id: string; topic: string; content: string; created_at: number; score: number }>>
  }).semanticRerankLocalRecords = async (_query, candidates) => [
    candidates.find((candidate) => candidate.id === "sony-flash")!,
    ...candidates.filter((candidate) => candidate.id !== "sony-flash"),
  ]

  try {
    const results = await provider.search(
      "Can you suggest some accessories that would complement my current photography setup?",
      {
        containerTag: "target-container",
        limit: 5,
      }
    )

    assert.equal((results[0] as { id: string }).id, "sony-flash")
  } finally {
    globalThis.fetch = originalFetch
  }
})

test("MAMAProvider.search replay should restore scoped fallback records from data source run state", async () => {
  const sourceRunPath = mkdtempSync(join(tmpdir(), "mama-provider-source-"))
  const replayRunPath = mkdtempSync(join(tmpdir(), "mama-provider-replay-"))

  const originalFetch = globalThis.fetch
  globalThis.fetch = (async (input: URL | RequestInfo) => {
    const url = String(input)
    if (url.endsWith("/health")) {
      return createResponse({ ok: true })
    }
    if (url.endsWith("/api/mama/save")) {
      return createResponse({ success: true, id: "saved-1" })
    }
    if (url.includes("/api/mama/search")) {
      return createResponse({ results: [] })
    }
    return createResponse({})
  }) as typeof fetch

  try {
    const ingestProvider = new MAMAProvider()
    await ingestProvider.initialize({
      apiKey: "local",
      baseUrl: "http://localhost:3847",
      runPath: sourceRunPath,
      dataSourceRunPath: sourceRunPath,
    })

    await ingestProvider.ingest(
      [
        {
          sessionId: "session-1",
          messages: [
            {
              role: "assistant",
              content: "You waited over a year for the decision on your asylum application.",
            },
          ],
          metadata: { date: "2026-01-01T00:00:00Z", formattedDate: "January 1, 2026" },
        },
      ],
      { containerTag: "target-container" }
    )

    const replayProvider = new MAMAProvider()
    await replayProvider.initialize({
      apiKey: "local",
      baseUrl: "http://localhost:3847",
      runPath: replayRunPath,
      dataSourceRunPath: sourceRunPath,
    })

    const results = await replayProvider.search(
      "How long did I wait for the decision on my asylum application?",
      {
        containerTag: "target-container",
        limit: 5,
      }
    )

    assert.equal(results.length, 1)
    assert.equal((results[0] as { id: string }).id, "saved-1")
  } finally {
    globalThis.fetch = originalFetch
    rmSync(sourceRunPath, { recursive: true, force: true })
    rmSync(replayRunPath, { recursive: true, force: true })
  }
})
