# Eira Yuki (雪エイラ)

A personal, conversational AI companion built with a headless architecture, hierarchical memory, state-based mood tracking, and tool execution.

> [!NOTE]
> This repository is customized specifically for my personal daily use cases. The repository is open-source and public for transparency, sharing, and showcase purposes. Default parameters (such as the `Asia/Jakarta` timezone, character traits, and bilingual Indonesian/English vernacular) are configured to match my personal environment. The underlying architecture remains fully modular and configurable.

---

## Architecture & Adapter Pattern

Eira Yuki enforces strict decoupling between **Intelligence (Core Brain)** and **Communication (Channel Adapters)**:

1. **Headless Core (`src/core/`)**:
   - Operates as a protocol-agnostic AI agent. The core brain has no knowledge of WhatsApp, Telegram, or any specific messaging network.
   - Accepts normalized input (`IncomingMessage`: text, sender ID, role, optional media/images) and returns a structured turn response (`AgentTurnResult`: reply text, reaction stickers, tool actions).
2. **Channel Adapters (`src/adapters/`)**:
   - Act as translation layers between external platforms and the Core Brain.
   - **WhatsApp Adapter (`src/adapters/whatsapp/`)**: Leverages Baileys to manage connection state, pairing, and media downloads, forwarding normalized events to the core agent and dispatching text/sticker responses.
   - **Pluggability**: Additional channels (such as Telegram, Discord, or a local REST/WebSocket IPC client) can be plugged in as new adapter folders without modifying core agent logic.

---

## Architecture Overview

![Architecture Overview](assets/architecture.svg)

---

## Key Features

1. **Natural Conversational Flow & Vision**:
   - Direct conversational turns with multimodal support. Text queries and incoming WhatsApp images are analyzed directly by the model.
2. **Dual-Persona & Access Control**:
   - **Owner Mode**: Private, unrestricted interaction with clearance to manage reminders and personal lore.
   - **Guest / Group Mode**: Reserved, polite, and privacy-guarded. In groups, Eira responds only when mentioned or quoted, strictly withholding personal facts.
3. **Balanced Tool Distribution & Multi-Step ReAct Loop**:
   - **Shared Tools**: Available to all users (`send_sticker`, `set_reminder`, `cancel_reminder`, `list_reminders`, `remember_fact`, `recall_memory`, `web_search`, `read_url`, `get_current_time`). Memory facts are scoped per user entity.
   - **Autonomous Multi-Step Execution (ReAct)**: Capable of multi-hop reasoning (up to `maxHops: 4` across operational tools configured via `ai.multiHopTools` in `config.yaml`), allowing Eira to perform chained searches, read web pages, evaluate intermediate findings, and refine queries autonomously.
   - **Agentic Reflexion Guard & Action Evaluator**: Employs Google Decisions API (`gemini-decision-1`) via `ActionOmissionEvaluator` and `ReflexionGuard` for zero-token binary verification to intercept tool omission / action hallucinations and force self-corrective tool calling.
   - **Automatic Model Failover**: Falls back from the primary model (`gemini-3.1-flash-lite`) to `fallbackModel` (`gemini-3.5-flash-lite`) on quota or transient provider errors to keep turns resilient.
   - **Parallel Execution**: Multiple independent tool calls in a single turn run concurrently using `Promise.all` with per-tool error isolation.
   - **Search & Deep Reading Provider**: Real-time web search via Tavily with DuckDuckGo fallback (`WebSearchService`), deep page reading via `read_url` (`PageFetcher` with Tavily Extractor, HTML cleaning, and SSRF network guard), plus optional Google Search Grounding.
4. **Numerical State-Based Mood Engine**:
   - Emotional state is tracked numerically (0–100%) across four dimensions: `Energy`, `Composure`, `Affection`, and `Playfulness`.
   - Incorporates diurnal time dynamics when inactive, with dynamic updates evaluated semantically via `SemanticMoodEvaluator` based on conversational sentiment.
5. **Hierarchical Memory with Embeddings**:
   - **Working History**: Configurable multi-turn context (default 30 messages) stored in SQLite for conversational continuity.
   - **Core Profile Facts**: Static knowledge about the Owner and Eira permanently injected into prompt context.
   - **Episodic Memory**: Summarized past conversations indexed with `gemini-embedding-001` vectors and retrieved via cosine similarity when relevant topics re-emerge.
