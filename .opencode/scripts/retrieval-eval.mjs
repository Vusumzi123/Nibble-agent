#!/usr/bin/env node
// Phase 2 retrieval evaluation harness (fork-aware).
//
// Drives the fork's HybridSearcher over the persisted flat vector store — the
// same code path as the markdown-vault MCP `view`/`semantic_search` action —
// with NO LLM. Supports the Phase 2 additions: query instruction prefix and
// cross-encoder rerank.
//
// Usage:
//   node retrieval-eval.mjs <label> [out.json] [--dist PATH]
//                            [--rerank on|off] [--rerank-candidates N]
//                            [--rerank-topn N] [--provider ollama|transformers]
//
// Env:
//   VAULT_PATH  (default: ./Brain)
//   QUERY_INSTRUCTION_PREFIX   (literal \n unescaped, same as the fork)
//   RERANK_MODEL               (default: Xenova/bge-reranker-base)
//   OLLAMA_URL / OLLAMA_MODEL / OLLAMA_DIMENSIONS  (ollama mode)

import path from "node:path";
import fs from "node:fs/promises";

const argv = process.argv.slice(2);
const LABEL = argv[0] ?? "phase2";
const OUT = argv[1] ?? `/tmp/opencode/phase2-${LABEL}.json`;

const flags = {};
for (let i = 2; i < argv.length; i++) {
  const a = argv[i];
  if (a.startsWith("--")) {
    const next = argv[i + 1];
    if (next && !next.startsWith("--")) {
      flags[a.slice(2)] = next;
      i++;
    } else {
      flags[a.slice(2)] = true;
    }
  }
}

const DIST = flags.dist ?? path.resolve(
  "vendor/mcp-markdown-vault/dist",
);
const VAULT = process.env.VAULT_PATH
  ? path.resolve(process.env.VAULT_PATH)
  : path.resolve("Brain");
const RERANK = (flags.rerank ?? "on") !== "off";
const RERANK_CANDIDATES = parseInt(flags["rerank-candidates"] ?? "20", 10);
const RERANK_TOPN = flags["rerank-topn"] ? parseInt(flags["rerank-topn"], 10) : undefined;
const RERANK_MODEL = process.env.RERANK_MODEL ?? "Xenova/bge-reranker-base";
const queryPrefix = (process.env.QUERY_INSTRUCTION_PREFIX ?? "").replace(
  /\\n/g,
  "\n",
);

const indexFile = path.join(VAULT, ".markdown_vault_mcp", "index.json");
const meta = JSON.parse(await fs.readFile(indexFile, "utf-8"));

// 10 Phase 1 continuity fixtures + 5 hard/near-miss additions.
const FIXTURES = [
  { q: "how do I do a bare-metal Btrfs backup of CachyOS", expected: "Linux/Btrfs Bare-Metal Backup and Recovery.md", hard: false },
  { q: "AUR malware packages and malicious accounts watchlist", expected: "Security/AUR Malicious Packages Incident — June 2026.md", hard: false },
  { q: "Himalaya email setup for the sysop mailbox", expected: "AI/Himalaya Email Setup.md", hard: false },
  { q: "draw.io SVG renders black shapes in dark mode", expected: "Development/Draw.io Diagram Conventions.md", hard: false },
  { q: "SSH into the Proxmox host — command reference", expected: "Homelab/SSH to Proxmox — Command Reference.md", hard: false },
  { q: "which local model fits 12 GB VRAM", expected: "AI/Local Models/Local Model Selection — 12GB VRAM.md", hard: false },
  { q: "rag-search subagent role and tools", expected: "AI/Subagents/Rag-Search Subagent.md", hard: false },
  { q: "vault readonly folders the agent must not write", expected: "AI/Plugins/Vault Read-Only Guard.md", hard: false },
  { q: "shared logging engine rotation options", expected: "AI/Plugins/Shared Logging Engine.md", hard: false },
  { q: "Skyrim Prisma UI framework", expected: "Gaming/Prisma UI — Skyrim Mod UI Framework.md", hard: false },
  { q: "the typed decision model for constrained token-budget choices", expected: "AI/Jev/Jev — TypeSafe AI Typed-Decision Model.md", hard: true },
  { q: "how to reach the OpenCode server from another machine on the LAN", expected: "AI/OpenCode/OpenCode Server LAN Exposure.md", hard: true },
  { q: "why the vector store silently pads or truncates on a dimension mismatch", expected: "AI/MCP/Phase 2 MCP Fork — Implementation Contract.md", hard: true },
  { q: "shader cache rebuild when the mod manager overwrites files", expected: "Gaming/Bottled Shaders — ShaderCache Rebuild on MO2 Overwrite.md", hard: true },
  { q: "measuring network bufferbloat on the home connection", expected: "Network/Network Bufferbloat Test.md", hard: true },
];

const { TransformersEmbeddingProvider } = await import(
  `${DIST}/infrastructure/transformers-embedding.js`
);
const { OllamaEmbeddingProvider } = await import(
  `${DIST}/infrastructure/ollama-embedding.js`
);
const { createVectorStore } = await import(
  `${DIST}/infrastructure/vector-store-factory.js`
);
const { HybridSearcher } = await import(`${DIST}/use-cases/hybrid-search.js`);
const { CrossEncoderReranker } = await import(
  `${DIST}/infrastructure/reranker.js`
);

