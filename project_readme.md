# Agentic Escalation System (Node.js, TypeScript, LangGraph, Ollama, PostgreSQL)

A resilient, stateful AI agent escalation engine built with **LangGraph**, **TypeScript**, local **Ollama (`llama3.2`)**, and native **PostgreSQL** state persistence.

This project implements deterministic state transitions, durable checkpointing, schema-validated tool calling, and human-in-the-loop (HITL) safety boundaries for customer service escalation workflows.

---

## 1. System Architecture

```
[ Client / Webhook Request ]
            │
            ▼
   ┌──────────────────┐
   │    src/run.ts    │  Entry Point & Checkpointer Initialization
   └────────┬─────────┘
            │
            ▼
   ┌──────────────────┐
   │   src/agent.ts   │  LangGraph StateGraph Engine
   └────────┬─────────┘
            │
   ┌────────┴────────────────────────┬─────────────────────────┐
   │                                 │                         │
   ▼                                 ▼                         ▼
┌──────────────────┐      ┌────────────────────┐      ┌─────────────────────────┐
│  Ollama Daemon   │      │   Tool Registry    │      │  PostgreSQL Checkpointer│
│   (llama3.2)     │      │   (Zod-Validated)  │      │  (Durable State Machine)│
│                  │      │                    │      │                         │
│ HTTP 11434       │      │ lookupOrderTool    │      │ checkpoints             │
│ Native Runners   │      │ checkInventoryTool │      │ checkpoint_blobs        │
│ CPU / Vulkan     │      │ createRefundTool*  │      │ checkpoint_writes       │
└──────────────────┘      └────────────────────┘      └─────────────────────────┘
```

---

## 2. Core Design Principles

1. **Deterministic Control Plane:**
   - Unpredictable LLM outputs are bounded by deterministic graph nodes and conditional routing edges.
   - The agent cannot execute unapproved actions; tools are exposed via strict Zod schemas and bound as a single source of truth.

2. **Durable State Persistence:**
   - Instead of keeping in-memory session arrays, every step ("super-step") commits its serialized state to PostgreSQL using `@langchain/langgraph-checkpoint-postgres`.
   - Node process crashes do not lose execution context; workflows can be paused and resumed across worker nodes via a persistent `thread_id`.

3. **Financial Safety & HITL Guardrails:**
   - Critical operations (such as `create_refund`) avoid **unbounded parameter authority**. Rather than allowing the LLM to invent arbitrary refund amounts, financial values are pulled deterministically from the database/ledger, or paused for operator approval via interrupt boundaries (`interruptBefore`).

---

## 3. Project Structure

```text
agentic-ts-escalation/
├── src/
│   ├── db.ts           # PostgreSQL connection pool (pg.Pool)
│   ├── tools.ts        # Zod-typed tool declarations (Single Source of Truth)
│   ├── agent.ts        # Graph definition, StateGraph compilation, Ollama binding
│   └── run.ts          # Application entry point, checkpointer.setup(), execution
├── package.json        # Dependencies & build scripts
├── tsconfig.json       # Strict TypeScript compiler options (NodeNext resolution)
└── README.md           # System documentation
```

---

## 4. Prerequisites & Environment Setup

### A. System Packages & PostgreSQL
Ensure PostgreSQL is installed and running natively on Ubuntu/Debian:

```bash
sudo apt update
sudo apt install -y postgresql postgresql-contrib

# Verify systemd service status
sudo systemctl status postgresql
```

Configure the database and dedicated user:

```bash
sudo -u postgres psql
```

```sql
CREATE DATABASE agent_db;
CREATE USER agent_admin WITH ENCRYPTED PASSWORD 'mysecretpassword';
GRANT ALL PRIVILEGES ON DATABASE agent_db TO agent_admin;
ALTER DATABASE agent_db OWNER TO agent_admin;
\q
```

### B. Ollama Daemon & Model Runner
Ensure Ollama has both the CLI and companion backend runners (`llama-server`) installed:

```bash
# Install / Repair runner binaries
curl -fsSL https://ollama.com/install.sh | sh
sudo systemctl restart ollama

# Pull llama3.2 directly into the system daemon
curl http://127.0.0.1:11434/api/pull -d '{"name": "llama3.2"}'

# Verify model availability and tool-calling capability
curl http://127.0.0.1:11434/api/tags
```

---

## 5. Installation & Execution

1. **Install Node.js dependencies:**
   ```bash
   npm install
   npm install -D @types/pg
   ```

2. **Run the escalation workflow:**
   ```bash
   npx tsx src/run.ts
   ```

---

## 6. Inspecting State in PostgreSQL (`psql`)

Connect to the PostgreSQL instance to inspect the execution history and checkpoint snapshots:

```bash
psql -U agent_admin -d agent_db -h 127.0.0.1 -W
```

```sql
-- View all checkpoint relations
\dt

-- Query execution thread states
SELECT thread_id, checkpoint_id, parent_checkpoint_id 
FROM checkpoints 
ORDER BY checkpoint_id DESC 
LIMIT 5;

-- Inspect state snapshot for a specific session
SELECT checkpoint 
FROM checkpoints 
WHERE thread_id = 'ticket-101';
```

---

## 7. Key Production Considerations for Interviews

- **Dual-Write Elimination:** Graph state writes and ledger postings should be wrapped in ACID transactions or bridged via the Transactional Outbox pattern.
- **Worker Scaling:** While SQLite is limited to single-instance write locks, PostgreSQL enables multiple stateless Node.js worker containers to coordinate concurrent threads safely.
- **Time-Travel Debugging:** Because checkpoint IDs form an immutable parent-child chain, failed runs can be replayed from the exact checkpoint preceding an error.