6. **Autonomous Task Scheduling & Web Watcher**:
   - **Multi-Mode Scheduling**: Supports one-shot alarms (`once`), daily routines at specific target times (`daily` in Asia/Jakarta), and periodic intervals (`interval` in minutes) with auto-expiration (`durationDays`).
   - **Zero-LLM Webpage Monitoring**: Periodically polls web pages or APIs (`watch_url`), computing SHA-256 hashes without consuming Gemini tokens. Eira only invokes Gemini to alert the user when a real content delta is detected.
   - **Universal Headless Browser SPA Rendering**: Automatically detects client-rendered Single-Page Applications (SPAs like YouTube Live, React/Vue dashboards) via structural DOM heuristics and renders dynamic DOM via on-demand Headless Chromium (`puppeteer-core`) with automatic 30s idle memory teardown and media asset blocking.
   - **Programmatic Anti-Duplication & Cancellation**: Enforces anti-duplication programmatically in SQLite and enables seamless cancellation via `cancel_reminder` by ID or natural search keyword.
   - **Lightweight Auto-Retention**: Completed and cancelled tasks older than 3 days are purged periodically from SQLite.

---

## Tech Stack

- **Runtime**: Node.js `>=22.0.0` (LTS)
- **Language**: TypeScript 5+ (Strict Mode)
- **Primary LLM**: Google Gemini (`gemini-3.1-flash-lite` by default, configurable to `gemini-2.5-flash` / `gemini-2.5-pro`)
- **Decisions & Evaluator LLM**: `gemini-decision-1` via `@google/genai` (v1beta API)
- **Headless Browser**: `puppeteer-core` with system Chromium / Google Chrome
- **Embedding Model**: `gemini-embedding-001` via `@google/genai`
- **Database**: SQLite 3 via `better-sqlite3` & `drizzle-orm`
- **WhatsApp Adapter**: `@whiskeysockets/baileys`
- **Logging**: Structured JSON logging with `pino` & `pino-pretty`

---

## Getting Started

### Prerequisites
- Node.js 22.0.0 or higher
- Google Gemini API Key
- *(Optional)* Tavily API Key for live web search

### Installation

1. **Install Dependencies**:
   ```bash
   npm install
   ```

2. **Configuration**:
   ```bash
   cp config/config.example.yaml config/config.yaml
   cp .env.example .env
   ```
   - Set `GEMINI_API_KEY` in `.env`.
   - Configure owner phone numbers and model parameters in `config/config.yaml`.

3. **Development Mode (Hot Reload)**:
   ```bash
   npm run dev
   ```

4. **Production Build & Execution**:
   ```bash
   npm run build
   npm start
   ```

5. **Docker Deployment**:
   ```bash
   docker compose up -d
   ```

---

## Project Structure

```text
eira-yuki/
├── assets/
│   ├── architecture.svg   # System architecture diagram
│   └── stickers/          # Local sticker library & catalog.json
├── config/
│   ├── config.yaml        # Runtime configuration (models, owners, memory limits)
│   └── system-instruction.txt # Core character persona and behavioural lore
├── src/
│   ├── adapters/          # Channel adapters (WhatsApp via Baileys)
│   ├── config/            # Zod configuration schemas & loader
│   ├── core/              # Headless Core Brain
│   │   ├── agent/         # EiraAgent, ContextAssembler, ExecutionLoop & ReflexionGuard
│   │   ├── browser/       # BrowserManager, PageFetcher, ChromeLocator, HTMLCleaner & NetworkGuard
│   │   ├── evaluator/     # ActionOmissionEvaluator
│   │   ├── gatekeeper/    # PermissionGatekeeper (Owner vs Guest)
│   │   ├── memory/        # MemoryService, MemoryConsolidator & similarity search
│   │   ├── persona/       # PersonaBuilder, MoodService & SemanticMoodEvaluator
│   │   ├── providers/     # Gemini LLM/Decision/Embedding & WebSearch (Tavily/DuckDuckGo)
│   │   ├── scheduler/     # TaskScheduler, TaskService, TaskExecutor & NotificationFormatter
│   │   └── tools/         # ToolRegistry & built-in tools (stickers, search, read_url, reminders, memory, time)
│   ├── database/          # SQLite schema & Drizzle ORM client
│   └── utils/             # Structured logger & sticker catalog resolver
└── tests/                 # 172 unit & integration tests across 21 files (Vitest)
```

---

## Testing

Run the test suite with Vitest:
```bash
npm test
```

---

## License & Intellectual Property

- **Source Code**: Licensed under the [Apache License, Version 2.0](LICENSE).
- **Character Assets & Trademark**: The name **"Eira Yuki"**, persona definitions, prompts, media assets, and visual identity are the proprietary intellectual property of Adli Farizi. Under Section 6 of Apache-2.0, no rights are granted to use the name "Eira Yuki" or character assets for commercial purposes or derivative products without explicit written permission.