const providerKind =
  flags.provider ??
  (process.env.OLLAMA_URL ? "ollama" : "transformers");

let embedder;
if (providerKind === "ollama") {
  embedder = new OllamaEmbeddingProvider({
    baseUrl: process.env.OLLAMA_URL,
    model: meta.embeddingModel,
    dimensions: meta.dimensions,
  });
} else {
  embedder = new TransformersEmbeddingProvider({
    model: meta.embeddingModel,
    dimensions: meta.dimensions,
  });
}

const store = await createVectorStore(
  VAULT,
  meta.embeddingModel,
  meta.dimensions,
);

const reranker = RERANK ? new CrossEncoderReranker({ modelName: RERANK_MODEL }) : undefined;
const searcher = new HybridSearcher(store, embedder, {
  queryPrefix: queryPrefix || undefined,
  reranker,
  rerankCandidates: RERANK_CANDIDATES,
  rerankTopN: RERANK_TOPN,
});

const uniqueDocs = new Set(meta.chunks.map((c) => c.docPath));
const queries = [];
let hitsAt5 = 0;
let hitsAt1 = 0;
let mrrSum = 0;

for (const f of FIXTURES) {
  const t0 = performance.now();
  const raw = await searcher.search(f.q, { k: 5 });
  const ms = performance.now() - t0;

  const seen = [];
  const top = [];
  for (const r of raw) {
    if (!top.some((x) => x.docPath === r.docPath)) {
      const entry = {
        docPath: r.docPath,
        score: Math.round(r.score * 1000) / 1000,
        vectorScore: Math.round(r.vectorScore * 1000) / 1000,
        lexicalScore: Math.round(r.lexicalScore * 1000) / 1000,
      };
      if (r.rerankScore !== undefined) {
        entry.rerankScore = Math.round(r.rerankScore * 1000) / 1000;
      }
      top.push(entry);
    }
    if (!seen.includes(r.docPath)) seen.push(r.docPath);
  }

  const rank = seen.indexOf(f.expected) + 1; // 1-based, 0 = miss
  const hit5 = rank > 0 && rank <= 5;
  const hit1 = rank === 1;
  if (hit5) hitsAt5++;
  if (hit1) hitsAt1++;
  if (rank > 0) mrrSum += 1 / rank;

  queries.push({
    q: f.q,
    expected: f.expected,
    hard: f.hard,
    hit5,
    hit1,
    rank: rank > 0 ? rank : null,
    ms: Math.round(ms),
    top,
    seen,
  });
}

const hardQs = queries.filter((q) => q.hard);
const report = {
  label: LABEL,
  provider: providerKind,
  rerank: RERANK,
  rerankModel: RERANK ? RERANK_MODEL : null,
  rerankCandidates: RERANK ? RERANK_CANDIDATES : null,
  queryPrefix: queryPrefix || null,
  model: meta.embeddingModel,
  dimensions: meta.dimensions,
  indexVersion: meta.version,
  savedAt: meta.savedAt,
  chunks: meta.chunks.length,
  docs: uniqueDocs.size,
  generatedAt: new Date().toISOString(),
  summary: {
    hit5: `${hitsAt5}/${FIXTURES.length}`,
    hit5Rate: +(hitsAt5 / FIXTURES.length).toFixed(3),
    hit1: `${hitsAt1}/${FIXTURES.length}`,
    hit1Rate: +(hitsAt1 / FIXTURES.length).toFixed(3),
    mrr: +(mrrSum / FIXTURES.length).toFixed(3),
    meanMs: Math.round(queries.reduce((a, q) => a + q.ms, 0) / queries.length),
    hard: {
      hit5: `${hardQs.filter((q) => q.hit5).length}/${hardQs.length}`,
      hit1: `${hardQs.filter((q) => q.hit1).length}/${hardQs.length}`,
      mrr: +(
        hardQs.reduce((a, q) => a + (q.rank ? 1 / q.rank : 0), 0) / hardQs.length
      ).toFixed(3),
    },
  },
  queries,
};

await fs.mkdir(path.dirname(OUT), { recursive: true });
await fs.writeFile(OUT, JSON.stringify(report, null, 2));

console.log(
  `${LABEL}: provider=${providerKind} rerank=${RERANK ? "on" : "off"} model=${meta.embeddingModel} dims=${meta.dimensions} docs=${uniqueDocs.size} chunks=${meta.chunks.length}`,
);
console.log(
  `  Hit@5=${report.summary.hit5}  Hit@1=${report.summary.hit1}  MRR=${report.summary.mrr}  meanSearchMs=${report.summary.meanMs}`,
);
console.log(
  `  hard: Hit@5=${report.summary.hard.hit5}  Hit@1=${report.summary.hard.hit1}  MRR=${report.summary.hard.mrr}`,
);
for (const q of queries) {
  console.log(
    `  ${q.hit5 ? "HIT " : "MISS"} rank=${q.rank ?? "-"} ${q.ms}ms${q.hard ? " (hard)" : ""}  ${q.q}${q.hit5 ? "" : `  (top: ${q.seen[0] ?? "none"})`}`,
  );
}
console.log(`  -> ${OUT}`);
