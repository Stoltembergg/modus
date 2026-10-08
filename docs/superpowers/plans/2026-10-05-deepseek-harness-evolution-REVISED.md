# Plano de Evolução do Modus Harness — Arquitetura DeepSeek-Inspired (REVISADO)

**Data:** 2026-10-05  
**Versão:** 2.0 — Aprovado com Ajustes  
**Objetivo:** Modularizar o harness do Modus inspirando-se na arquitetura do DeepSeek Harness, tornando-o mais econômico em tokens, silencioso para o usuário, e mantendo seus diferenciais (Meta Controller, Context Engine, Project Model, Memory, HyperPlan, Verifier-First, Failure Intelligence).

## Checklist de Fases

**Revisado em:** 2026-10-07  
**Legenda:** `[x]` conclusão confirmada por relatório de avaliação e evidências de implementação/testes; `[ ]` sem evidência suficiente de conclusão no repositório (pode estar pendente ou em andamento).

### Ciclo 1 — Harness Core & Token Optimization

- [x] Fase 0 — Investigação e Mapeamento ([avaliação](FASE-0-AVALIACAO.md))
- [x] Fase 1 — HarnessKernel e Hook System ([avaliação](FASE-1-AVALIACAO.md), [integração](FASE-1.1-E-2-AVALIACAO.md))
- [x] Fase 2 — PromptRegistry com Seções Change-Driven ([avaliação](FASE-1.1-E-2-AVALIACAO.md))
- [x] Fase 3 — Tool Result Spill com Agent Event Store ([avaliação](FASE-3-AVALIACAO.md))
- [x] Fase 4 — Compaction com Pruning Inteligente ([avaliação](FASE-4-AVALIACAO.md))
- [x] Fase 5 — Repeat Guard Integrado ao Failure Intelligence ([avaliação](FASE-5-AVALIACAO.md))
- [x] Fase 6 — Groups com Mailbox Durável ([avaliação](FASE-6-AVALIACAO.md))
- [x] Fase 7 — ResponsePolicy Silenciosa ([avaliação](FASE-7-AVALIACAO.md))
- [x] Fase 8 — Integração e Validação ([avaliação](FASE-8-AVALIACAO.md))

### Ciclo 2 — Plugin System & Plataforma Extensível

- [x] Fase 9 — Capability Registry + Provenance ([avaliação](FASE-9-AVALIACAO.md))
- [x] Fase 10 — Modus Internal Plugins (10A: Piloto / 10B: Migração) ([avaliação](FASE-10-AVALIACAO.md))
- [x] Fase 11 — Plugin Lifecycle ([avaliação](FASE-11-AVALIACAO.md))
- [x] Fase 12 — Plugin Tracing & Observability ([avaliação](FASE-12-AVALIACAO.md))
- [x] Fase 13 — Isolamento e Segurança ([avaliação](FASE-13-AVALIACAO.md))
- [x] Fase 14 — Dependency Intelligence & Graph ([avaliação](FASE-14-AVALIACAO.md))
- [x] Fase 15 — Rollback e Safe Mode ([avaliação](FASE-15-AVALIACAO.md))
- [ ] Fase 16 — Plugin SDK Público
- [ ] Fase 17 — Marketplace
- [ ] Fase 18 — Harness Marketplace
- [x] Fase 19 — High-Performance Sandboxing (WASM & Micro-VMs) ([avaliação](FASE-19-AVALIACAO.md))
- [ ] Fase 20 — Federated Capabilities & Multi-Agent Mesh
- [ ] Fase 21 — Autonomous JIT Capabilities (Self-Synthesized Plugins)
- [ ] Fase 22 — Enterprise Governance & Policy-as-Code (OPA/Rego)

### Ciclo de UI Extensível

- [ ] Fase 23 — UI Contribution Foundation
- [ ] Fase 24 — Slot Expansion & Shell Integration
- [ ] Fase 25 — UI Safety & Isolation
- [ ] Fase 26 — Contextual Adaptive UI
- [ ] Fase 27 — Observability & Debugging
- [ ] Fase 28 — Safe Mode & Rollback Integration
- [ ] Fase 29 — Dynamic/JIT UI (Declarative Phase 1)

## Princípios Fundamentais

1. **Reusar infraestrutura existente** antes de criar nova
2. **Agent Event Store é fonte durável** para tudo que foi model-visible
3. **Qualidade > economia de tokens** — completude, ausência de loops e preservação de evidências têm prioridade
4. **Reconstrução determinística** sobre persistência de estado transitório
5. **Change-driven** sobre eager reenvio
6. **Observabilidade experimental** sobre métricas como metas rígidas
7. **Backward compatibility** por meio de eventos versionados ou projeções compatíveis
8. **Modus trabalha extensivamente internamente, apresenta ao usuário apenas o resultado necessário**

---

## Fase 0: Investigação e Mapeamento (OBRIGATÓRIA)

### Objetivo
Mapear infraestrutura existente e dependências externas antes de desenhar implementação.

### 0.1 — Análise Profunda do PI SDK

**Arquivo de saída:** `docs/architecture/pi-sdk-integration-analysis.md`

**Investigar:**
1. **Compaction ownership:**
   - Quem dispara: PI SDK ou Modus?
   - Triggers: threshold, overflow, manual?
   - `compaction.ended` event: formato, campos, quando emitido?
   - Auto-continue: quem implementa? Bound? (MAX_THRESHOLD_CONTINUES=2)
   - Limites: context window por modelo, output reserve, headroom
   - Hooks disponíveis: pre-compaction? post-compaction?

2. **SessionManager e SettingsManager:**
   - `compaction.enabled`: pode ser desabilitado?
   - Configurações expostas: thresholds, preserveCategories?
   - Extensibility: custom compaction strategies?

3. **Tool execution lifecycle:**
   - `tool.started`, `tool.delta`, `tool.ended`
   - Quando tool args/result são enviados ao modelo?
   - Streaming: args crescem via deltas?
   - TOOL_DELTA_THROTTLE_MS=100: onde aplicado?

4. **Context building:**
   - Como PI SDK monta prompt system?
   - Aceita seções estruturadas ou string monolítica?
   - Suporta incremental updates?

**Decisões necessárias:**
- [ ] Compaction permanece 100% no PI SDK, ou Modus assume?
- [ ] Pruning é pre-hook do PI SDK compaction, ou substitui?
- [ ] Tool result spill é transparente ao PI SDK, ou requer integração?

**Critério de aprovação:** Documento completo revisado, decisões tomadas, POC de integração funcional.

---

### 0.2 — Inventário de Stores Existentes

**Arquivo de saída:** `docs/architecture/modus-persistent-stores-inventory.md`

**Mapear:**

1. **agent-event-store:**
   - Schema: `agent_events(id, session_id, payload_json, created_at, event_cursor)`
   - Tipos de eventos armazenados
   - Queries disponíveis: `listAgentEvents`, `getRunToolEvidence`, `getSessionCodeGraphDiscoveries`
   - Bounded vs unbounded queries
   - Performance: quantos eventos por sessão típica? Índices?

2. **agent-run-store:**
   - Schema: runs, token usage, status
   - Lifecycle: created → active → completed/failed
   - Queries: `getActiveAgentRun`, `listAgentRuns`

3. **agent-store:**
   - Schema: sessions, metadata, worktree, status
   - Queries: `getAgentSession`, `listSubagentSessions`

4. **plan-store:**
   - Schema: plans, todos, spec metadata
   - Persistence: filesystem (plans/) + metadata em SQLite?
   - Queries: `readPlanById`, `setPlanBuildStatusById`

5. **project-memory-service:**
   - Schema: memories, evidence, verifications
   - Queries: `getProjectMemoriesForPlanning`, `getProjectMemorySessionSummaries`

6. **checkpoint-service:**
   - Schema: checkpoints, git snapshots
   - Queries: `getLatestCheckpointRestoreRowId`

7. **harness/task-state:**
   - Schema: task states, criteria, evidence refs
   - Queries: evidências vinculadas a runs

8. **harness/project-model-store:**
   - Schema: `project_model_edges` (discoveries, changes, dependencies)
   - Queries: `estimateProjectImpactWithStore`

9. **harness/failure-intelligence:**
   - Schema: failure attempts, blacklist
   - Queries: `listAvoidedStrategyCodesFromBlacklist`

**Identificar gaps:**
- Qual store pode armazenar spilled tool results?
- Onde mailbox de Groups deve persistir?
- Fingerprints de prompt sections: necessário persistir ou reconstruir?

**Critério de aprovação:** Inventário completo, gaps identificados, stores mapeadas para features do plano.

---

### 0.3 — Validação de Assumptions

**Testar empiricamente:**

1. **Token economy baseline:**
   - Instrumentar 10 sessões reais
   - Medir: prompt tokens, tool result tokens, compaction frequency, response tokens
   - Identificar: top 10 fontes de tokens (skills? rules? tool results?)

2. **Compaction triggers:**
   - Em 100 turns, quantos disparam compaction?
   - Razões: threshold (85%)? overflow? manual?
   - Após compaction: quanto contexto foi removido?

3. **Tool result sizes:**
   - Top 10 tools por tamanho de output
   - Distribuição: 90% dos results < 8KB? 5% > 100KB?
   - Quais tools se beneficiam de spill?

4. **Prompt sections stability:**
   - Em uma sessão de 20 turns, quantas vezes mudam: persona? rules? skills? memory? context?
   - Há seções que nunca mudam?

**Critério de aprovação:** Dados coletados, oportunidades de economia validadas, features priorizadas por impacto real.

---

## Fase 1: HarnessKernel e Hook System

### Objetivo
Modularizar `pi-sdk-runtime.ts` via hooks, sem quebrar funcionalidade existente.

### 1.1 — Definir Hook Contract

**Arquivo:** [`harness/kernel/harness-hooks.ts`](apps/desktop/src/main/agent/harness/kernel/harness-hooks.ts)

```typescript
export type HarnessPhase =
  | "turn_start"        // Intent Gate, classification
  | "context_resolve"   // Context Engine, memory retrieval
  | "prompt_build"      // System prompt assembly
  | "model_select"      // Model, thinking variant
  | "tools_register"    // Tool registry, permissions
  | "pre_execution"     // Checkpoint, adaptive spawn
  | "post_execution"    // QA evidence, verification
  | "turn_settle";      // Continuation, memory finalization

export type HookPriority = number; // 0-1000, lower = earlier

export type HookResult<T> =
  | { status: "success"; data: T }
  | { status: "skip"; reason: string }
  | { status: "error"; error: Error };

export type HarnessHook<TInput, TOutput> = {
  name: string;
  phase: HarnessPhase;
  priority: HookPriority;
  blocking: boolean;  // true = failure aborts phase, false = best-effort
  dependencies: string[];  // Hook names this depends on
  execute: (input: TInput, context: HarnessContext) => Promise<HookResult<TOutput>>;
};

export type HarnessContext = {
  sessionId: string;
  runId: string;
  workspaceId: string;
  mode: "build" | "plan" | "spec";
  state: Map<string, unknown>;  // Shared state between hooks
};
```

**Ordem de execução explícita:**
1. Ordenar hooks por `priority` (ascending)
2. Resolver `dependencies`: DAG topological sort
3. Executar hooks em ordem:
   - `blocking=true` + error → abort phase
   - `blocking=false` + error → log warning, continue
   - `status=skip` → não executar hooks que dependem dele

**Timeout:**
- Por hook: 30s (configurável via `HARNESS_HOOK_TIMEOUT_MS`)
- Por phase: 5min

---

### 1.2 — Implementar HarnessKernel

**Arquivo:** [`harness/kernel/harness-kernel.ts`](apps/desktop/src/main/agent/harness/kernel/harness-kernel.ts)

```typescript
export class HarnessKernel {
  private hooks: Map<HarnessPhase, HarnessHook<any, any>[]> = new Map();
  private observer: HarnessObserver;

  registerHook<TInput, TOutput>(hook: HarnessHook<TInput, TOutput>): void {
    const phaseHooks = this.hooks.get(hook.phase) ?? [];
    phaseHooks.push(hook);
    this.hooks.set(hook.phase, phaseHooks);
  }

  async executePhase<TInput, TOutput>(
    phase: HarnessPhase,
    input: TInput,
    context: HarnessContext
  ): Promise<Map<string, HookResult<TOutput>>> {
    const phaseHooks = this.hooks.get(phase) ?? [];
    const sorted = this.resolveDependencies(phaseHooks);
    const results = new Map<string, HookResult<TOutput>>();

    for (const hook of sorted) {
      const startTime = Date.now();
      try {
        const result = await this.executeWithTimeout(hook, input, context);
        results.set(hook.name, result);
        
        this.observer.recordHookExecution({
          phase,
          hookName: hook.name,
          durationMs: Date.now() - startTime,
          status: result.status,
        });

        if (hook.blocking && result.status === "error") {
          throw new Error(`Blocking hook ${hook.name} failed: ${result.error.message}`);
        }
      } catch (error) {
        if (hook.blocking) throw error;
        console.warn(`[modus] Non-blocking hook ${hook.name} failed:`, error);
      }
    }

    return results;
  }

  private resolveDependencies<T>(hooks: HarnessHook<any, T>[]): HarnessHook<any, T>[] {
    // Topological sort + priority
    const sorted: HarnessHook<any, T>[] = [];
    const visited = new Set<string>();
    const visiting = new Set<string>();

    const visit = (hook: HarnessHook<any, T>) => {
      if (visited.has(hook.name)) return;
      if (visiting.has(hook.name)) {
        throw new Error(`Circular dependency detected: ${hook.name}`);
      }

      visiting.add(hook.name);
      for (const depName of hook.dependencies) {
        const dep = hooks.find(h => h.name === depName);
        if (dep) visit(dep);
      }
      visiting.delete(hook.name);
      visited.add(hook.name);
      sorted.push(hook);
    };

    for (const hook of hooks) visit(hook);
    return sorted.sort((a, b) => a.priority - b.priority);
  }

  private async executeWithTimeout<T>(
    hook: HarnessHook<any, T>,
    input: any,
    context: HarnessContext
  ): Promise<HookResult<T>> {
    const timeout = process.env.HARNESS_HOOK_TIMEOUT_MS 
      ? Number.parseInt(process.env.HARNESS_HOOK_TIMEOUT_MS) 
      : 30_000;

    return Promise.race([
      hook.execute(input, context),
      new Promise<HookResult<T>>((_, reject) =>
        setTimeout(() => reject(new Error(`Hook ${hook.name} timeout after ${timeout}ms`)), timeout)
      ),
    ]);
  }
}
```

---

### 1.3 — Refatorar pi-sdk-runtime.ts Incrementalmente

**Estratégia:**
1. Extrair lógica existente para hooks individuais
2. Registrar hooks no kernel
3. Chamar `kernel.executePhase()` paralelamente à lógica legacy
4. Comparar resultados (assertion em dev, log em prod)
5. Após validação, remover caminho legacy

**Feature flag:**
```typescript
const USE_HARNESS_KERNEL = process.env.MODUS_USE_KERNEL === "true";
```

**Exemplo de refatoração (Intent Gate):**
```typescript
// ANTES (pi-sdk-runtime.ts)
async promptAgent(input: PromptAgentInput): Promise<PromptTurnResult> {
  const gateResult = await evaluateIntentGate(...);
  if (gateResult.action !== "proceed") {
    return { status: "blocked", reason: gateResult };
  }
  // ...
}

// DEPOIS
async promptAgent(input: PromptAgentInput): Promise<PromptTurnResult> {
  const context = this.createHarnessContext(input);
  
  if (USE_HARNESS_KERNEL) {
    const results = await this.kernel.executePhase("turn_start", input, context);
    const intentGateResult = results.get("intent_gate");
    if (intentGateResult?.status === "success" && intentGateResult.data.action !== "proceed") {
      return { status: "blocked", reason: intentGateResult.data };
    }
  } else {
    // Legacy path (será removido após validação)
    const gateResult = await evaluateIntentGate(...);
    if (gateResult.action !== "proceed") {
      return { status: "blocked", reason: gateResult };
    }
  }
  // ...
}
```

**Hooks a criar na Fase 1:**
- `intent_gate_hook` (turn_start, priority=100, blocking=true)
- `task_classification_hook` (turn_start, priority=200, blocking=false)
- `context_memory_hook` (context_resolve, priority=100, blocking=false)
- `checkpoint_hook` (pre_execution, priority=100, blocking=false)

**Validação:**
- Testes unitários de cada hook isoladamente
- Testes de integração com kernel
- Comparação de resultados: kernel vs legacy

---

## Fase 2: PromptRegistry com Seções Change-Driven

### Objetivo
Enviar ao modelo apenas seções do prompt que mudaram desde o último turn, economizando tokens em seções estáveis (persona, rules, skills).

### 2.1 — Design de PromptSection

**Princípio:** Reconstrução determinística > persistência de fingerprints.

**Arquivo:** [`harness/prompt/prompt-section.ts`](apps/desktop/src/main/agent/harness/prompt/prompt-section.ts)

```typescript
export interface PromptSection {
  id: string;
  priority: number;
  volatile: boolean;  // true = sempre reenvia
  buildContent(context: HarnessContext): Promise<string>;
  getFingerprint(context: HarnessContext): string;  // Deterministic hash
}

export abstract class BasePromptSection implements PromptSection {
  abstract id: string;
  abstract priority: number;
  abstract volatile: boolean;
  abstract buildContent(context: HarnessContext): Promise<string>;

  getFingerprint(context: HarnessContext): string {
    // Default: hash do conteúdo
    const content = this.buildContentSync(context);
    return createHash("sha256").update(content, "utf8").digest("hex").slice(0, 16);
  }

  protected buildContentSync(context: HarnessContext): string {
    // Síntese síncrona para fingerprint (sem I/O)
    // Ex: persona section sempre retorna mesmo hash
    throw new Error("Must implement buildContentSync or override getFingerprint");
  }
}
```

**Seções:**
1. **PersonaSection** (priority=100, volatile=false)
   - Conteúdo: RESPONSE_FORMAT_BASE, identidade do agente
   - Fingerprint: hash fixo (nunca muda)

2. **RulesSection** (priority=200, volatile=false)
   - Conteúdo: safety_guardrails, coding_questions, git_safety
   - Fingerprint: hash do conteúdo + versão

3. **SkillsSection** (priority=300, volatile=false)
   - Conteúdo: skills disponíveis, MCP servers
   - Fingerprint: hash(skillNames + mcpServerIds)
   - Muda quando: skill adicionado, MCP server conectado

4. **MemorySection** (priority=400, volatile=true)
   - Conteúdo: Project Memory hints do turn atual
   - Sempre reenvia (hints mudam por turn)

5. **GroupsSection** (priority=500, volatile=true)
   - Conteúdo: roster de agents, mailbox status
   - Sempre reenvia (roster dinâmico)

6. **ContextSection** (priority=600, volatile=true)
   - Conteúdo: context items do turn (files, diffs, terminal)
   - Sempre reenvia (contexto por turn)

7. **PolicySection** (priority=700, volatile=false)
   - Conteúdo: Response Policy do nível atual
   - Fingerprint: hash(level + mode)
   - Muda quando: usuário altera nível ou mode muda

---

### 2.2 — PromptRegistry com Change Detection

**Arquivo:** [`harness/prompt/prompt-registry.ts`](apps/desktop/src/main/agent/harness/prompt/prompt-registry.ts)

```typescript
export class PromptRegistry {
  private sections: Map<string, PromptSection> = new Map();
  // In-memory, reconstruído a cada sessão
  private lastSentFingerprints: Map<string, Map<string, string>> = new Map(); // sessionId -> sectionId -> fingerprint

  registerSection(section: PromptSection): void {
    this.sections.set(section.id, section);
  }

  async buildPrompt(
    sessionId: string,
    context: HarnessContext,
    full: boolean = false
  ): Promise<{ prompt: string; sectionsIncluded: string[] }> {
    const sortedSections = [...this.sections.values()].sort((a, b) => a.priority - b.priority);
    const sessionFingerprints = this.lastSentFingerprints.get(sessionId) ?? new Map();
    
    const parts: string[] = [];
    const included: string[] = [];

    for (const section of sortedSections) {
      const fingerprint = section.getFingerprint(context);
      const lastSent = sessionFingerprints.get(section.id);

      const shouldInclude = full || section.volatile || fingerprint !== lastSent;

      if (shouldInclude) {
        const content = await section.buildContent(context);
        if (content) {
          parts.push(content);
          included.push(section.id);
          sessionFingerprints.set(section.id, fingerprint);
        }
      }
    }

    this.lastSentFingerprints.set(sessionId, sessionFingerprints);

    return {
      prompt: parts.join("\n\n"),
      sectionsIncluded: included,
    };
  }

  invalidateSession(sessionId: string): void {
    // Após compaction ou restart, forçar full prompt
    this.lastSentFingerprints.delete(sessionId);
  }
}
```

**Tratamento de restart:**
- `lastSentFingerprints` é in-memory
- Após restart: primeiro turn envia full prompt (todas as seções)
- Turnos subsequentes: apenas seções que mudaram

**Economia esperada:**
- Turn 1: 8000 tokens (full prompt)
- Turn 2-N: 2000-3000 tokens (apenas volatile sections)
- Após compaction: 8000 tokens (full rebuild)

**Trade-off aceito:** Primeiro turn pós-restart paga custo completo.

---

### 2.3 — Integração com pi-sdk-runtime

**Hook:** `prompt_build_hook`

```typescript
const promptBuildHook: HarnessHook<PromptBuildInput, PromptBuildOutput> = {
  name: "prompt_build",
  phase: "prompt_build",
  priority: 100,
  blocking: true,
  dependencies: ["context_resolve"],
  async execute(input, context) {
    const { prompt, sectionsIncluded } = await promptRegistry.buildPrompt(
      context.sessionId,
      context,
      input.forceFullPrompt
    );

    observer.recordPromptSections(sectionsIncluded, [
      ...promptRegistry.getSectionIds()
    ].filter(id => !sectionsIncluded.includes(id)));

    return {
      status: "success",
      data: { systemPrompt: prompt, sectionsIncluded },
    };
  },
};
```

---

## Fase 3: Tool Result Spill com Agent Event Store

### Objetivo
Armazenar tool results grandes no Agent Event Store e enviar apenas preview ao modelo.

### 3.1 — Tool Result Policy

**Arquivo:** [`harness/tools/tool-result-policy.ts`](apps/desktop/src/main/agent/harness/tools/tool-result-policy.ts)

```typescript
export type ToolResultPolicy = {
  spillThresholdBytes: number;    // Default: 16384 (16KB)
  previewHeadLines: number;        // Default: 50
  previewTailLines: number;        // Default: 50
};

export const DEFAULT_TOOL_RESULT_POLICY: ToolResultPolicy = {
  spillThresholdBytes: 16_384,
  previewHeadLines: 50,
  previewTailLines: 50,
};

export function shouldSpillResult(result: string, policy: ToolResultPolicy): boolean {
  return Buffer.byteLength(result, "utf8") > policy.spillThresholdBytes;
}

export function generatePreview(
  fullContent: string,
  policy: ToolResultPolicy
): { preview: string; omittedLines: number; totalLines: number } {
  const lines = fullContent.split("\n");
  const totalLines = lines.length;

  const maxPreviewLines = policy.previewHeadLines + policy.previewTailLines;
  if (totalLines <= maxPreviewLines) {
    return { preview: fullContent, omittedLines: 0, totalLines };
  }

  const head = lines.slice(0, policy.previewHeadLines).join("\n");
  const tail = lines.slice(-policy.previewTailLines).join("\n");
  const omittedLines = totalLines - maxPreviewLines;

  const preview = `${head}\n\n[... ${omittedLines} lines omitted ...]\n\n${tail}`;

  return { preview, omittedLines, totalLines };
}
```

---

### 3.2 — Persistência via Agent Event Store

**Decisão:** Reusar `agent_events` existente com novo tipo de evento.

**Novo tipo de evento:**
```typescript
export type SpilledToolResultEvent = {
  type: "tool.result.spilled";
  id: string;
  sessionId: string;
  runId: string;
  toolEventId: string;  // FK para tool.ended event
  toolName: string;
  fullContent: string;  // Armazenado aqui
  contentHash: string;
  sizeBytes: number;
  totalLines: number;
  spilledAt: string;
};
```

**Modificação em `tool.ended`:**
```typescript
export type ToolEndedEvent = {
  type: "tool.ended";
  tool: string;
  result: string;  // Preview se spilled, full caso contrário
  isSpilled?: boolean;  // V2: indica se result é preview
  spillId?: string;     // V2: ID do evento spilled
  resultSizeBytes?: number;  // V2: tamanho real do resultado
};
```

**Storage:**
```typescript
// harness/tools/tool-result-storage.ts
export function spillToolResult(input: {
  sessionId: string;
  runId: string;
  toolEventId: string;
  toolName: string;
  fullContent: string;
}): string {
  const spillId = randomUUID();
  const contentHash = createHash("sha256").update(input.fullContent, "utf8").digest("hex").slice(0, 16);
  
  const spillEvent: SpilledToolResultEvent = {
    type: "tool.result.spilled",
    id: spillId,
    sessionId: input.sessionId,
    runId: input.runId,
    toolEventId: input.toolEventId,
    toolName: input.toolName,
    fullContent: input.fullContent,
    contentHash,
    sizeBytes: Buffer.byteLength(input.fullContent, "utf8"),
    totalLines: input.fullContent.split("\n").length,
    spilledAt: new Date().toISOString(),
  };

  recordAgentEvent(input.sessionId, spillEvent);

  return spillId;
}

export function retrieveSpilledResult(spillId: string): string | undefined {
  // Query agent_events onde id = spillId e type = "tool.result.spilled"
  const events = listAgentEvents(/* sessionId needed */);
  const spillEvent = events.find(e => e.id === spillId && e.type === "tool.result.spilled");
  
  if (!spillEvent || spillEvent.type !== "tool.result.spilled") {
    return undefined;
  }

  return spillEvent.fullContent;
}
```

**Lifecycle:**
- Spilled results são agent events normais
- Cleanup: quando sessão é deletada, eventos são cascadeados
- Compaction: spilled events são preservados (categoria de evidência)

---

### 3.3 — Integração com Tool Registry

**Modificação em `tool.ended` handler:**

```typescript
// pi-event-normalizer.ts
function normalizeToolEnded(piEvent: PiToolEndedEvent): AgentEvent {
  const result = piEvent.result?.toString() ?? "";
  const policy = DEFAULT_TOOL_RESULT_POLICY;

  if (shouldSpillResult(result, policy)) {
    const spillId = spillToolResult({
      sessionId: currentSessionId,
      runId: currentRunId,
      toolEventId: piEvent.id,
      toolName: piEvent.tool,
      fullContent: result,
    });

    const { preview, omittedLines, totalLines } = generatePreview(result, policy);

    return {
      type: "tool.ended",
      tool: piEvent.tool,
      result: preview,
      isSpilled: true,
      spillId,
      resultSizeBytes: Buffer.byteLength(result, "utf8"),
      totalLines,
      // ... outros campos
    };
  }

  return {
    type: "tool.ended",
    tool: piEvent.tool,
    result,
    // ... outros campos
  };
}
```

**Retrieve tool:**
```typescript
// tools/spill-tools.ts
registerToolFunction(registry, profile, {
  name: "retrieve_spilled_tool_result",
  description: "Retrieve the full content of a spilled tool result by its spillId",
  parameters: z.object({
    spillId: z.string().describe("The spill ID from a previous tool result"),
  }),
  execute: async ({ spillId }) => {
    const fullContent = retrieveSpilledResult(spillId);
    if (!fullContent) {
      return "Spilled result not found or expired";
    }
    return fullContent;
  },
});
```

**Backward compatibility:**
- Agent events antigos sem `isSpilled` são tratados como full content
- Código que lê `result` funciona sem modificação
- `spillId` opcional permite evolução gradual

---

## Fase 4: Compaction com Pruning Inteligente

### Objetivo
Remover tool results, logs e buscas redundantes antes de disparar compaction do PI SDK, reduzindo frequência de compaction.

### 4.1 — Decisão de Ownership (baseada em Fase 0)

**Cenário A: PI SDK expõe pre-compaction hook**
- Implementar pruning como hook
- PI SDK compaction continua responsável por summarization
- Modus apenas remove redundância antes

**Cenário B: PI SDK não expõe hooks**
- Implementar pruning como transformation layer
- Aplicar pruning no `agent_events` antes de PI SDK ler contexto
- Marcar eventos como "pruned" sem deletar (soft delete)

**Cenário C: PI SDK compaction é inadequado**
- Avaliar substituir compaction do PI SDK completamente
- Requires: fork ou reimplementação (alto risco)

**Escolha após Fase 0.**

---

### 4.2 — Compaction Pruner

**Arquivo:** [`harness/compaction/compaction-pruner.ts`](apps/desktop/src/main/agent/harness/compaction/compaction-pruner.ts)

```typescript
export type PruneCandidate = {
  eventId: string;
  type: "tool_result" | "log" | "search" | "read";
  sizeBytes: number;
  referenced: boolean;  // Citado em decisões, evidências, plano?
  mutable: boolean;     // Evento pode ser modificado/removido?
};

export type PruneStrategy =
  | "remove_unreferenced_logs"
  | "remove_duplicate_searches"
  | "remove_unreferenced_reads"
  | "replace_large_tool_results_with_preview";

export type PruneResult = {
  strategy: PruneStrategy;
  prunedEventIds: string[];
  savedBytes: number;
  savedTokens: number;  // Estimado
};

export async function identifyPruneCandidates(
  sessionId: string,
  runId: string
): Promise<PruneCandidate[]> {
  const events = listAgentEvents(sessionId, runId);
  const candidates: PruneCandidate[] = [];

  // Identificar eventos referenciados
  const referenced = new Set<string>();
  for (const event of events) {
    if (event.type === "harness.decision" && event.evidenceEventIds) {
      event.evidenceEventIds.forEach(id => referenced.add(id));
    }
    if (event.type === "qa.evidence" && event.evidenceRefs) {
      event.evidenceRefs.forEach(ref => referenced.add(ref.eventId));
    }
    // ... outros tipos que referenciam eventos
  }

  for (const event of events) {
    if (event.type === "tool.ended" && event.tool === "bash") {
      // Logs bash não referenciados
      if (!referenced.has(event.id)) {
        candidates.push({
          eventId: event.id,
          type: "log",
          sizeBytes: Buffer.byteLength(event.result, "utf8"),
          referenced: false,
          mutable: true,
        });
      }
    }

    if (event.type === "tool.ended" && (event.tool === "grep" || event.tool === "glob")) {
      // Buscas redundantes (mesmo tool + args)
      const duplicate = events.some(e =>
        e.id !== event.id &&
        e.type === "tool.ended" &&
        e.tool === event.tool &&
        JSON.stringify(e.args) === JSON.stringify(event.args)
      );
      if (duplicate && !referenced.has(event.id)) {
        candidates.push({
          eventId: event.id,
          type: "search",
          sizeBytes: Buffer.byteLength(event.result, "utf8"),
          referenced: false,
          mutable: true,
        });
      }
    }

    if (event.type === "tool.ended" && event.tool === "read") {
      // Reads não seguidos de edit
      const fileEdited = events.some(e =>
        e.type === "tool.ended" &&
        (e.tool === "edit" || e.tool === "write") &&
        e.args?.file_path === event.args?.file_path
      );
      if (!fileEdited && !referenced.has(event.id)) {
        candidates.push({
          eventId: event.id,
          type: "read",
          sizeBytes: Buffer.byteLength(event.result, "utf8"),
          referenced: false,
          mutable: true,
        });
      }
    }

    if (event.type === "tool.ended" && event.isSpilled === false && event.resultSizeBytes > 16384) {
      // Tool results grandes que ainda não foram spilled
      candidates.push({
        eventId: event.id,
        type: "tool_result",
        sizeBytes: event.resultSizeBytes,
        referenced: referenced.has(event.id),
        mutable: !referenced.has(event.id),
      });
    }
  }

  return candidates;
}

export async function pruneBeforeCompaction(
  sessionId: string,
  runId: string,
  targetBytes: number
): Promise<PruneResult[]> {
  const candidates = await identifyPruneCandidates(sessionId, runId);
  const results: PruneResult[] = [];
  
  let prunedBytes = 0;

  // Estratégia 1: Remover logs não referenciados
  const logs = candidates.filter(c => c.type === "log" && !c.referenced);
  if (prunedBytes < targetBytes && logs.length > 0) {
    const pruned = logs.map(c => c.eventId);
    const saved = logs.reduce((sum, c) => sum + c.sizeBytes, 0);
    // Marcar eventos como pruned (soft delete)
    await markEventsPruned(sessionId, pruned);
    results.push({
      strategy: "remove_unreferenced_logs",
      prunedEventIds: pruned,
      savedBytes: saved,
      savedTokens: Math.floor(saved / 4), // Estimativa: 1 token ≈ 4 bytes
    });
    prunedBytes += saved;
  }

  // Estratégia 2: Remover buscas duplicadas
  const searches = candidates.filter(c => c.type === "search" && !c.referenced);
  if (prunedBytes < targetBytes && searches.length > 0) {
    const pruned = searches.map(c => c.eventId);
    const saved = searches.reduce((sum, c) => sum + c.sizeBytes, 0);
    await markEventsPruned(sessionId, pruned);
    results.push({
      strategy: "remove_duplicate_searches",
      prunedEventIds: pruned,
      savedBytes: saved,
      savedTokens: Math.floor(saved / 4),
    });
    prunedBytes += saved;
  }

  // Estratégia 3: Remover reads não referenciados
  const reads = candidates.filter(c => c.type === "read" && !c.referenced);
  if (prunedBytes < targetBytes && reads.length > 0) {
    const pruned = reads.map(c => c.eventId);
    const saved = reads.reduce((sum, c) => sum + c.sizeBytes, 0);
    await markEventsPruned(sessionId, pruned);
    results.push({
      strategy: "remove_unreferenced_reads",
      prunedEventIds: pruned,
      savedBytes: saved,
      savedTokens: Math.floor(saved / 4),
    });
    prunedBytes += saved;
  }

  // Estratégia 4: Spill tool results grandes ainda não spilled
  const largeResults = candidates.filter(c => c.type === "tool_result" && c.mutable);
  if (prunedBytes < targetBytes && largeResults.length > 0) {
    const pruned: string[] = [];
    let saved = 0;
    for (const candidate of largeResults) {
      // Aplicar spill retroativamente
      const event = getAgentEvent(sessionId, candidate.eventId);
      if (event?.type === "tool.ended") {
        const spillId = spillToolResult({
          sessionId,
          runId,
          toolEventId: event.id,
          toolName: event.tool,
          fullContent: event.result,
        });
        const { preview } = generatePreview(event.result, DEFAULT_TOOL_RESULT_POLICY);
        await updateAgentEvent(sessionId, candidate.eventId, {
          result: preview,
          isSpilled: true,
          spillId,
        });
        pruned.push(candidate.eventId);
        saved += candidate.sizeBytes - Buffer.byteLength(preview, "utf8");
        if (prunedBytes + saved >= targetBytes) break;
      }
    }
    if (pruned.length > 0) {
      results.push({
        strategy: "replace_large_tool_results_with_preview",
        prunedEventIds: pruned,
        savedBytes: saved,
        savedTokens: Math.floor(saved / 4),
      });
      prunedBytes += saved;
    }
  }

  return results;
}

async function markEventsPruned(sessionId: string, eventIds: string[]): Promise<void> {
  // Soft delete: adicionar flag __pruned aos eventos
  // Não remove do DB, mas exclui de listAgentEvents
  for (const eventId of eventIds) {
    await updateAgentEvent(sessionId, eventId, { __pruned: true });
  }
}
```

**Preservação de evidências:**
- Eventos referenciados por `harness.decision`, `qa.evidence`, `plan.created` nunca são prunados
- Checkpoints nunca são prunados
- Failure attempts preservados (categoria de evidência)

---

### 4.3 — Integração com PI SDK Compaction

**Hook: pre_compaction (se PI SDK expõe)**

```typescript
const preCompactionHook: HarnessHook<CompactionInput, CompactionOutput> = {
  name: "pre_compaction_pruning",
  phase: "compaction",  // Novo phase
  priority: 100,
  blocking: false,  // Best-effort
  dependencies: [],
  async execute(input, context) {
    const currentTokens = input.currentTokens;
    const threshold = input.policy.contextWindow * input.policy.thresholdRatio;
    const target = Math.max(0, currentTokens - threshold);

    if (target <= 0) {
      return { status: "skip", reason: "No pruning needed" };
    }

    const pruneResults = await pruneBeforeCompaction(
      context.sessionId,
      context.runId,
      target
    );

    const totalSaved = pruneResults.reduce((sum, r) => sum + r.savedTokens, 0);

    observer.recordCompactionPruning(pruneResults.length, totalSaved);

    return {
      status: "success",
      data: { pruneResults, savedTokens: totalSaved },
    };
  },
};
```

**Se PI SDK não expõe hooks:**
- Monitorar `compaction.ended` event
- Aplicar pruning retroativamente após cada compaction
- Menos eficiente, mas evita fork do PI SDK

---

## Fase 5: Repeat Guard Integrado ao Failure Intelligence

### Objetivo
Detectar ferramentas repetidas, hipóteses repetidas e ausência de progresso, integrando ao sistema existente de Failure Intelligence.

### 5.1 — Repeat Detection

**Arquivo:** [`harness/failure-intelligence-repeat.ts`](apps/desktop/src/main/agent/harness/failure-intelligence-repeat.ts)

```typescript
export type ToolInvocationPattern = {
  toolName: string;
  argsFingerprint: string;
  resultFingerprint: string;
  errorFingerprint?: string;
  timestamp: number;
};

export type RepeatSignal =
  | { type: "repeat_tool"; toolName: string; count: number; identical: boolean }
  | { type: "repeat_hypothesis"; signature: string; count: number }
  | { type: "no_progress"; evidence: string[] };

export function detectRepeatTools(
  events: AgentEvent[],
  windowMs: number = 300_000  // DeepSeek ref: 5min
): RepeatSignal[] {
  const now = Date.now();
  const patterns: Map<string, ToolInvocationPattern[]> = new Map();

  for (const event of events) {
    if (event.type !== "tool.ended") continue;
    const timestamp = new Date(event.createdAt).getTime();
    if (now - timestamp > windowMs) continue;

    const key = event.tool;
    const argsFingerprint = hashContent(JSON.stringify(event.args));
    const resultFingerprint = hashContent(event.result.slice(0, 1000)); // Sample
    const errorFingerprint = event.isError ? hashContent(event.result) : undefined;

    const pattern: ToolInvocationPattern = {
      toolName: event.tool,
      argsFingerprint,
      resultFingerprint,
      errorFingerprint,
      timestamp,
    };

    if (!patterns.has(key)) patterns.set(key, []);
    patterns.get(key)!.push(pattern);
  }

  const signals: RepeatSignal[] = [];

  for (const [toolName, invocations] of patterns) {
    if (invocations.length < 3) continue; // DeepSeek ref: 3+ repetitions

    // Detectar repetições idênticas (args + result)
    const uniqueFingerprints = new Set(
      invocations.map(i => `${i.argsFingerprint}:${i.resultFingerprint}`)
    );
    const identical = uniqueFingerprints.size === 1;

    signals.push({
      type: "repeat_tool",
      toolName,
      count: invocations.length,
      identical,
    });
  }

  return signals;
}

export function detectRepeatHypothesis(
  attempts: AdaptiveFailureAttempt[]
): RepeatSignal | undefined {
  if (attempts.length < 3) return undefined;

  const signatures = attempts.map(a => failureAttemptSignature(a));
  const unique = new Set(signatures);

  // DeepSeek ref: >50% repetições
  const repeatRatio = 1 - unique.size / attempts.length;
  if (repeatRatio > 0.5) {
    const mostCommon = [...signatures].reduce((a, b) =>
      signatures.filter(s => s === a).length > signatures.filter(s => s === b).length ? a : b
    );
    const count = signatures.filter(s => s === mostCommon).length;

    return {
      type: "repeat_hypothesis",
      signature: mostCommon,
      count,
    };
  }

  return undefined;
}

export function detectNoProgress(
  events: AgentEvent[],
  windowMs: number = 600_000  // 10min
): RepeatSignal | undefined {
  const now = Date.now();
  const recentEvents = events.filter(e => now - new Date(e.createdAt).getTime() < windowMs);

  // Progresso = arquivos editados, plano criado, evidência coletada
  const progressEvents = recentEvents.filter(e =>
    e.type === "tool.ended" && (e.tool === "edit" || e.tool === "write") ||
    e.type === "plan.created" ||
    e.type === "qa.evidence" && e.status === "passed" ||
    e.type === "checkpoint.created"
  );

  if (progressEvents.length === 0 && recentEvents.length > 10) {
    return {
      type: "no_progress",
      evidence: recentEvents.slice(0, 5).map(e => e.id),
    };
  }

  return undefined;
}
```

---

### 5.2 — Integração com Meta Controller

**Modificação em `decideNext()`:**

```typescript
// harness/meta-controller.ts
export function decideNext(snapshot: AdaptiveDecisionSnapshot): AdaptiveDecision {
  // ... código existente

  // Detectar repeat signals
  const repeatTools = detectRepeatTools(snapshot.events ?? []);
  const repeatHypothesis = detectRepeatHypothesis(snapshot.failureAttempts);
  const noProgress = detectNoProgress(snapshot.events ?? []);

  const repeatSignals = [
    ...repeatTools,
    ...(repeatHypothesis ? [repeatHypothesis] : []),
    ...(noProgress ? [noProgress] : []),
  ];

  if (repeatSignals.length > 0) {
    // Strategy: mudar abordagem
    if (repeatSignals.some(s => s.type === "repeat_hypothesis")) {
      return {
        action: "hint",
        hint: "Detected repeated failed strategy. Try a fundamentally different approach.",
        reasonCodes: ["repeat_hypothesis_detected"],
      };
    }

    // Strategy: delegar para specialist
    const repeatTool = repeatSignals.find(s => s.type === "repeat_tool" && s.identical);
    if (repeatTool && repeatTool.type === "repeat_tool") {
      const role = repeatTool.toolName.startsWith("bash") ? "debugger" : "explore";
      return {
        action: "delegate",
        role,
        task: `Investigate why ${repeatTool.toolName} is being called ${repeatTool.count} times with identical results`,
        reasonCodes: ["repeat_tool_detected"],
      };
    }

    // Strategy: stop loop
    if (snapshot.failureAttempts.filter(a => a.status === "failed").length >= 5) {
      return {
        action: "stop",
        reasonCodes: ["max_failure_attempts", "repeat_pattern_detected"],
      };
    }
  }

  // ... resto do código existente
}
```

**Benefício:** Usa thresholds do DeepSeek como referência inicial, pode ser ajustado com telemetria.

---

## Fase 6: Groups com Mailbox Durável

### Objetivo
Implementar mailbox durável, dedupe, ack e revisão otimista sobre stores existentes.

### 6.1 — Análise de Store Existente (Fase 0)

**Investigar:**
- Onde mensagens de groups são armazenadas hoje?
- `group-runtime-service.ts` usa qual persistência?
- Há tabela SQLite para messages? Ou apenas in-memory?

**Decisão:**
- Se existe tabela: estender com ack, dedupe
- Se não existe: criar `group_messages` table

---

### 6.2 — Group Mailbox Schema (se necessário)

**Schema:**
```sql
CREATE TABLE group_messages (
  id TEXT PRIMARY KEY,
  group_id TEXT NOT NULL,
  from_agent_id TEXT NOT NULL,
  to_agent_id TEXT NOT NULL,
  content TEXT NOT NULL,
  revision INTEGER NOT NULL,
  dedupe_hash TEXT NOT NULL,
  sent_at TEXT NOT NULL,
  acked_at TEXT,
  expires_at TEXT NOT NULL,  -- 30 dias sem ack
  FOREIGN KEY (group_id) REFERENCES agent_groups(id) ON DELETE CASCADE
);
CREATE INDEX idx_group_messages_to ON group_messages(to_agent_id, acked_at);
CREATE INDEX idx_group_messages_dedupe ON group_messages(dedupe_hash, sent_at);
CREATE INDEX idx_group_messages_expires ON group_messages(expires_at);
```

**Dedupe:**
```typescript
function computeDedupeHash(from: string, to: string, content: string): string {
  return createHash("sha256")
    .update(JSON.stringify({ from, to, content }), "utf8")
    .digest("hex")
    .slice(0, 16);
}
```

**Dedupe window:** 24h (mensagens idênticas dentro de 24h são rejeitadas)

---

### 6.3 — Revisão Otimista (CAS)

**Store em Project Model:**
```typescript
// harness/project-model-store.ts (estender)
export type GroupRevisionSnapshot = {
  groupId: string;
  agentId: string;
  revision: number;
  filesFingerprint: string;  // Hash de todos paths + hashes
  updatedAt: string;
};

export function recordGroupRevision(snapshot: GroupRevisionSnapshot): void {
  // Armazenar em project_model_edges ou nova tabela
  const db = getDatabase();
  db.prepare(`
    insert into group_revisions (group_id, agent_id, revision, files_fingerprint, updated_at)
    values (?, ?, ?, ?, ?)
    on conflict(group_id, agent_id) do update set
      revision = excluded.revision,
      files_fingerprint = excluded.files_fingerprint,
      updated_at = excluded.updated_at
  `).run(
    snapshot.groupId,
    snapshot.agentId,
    snapshot.revision,
    snapshot.filesFingerprint,
    snapshot.updatedAt
  );
}

export function detectConflict(
  groupId: string,
  agentId: string,
  expectedRevision: number
): boolean {
  const db = getDatabase();
  const row = db.prepare(`
    select revision from group_revisions
    where group_id = ? and agent_id = ?
  `).get(groupId, agentId) as { revision: number } | undefined;

  return row !== undefined && row.revision !== expectedRevision;
}
```

---

## Fase 7: ResponsePolicy Silenciosa

### Objetivo
Reduzir verbosidade na resposta sem truncar informação crítica.

### 7.1 — Response Policy Contract

**Princípio:** Política guia composição, não trunca pós-processamento.

**Arquivo:** [`harness/response/response-policy.ts`](apps/desktop/src/main/agent/harness/response/response-policy.ts)

```typescript
export type ResponseLevel = "compact" | "standard" | "detailed" | "verbose";

export type ResponseGuidelines = {
  maxSuggestedParagraphs: number;  // Sugestão, não hard limit
  includeReasoning: boolean;
  includeToolNarration: boolean;
  includeSearchResults: boolean;
  alwaysInclude: string[];  // Seções críticas sempre incluídas
};

export const RESPONSE_GUIDELINES: Record<ResponseLevel, ResponseGuidelines> = {
  compact: {
    maxSuggestedParagraphs: 3,
    includeReasoning: false,
    includeToolNarration: false,
    includeSearchResults: false,
    alwaysInclude: ["conclusion", "errors", "blockers", "next_steps"],
  },
  standard: {
    maxSuggestedParagraphs: 6,
    includeReasoning: false,
    includeToolNarration: false,
    includeSearchResults: false,
    alwaysInclude: ["conclusion", "changes", "errors", "blockers", "decisions"],
  },
  detailed: {
    maxSuggestedParagraphs: 12,
    includeReasoning: true,
    includeToolNarration: true,
    includeSearchResults: false,
    alwaysInclude: ["all"],
  },
  verbose: {
    maxSuggestedParagraphs: -1,  // Unlimited
    includeReasoning: true,
    includeToolNarration: true,
    includeSearchResults: true,
    alwaysInclude: ["all"],
  },
};
```

**Prompt injection:**
```typescript
function buildResponsePolicyPrompt(level: ResponseLevel): string {
  const guidelines = RESPONSE_GUIDELINES[level];

  if (level === "compact") {
    return `<response_policy level="compact">
Keep your response minimal and focused. Include only:
- What was accomplished (1-2 sentences)
- Important changes or decisions
- Errors or blockers (if any)
- Next action needed from user (if any)

Do NOT narrate:
- Internal reasoning (thinking is silent)
- Tool calls (visible in UI)
- Files read (visible in UI)
- Searches performed (visible in UI)
- Step-by-step process

Maximum ${guidelines.maxSuggestedParagraphs} short paragraphs. Errors and blockers always take priority.
</response_policy>`;
  }

  // ... outras guidelines
}
```

**Enforcement:** Via prompt guidelines, não post-processing.

---

### 7.2 — Critical Information Preservation

**Detector de informação crítica:**
```typescript
export type CriticalSection = {
  type: "error" | "blocker" | "decision" | "next_step";
  content: string;
  confidence: number;
};

export function extractCriticalSections(response: string): CriticalSection[] {
  const sections: CriticalSection[] = [];

  // Error patterns
  const errorPatterns = [
    /error:?/i,
    /failed/i,
    /cannot/i,
    /\bERR\b/,
    /exception/i,
  ];

  // Blocker patterns
  const blockerPatterns = [
    /blocked/i,
    /needs? (your|user) (input|approval|confirmation)/i,
    /waiting for/i,
    /cannot proceed/i,
  ];

  // Decision patterns
  const decisionPatterns = [
    /decided to/i,
    /chosen/i,
    /selected/i,
    /approach:/i,
  ];

  // ... extração via regex + NLP simples

  return sections;
}
```

**Usage:** Observability para detectar se policy omite algo crítico.

---

## Fase 8: Integração e Validação

### 8.1 — Feature Flags (apenas componentes de alto risco)

```typescript
// harness/feature-flags.ts
export const HARNESS_FEATURES = {
  // Fase 4: Compaction pruning (alto risco de conflito com PI SDK)
  enableCompactionPruning: process.env.MODUS_COMPACTION_PRUNING === "true",
  
  // Fase 6: Groups mailbox (mudança de persistência)
  enableGroupsMailbox: process.env.MODUS_GROUPS_MAILBOX === "true",
};
```

**Remover dual-path após validação** (não manter permanentemente).

---

### 8.2 — Validation Gates

**Gate 1: Context Reconstruction**
```typescript
describe("Context reconstruction after restart", () => {
  it("rebuilds prompt sections deterministically", async () => {
    const session = createTestSession();
    const registry1 = new PromptRegistry();
    const registry2 = new PromptRegistry();

    registerAllSections(registry1);
    registerAllSections(registry2);

    const prompt1 = await registry1.buildPrompt(session.id, context, true);
    const prompt2 = await registry2.buildPrompt(session.id, context, true);

    expect(prompt1).toEqual(prompt2);
  });
});
```

**Gate 2: Tool Result Spill Recovery**
```typescript
describe("Spilled tool result recovery", () => {
  it("retrieves full content after spill", async () => {
    const fullContent = "x".repeat(20_000);
    const spillId = spillToolResult({ /* ... */ fullContent });

    const retrieved = retrieveSpilledResult(spillId);
    expect(retrieved).toEqual(fullContent);
  });

  it("survives session restart", async () => {
    const spillId = /* spill em sessão anterior */;
    // Restart app
    const retrieved = retrieveSpilledResult(spillId);
    expect(retrieved).toBeDefined();
  });
});
```

**Gate 3: Compaction Integration**
```typescript
describe("Compaction with pruning", () => {
  it("prunes before PI SDK compaction", async () => {
    const session = createSessionWithLargeContext();
    const beforePrune = countTokens(session.context);
    
    await pruneBeforeCompaction(session.id, session.runId, 10_000);
    
    const afterPrune = countTokens(session.context);
    expect(afterPrune).toBeLessThan(beforePrune);
  });

  it("preserves evidence events", async () => {
    const session = createSessionWithEvidenceEvents();
    await pruneBeforeCompaction(session.id, session.runId, 50_000);
    
    const qaEvidence = getQAEvidence(session.id);
    expect(qaEvidence).toHaveLength(/* original count */);
  });
});
```

**Gate 4: Groups Mailbox**
```typescript
describe("Groups mailbox durability", () => {
  it("persists messages across restart", async () => {
    const msgId = sendGroupMessage({ from: "agent1", to: "agent2", content: "test" });
    // Restart
    const messages = receiveGroupMessages("agent2");
    expect(messages).toContainEqual(expect.objectContaining({ id: msgId }));
  });

  it("deduplicates identical messages within 24h", async () => {
    sendGroupMessage({ from: "agent1", to: "agent2", content: "duplicate" });
    const result = sendGroupMessage({ from: "agent1", to: "agent2", content: "duplicate" });
    expect(result).toBeNull(); // Rejected
  });
});
```

**Gate 5: No Regressions**
```typescript
describe("Regression tests", () => {
  it("maintains token usage within 120% of baseline", async () => {
    const baseline = measureBaselineTokens();
    const current = measureCurrentTokens();
    expect(current).toBeLessThanOrEqual(baseline * 1.2);
  });

  it("completes tasks in same number of turns", async () => {
    const baselineTurns = runBaselineTask();
    const currentTurns = runCurrentTask();
    expect(currentTurns).toBeLessThanOrEqual(baselineTurns);
  });
});
```

---

### 8.3 — Observability Dashboard

**Metrics a coletar:**
```typescript
export type HarnessMetrics = {
  promptSections: {
    totalSections: number;
    sentSections: number;
    skippedSections: string[];
    tokensS saved: number;
  };
  toolResults: {
    totalResults: number;
    spilledResults: number;
    totalBytes: number;
    spilledBytes: number;
    retrievalCount: number;
  };
  compaction: {
    triggeredCount: number;
    prunedBeforeCompaction: number;
    pruningSavedTokens: number;
    piSdkCompactionCount: number;
  };
  repeatGuards: {
    repeatToolDetected: number;
    repeatHypothesisDetected: number;
    noProgressDetected: number;
    loopsPreventedCount: number;
  };
  response: {
    averageParagraphs: number;
    policyViolations: number;
    criticalSectionsOmitted: number;
  };
};
```

**Painel na UI (opcional):**
- Mostrar métricas por sessão
- Comparar com baseline
- Identificar regressões

---

## Validação de Economias

**Não tratar como metas rígidas.**

**Metrics observadas:**
- Token economy (experimental)
- Compaction frequency reduction
- Response brevity
- Loop prevention

**Prioridade:**
1. ✅ Qualidade: respostas completas, sem truncamento crítico
2. ✅ Completude: tarefas concluídas em mesmo ou menos turns
3. ✅ Ausência de loops: repeat guards funcionam
4. ✅ Preservação de evidências: QA, checkpoints, decisions intactos
5. 🔬 Token economy: observar, não otimizar prematuramente

**Critério de sucesso:** Modus continua funcionando perfeitamente + redução observável de contexto redundante.

---

## Cronograma

**Não estimar dias totais antecipadamente.**

**Fases sequenciais:**

### Ciclo 1: Harness Core & Token Optimization
1. Fase 0: Investigação (necessária antes de estimar fases seguintes)
2. Fase 1: HarnessKernel
3. Fase 2: PromptRegistry
4. Fase 3: Tool Result Spill
5. Fase 4: Compaction Pruning (escopo ajustado após Fase 0)
6. Fase 5: Repeat Guards
7. Fase 6: Groups Mailbox (escopo ajustado após Fase 0)
8. Fase 7: ResponsePolicy
9. Fase 8: Validação

**Checkpoint após Fase 2:** Medir economias reais, decidir continuar fases 3-7 ou iterar.

### Ciclo 2: Plugin System & Plataforma Extensível (Fases 9 a 22)
10. Fase 9: Capability Registry + Provenance
11. Fase 10: Modus Internal Plugins (10A: Piloto / 10B: Migração)
12. Fase 11: Plugin Lifecycle
13. Fase 12: Plugin Tracing & Observability
14. Fase 13: Isolamento e Segurança (Process Sandboxing & Brokers)
15. Fase 14: Dependency Intelligence & Graph
16. Fase 15: Rollback e Safe Mode
17. Fase 16: Plugin SDK Público
18. Fase 17: Plugin Marketplace
19. Fase 18: Harness Marketplace
20. Fase 19: High-Performance Sandboxing (WASM / WASI)
21. Fase 20: Federated Capabilities & Multi-Agent Mesh
22. Fase 21: Autonomous JIT Capabilities (Self-Synthesized Plugins)
23. Fase 22: Enterprise Governance & Policy-as-Code (OPA/Rego)

**Checkpoint após Fase 10A:** Validar os 3 plugins piloto antes de migrar os módulos restantes.
**Checkpoint após Fase 13:** Auditar modelo de ameaças e isolamento de processo antes do SDK público.

---

## Princípio Central

**Modus pode trabalhar extensivamente internamente** (reasoning, tool calls, buscas, reads, subagentes, compaction, pruning), **mas deve apresentar ao usuário apenas o resultado necessário** (conclusão, mudanças, erros, bloqueios, próximos passos).

**Processo ≠ Produto.**
- Processo: visível na UI (Work Fold, timeline, evidências)
- Produto: resposta textual concisa do agente

---

**Aprovado com ajustes.**

Co-Authored-By: Claude Fable 5.1 <noreply@anthropic.com>


---

# Parte II: Plugin System Roadmap (Fases 9 a 22)

## Visão Geral

Este documento detalha o roadmap para transformar o Modus de um agente monolítico em uma plataforma extensível através de um sistema de plugins robusto, seguro e de alto desempenho.

A evolução distribui-se em quatro grandes ciclos:
1. **Foundation (Fases 9-10)**: Formalização do registro de capabilities e refatoração internal-first dos subsistemas existentes.
2. **Hardening & Resilience (Fases 11-15)**: Ciclo de vida completo, tracing, isolamento estrito de processos via brokers, inteligência de dependências e safe mode.
3. **Ecosystem & Platform (Fases 16-18)**: SDK público, marketplace de plugins comunitários e marketplace de substituição do próprio harness runtime.
4. **Advanced Scale (Fases 19-22)**: Execução WASM ultra-rápida (<0.2ms), malha multi-agente federada via gRPC, capacidades autônomas sintetizadas JIT e governança corporativa via Policy-as-Code (OPA/Rego).

---

## Princípios Arquiteturais da Extensibilidade

1. **Internal-First**: Antes de permitir plugins externos, refatorar componentes internos para usar o mesmo sistema.
2. **Capability-Driven**: Plugins fornecem capabilities e atendem a contratos versionados, nunca se acoplando a APIs internas privadas.
3. **Safe by Default**: Isolamento estrito por processo com permission brokers obrigatórios antes de qualquer abertura pública.
4. **Observable**: Todo plugin é rastreável ponta a ponta através do sistema de observabilidade e provenance tracking.
5. **Reversible**: Rollback automático e Safe Mode garantem restauração determinística mesmo após falhas catastróficas.

---

## Ordem de Implementação das Fases 9-30

**Importante**: As Fases 23-28 (UI Extensível) acontecem **ANTES** das Fases 16-18 (SDK/Marketplace Público) para garantir que o SDK já nasça com arquitetura unificada: runtime + plugins + UI extensível.

```
FOUNDATION (Fases 9-15)
────────────────────────
Fase 9:  Capability Registry
Fase 10A: Piloto (3 plugins)
Fase 10B: Migração Incremental
Fase 11: Plugin Lifecycle
Fase 12: Plugin Tracing
Fase 13: Isolamento e Segurança
Fase 14: Dependency Intelligence
Fase 15: Rollback e Safe Mode

    ↓

HARDENING (Fase 19)
────────────────────────
Fase 19: WASM & Real Sandbox

    ↓

AUDITORIA DE SEGURANÇA GERAL
────────────────────────
- Security audit completo
- Penetration testing
- Correções críticas
- Segunda auditoria

    ↓

UI EXTENSÍVEL (Fases 23-28)
────────────────────────
Fase 23: UI Contribution Foundation
Fase 24: Slot Expansion & Shell Integration
Fase 25: UI Safety & Isolation
Fase 26: Contextual Adaptive UI
Fase 27: UI Observability & DevTools
Fase 28: Safe Mode & Rollback Integration

    ↓

JIT CAPABILITIES (Fases 21, 29)
────────────────────────
Fase 21: Autonomous JIT Capabilities
Fase 29: Dynamic/JIT UI (Declarative)

    ↓

CORE/UX REVIEW
────────────────────────
- Internal dogfooding completo
- UX validation
- Performance benchmarks
- Documentation review

    ↓

PUBLIC ECOSYSTEM (Fases 16-18)
────────────────────────
Fase 16: Plugin SDK Público (já com UI extensível)
Fase 17: Marketplace
Fase 18: Harness Marketplace

    ↓

ADVANCED/ENTERPRISE (Fases 20, 22)
────────────────────────
Fase 20: Federated Capabilities & Multi-Agent Mesh
Fase 22: Enterprise Governance & Policy-as-Code
```

**Justificativa da Ordem**:

1. **UI antes de SDK público**: Descobrir erros de design de UI enquanto tudo é interno, antes de publicar contratos externos
2. **Safety antes de Adaptive**: Fronteiras de segurança estabelecidas antes de adaptação automática de UI
3. **Auditoria após sandbox real**: Validar isolamento completo antes de expandir para UI
4. **JIT UI após JIT Capabilities**: Capabilities efêmeras precisam existir antes de solicitar UI efêmera
5. **SDK já completo**: Quando publicado, inclui runtime + plugins + UI como arquitetura unificada

---

## Fase 9: Capability Registry + Provenance

### Objetivos

- Formalizar quais capabilities o Modus fornece
- Criar registro central com suporte a múltiplos providers por capability
- Estabelecer versionamento separado: capability API version vs plugin version
- Implementar provenance tracking desde o início
- Base para substituição futura por plugins

### Capabilities do Modus

```typescript
// Core capabilities
memory.retrieve
memory.store
memory.search
context.resolve
context.compact
context.summarize
agent.loop
agent.pause
agent.resume
model.select
model.switch
tools.shell
tools.file
tools.search
verification.run
verification.analyze
compaction.strategy
group.route
group.select
failure.analyze
failure.predict
```

### Implementação

#### 9.1 - CapabilityRegistry Core

**Princípio fundamental**: Separar capability API version de plugin version, e suportar múltiplos providers por capability.

```typescript
// src/capability/registry.ts

interface Capability {
  id: string;                      // e.g., "memory.retrieve"
  apiVersion: string;              // e.g., "1.0" - API contract version
  replaceable: boolean;
  dependencies: string[];          // outras capabilities necessárias (com versão)
  metadata: {
    description: string;
    stability: 'stable' | 'beta' | 'experimental';
  };
}

interface CapabilityProvider {
  providerId: string;              // e.g., "@modus/project-memory"
  providerVersion: string;         // e.g., "2.7.3" - plugin version
  capabilityId: string;            // capability que implementa
  capabilityApiVersion: string;    // qual versão da API capability
  trustLevel: TrustLevel;
  permissions: PluginPermissions;
  implementation: CapabilityImplementation;
  registeredAt: Date;
  metadata: {
    performance: {
      avgLatency?: number;
      maxLatency?: number;
    };
  };
}

type TrustLevel = 'core' | 'official' | 'verified' | 'community' | 'local';

class CapabilityRegistry {
  private capabilities = new Map<string, Capability>();
  private providers = new Map<string, CapabilityProvider[]>(); // capability -> providers[]
  private activeProviders = new Map<string, string>(); // capability -> active providerId
  
  // Capability management
  registerCapability(capability: Capability): void;
  getCapability(id: string): Capability | undefined;
  listCapabilities(): Capability[];
  
  // Provider management
  registerProvider(provider: CapabilityProvider): void;
  activateProvider(capabilityId: string, providerId: string): void;
  getActiveProvider(capabilityId: string): CapabilityProvider | undefined;
  listProviders(capabilityId: string): CapabilityProvider[];
  
  // Execution
  async execute<T>(capabilityId: string, context: unknown): Promise<T> {
    const provider = this.getActiveProvider(capabilityId);
    if (!provider) throw new NoProviderError(capabilityId);
    
    // Provenance tracking
    const trace = {
      traceId: generateTraceId(),
      capability: capabilityId,
      capabilityApiVersion: provider.capabilityApiVersion,
      providerId: provider.providerId,
      providerVersion: provider.providerVersion,
      startTime: Date.now()
    };
    
    try {
      const result = await provider.implementation.execute(context);
      this.recordSuccess(trace);
      return result;
    } catch (error) {
      this.recordFailure(trace, error);
      throw error;
    }
  }
  
  // Provenance
  getProvenance(capabilityId: string): CapabilityProvenance;
}

interface CapabilityProvenance {
  capability: string;
  apiVersion: string;
  activeProvider: {
    id: string;
    version: string;
    trustLevel: TrustLevel;
  };
  alternativeProviders: Array<{
    id: string;
    version: string;
    trustLevel: TrustLevel;
  }>;
  usageCount: number;
  lastUsed: Date;
  errorRate: number;
}
```

#### 9.2 - Integração com Componentes Existentes

```typescript
// Cada módulo registra sua capability e se registra como provider

// src/memory/project/index.ts
export function registerCapabilitiesAndProviders(registry: CapabilityRegistry) {
  // 1. Register capability (API contract)
  registry.registerCapability({
    id: 'memory.retrieve',
    apiVersion: '1.0',
    replaceable: true,
    dependencies: [],
    metadata: {
      description: 'Retrieve project memories based on context',
      stability: 'stable'
    }
  });
  
  // 2. Register as provider
  registry.registerProvider({
    providerId: '@modus/project-memory',
    providerVersion: '1.0.0',
    capabilityId: 'memory.retrieve',
    capabilityApiVersion: '1.0',
    trustLevel: 'core',
    permissions: {
      filesystem: { read: 'workspace', write: 'project', delete: 'none' },
      memory: { read: 'project', write: 'project', delete: 'own' }
    },
    implementation: {
      async execute(context: MemoryContext): Promise<Memory[]> {
        // implementação atual
      }
    },
    registeredAt: new Date(),
    metadata: {
      performance: {}
    }
  });
  
  // 3. Activate as default
  registry.activateProvider('memory.retrieve', '@modus/project-memory');
}
```

#### 9.3 - Discovery API

```typescript
// CLI command: modus capabilities list
{
  "capabilities": [
    {
      "id": "memory.retrieve",
      "apiVersion": "1.0",
      "replaceable": true,
      "activeProvider": {
        "id": "@modus/project-memory",
        "version": "1.0.0",
        "trustLevel": "core"
      },
      "alternativeProviders": [
        {
          "id": "@community/vector-memory",
          "version": "2.1.0",
          "trustLevel": "community"
        }
      ]
    },
    {
      "id": "context.resolve",
      "apiVersion": "1.0",
      "replaceable": true,
      "activeProvider": {
        "id": "@modus/context-engine",
        "version": "1.0.0",
        "trustLevel": "core"
      },
      "alternativeProviders": []
    }
  ]
}

// CLI command: modus capabilities switch
$ modus capabilities switch memory.retrieve @community/vector-memory

Switching memory.retrieve provider:
  From: @modus/project-memory@1.0.0 (core)
  To:   @community/vector-memory@2.1.0 (community)

This changes memory behavior system-wide.
Restart to apply changes.
```

### Critérios de Sucesso

- [ ] CapabilityRegistry implementado e testado
- [ ] Todos os componentes principais registram suas capabilities
- [ ] CLI consegue listar capabilities disponíveis
- [ ] Provenance tracking funcional
- [ ] Documentação de todas as capabilities públicas

### Estimativa

2-3 semanas

---

## Fase 10: Modus Internal Plugins

### Objetivos

- Provar a arquitetura com 3 plugins piloto de tipos diferentes
- Estabelecer padrões de plugin development
- Manter backward compatibility total
- Validar que o sistema suporta diferentes padrões antes de migrar todos

### Fase 10A - Piloto com 3 Plugins

Começar com três tipos diferentes para validar a arquitetura:

```
@modus/memory
→ Stateful capability
→ Persistência no disco
→ Operações CRUD

@modus/model-router
→ Quase stateless
→ Decisões baseadas em context
→ Sem persistência

@modus/verifier
→ Capability complexa
→ Depende de outras capabilities
→ Orchestração de múltiplas operações
```

### Fase 10B - Migração Incremental

Após validar o piloto, migrar gradualmente:

```
@modus/context-engine       → context.resolve, context.compact
@modus/failure-intelligence → failure.*
@modus/groups               → group.*
@modus/hyperplan            → hyperplan.*
@modus/shell-tools          → tools.shell
```

### Implementação

#### 10.1 - Plugin Descriptor

```typescript
// src/plugin/types.ts

interface PluginManifest {
  id: string;                      // @modus/context-engine
  name: string;                    // Context Engine
  version: string;                 // 1.0.0
  author: string;
  description: string;
  trustLevel: TrustLevel;          // core | official | verified | community | local
  
  provides: CapabilityProvision[];
  requires: {
    modus: string;                 // >=0.8.0
    capabilities?: CapabilityRequirement[];
  };
  
  permissions: {
    required: PluginPermissions;
    optional?: PluginPermissions;
    reason: Record<string, string>;
  };
  
  lifecycle: {
    onLoad?: () => Promise<void>;
    onUnload?: () => Promise<void>;
    onEnable?: () => Promise<void>;
    onDisable?: () => Promise<void>;
  };
}

interface CapabilityRequirement {
  capability: string;              // e.g., "memory.retrieve"
  version: string;                 // semver range: "^1.0", ">=1.0 <2.0", "~1.4"
}

interface CapabilityProvision {
  capability: string;              // e.g., "memory.retrieve"
  apiVersion: string;              // e.g., "1.0" - qual versão da API capability este plugin implementa
  implementation: string;          // path to implementation
  config?: Record<string, unknown>;
}
```

#### 10.2 - Plugin Loader

```typescript
// src/plugin/loader.ts

class PluginLoader {
  private plugins = new Map<string, LoadedPlugin>();
  
  async load(manifest: PluginManifest): Promise<void> {
    // 1. Validate manifest
    this.validateManifest(manifest);
    
    // 2. Check dependencies
    await this.checkDependencies(manifest.requires);
    
    // 3. Load implementation
    const plugin = await this.loadImplementation(manifest);
    
    // 4. Register as provider for each capability
    for (const provision of manifest.provides) {
      const capability = this.registry.getCapability(provision.capability);
      if (!capability) {
        throw new Error(`Capability ${provision.capability} not registered. Register capability first.`);
      }
      
      if (capability.apiVersion !== provision.apiVersion) {
        console.warn(`Plugin ${manifest.id} implements ${provision.capability}@${provision.apiVersion}, but registry has @${capability.apiVersion}`);
      }
      
      this.registry.registerProvider({
        providerId: manifest.id,
        providerVersion: manifest.version,
        capabilityId: provision.capability,
        capabilityApiVersion: provision.apiVersion,
        trustLevel: manifest.trustLevel,
        permissions: manifest.permissions.required,
        implementation: plugin.implementations[provision.capability],
        registeredAt: new Date(),
        metadata: {
          performance: {}
        }
      });
      
      const activeProvider = this.registry.getActiveProvider(provision.capability);
      if (!activeProvider) {
        this.registry.activateProvider(provision.capability, manifest.id);
      }
    }
    
    // 5. Run lifecycle hook
    if (manifest.lifecycle.onLoad) {
      await manifest.lifecycle.onLoad();
    }
    
    this.plugins.set(manifest.id, plugin);
  }
}
```

#### 10.3 - Bootstrap Sequence

```typescript
// src/bootstrap.ts

async function bootstrapModus() {
  const kernel = new ModusKernel();
  const registry = new CapabilityRegistry();
  const loader = new PluginLoader(registry);
  
  // Ordem importa por dependências de capability
  await loader.load(memoryManifest);           // sem dependências
  await loader.load(contextEngineManifest);    // depende de memory
  await loader.load(modelRouterManifest);      // sem dependências
  await loader.load(verifierManifest);         // depende de context
  await loader.load(failureIntelManifest);     // depende de verifier
  await loader.load(groupsManifest);           // depende de context
  await loader.load(hyperplanManifest);        // depende de context, groups
  
  const harness = new Harness(kernel, registry);
  await harness.start();
}
```

### Critérios de Sucesso

- [ ] 3 plugins piloto refatorados e funcionando perfeitamente
- [ ] Nenhuma regressão em testes existentes
- [ ] Performance com overhead < 3%
- [ ] Todos os módulos restantes migrados incrementalmente
- [ ] Sequência de carregamento documentada

### Estimativa

**Fase 10A:** 2-3 semanas | **Fase 10B:** 2-3 semanas adicionais

---

## Fase 11: Plugin Lifecycle

### Objetivos

- Implementar gerenciamento completo do ciclo de vida de plugins
- CLI para manipular plugins (`install`, `uninstall`, `enable`, `disable`, `upgrade`, `downgrade`)
- Persistência transacional de estado de plugins em SQLite
- Resolução básica de dependências

### Implementação

#### 11.1 - Plugin State Storage (SQLite)

```sql
-- .modus/plugins/state.db

CREATE TABLE plugins (
  id TEXT PRIMARY KEY,
  version TEXT NOT NULL,
  state TEXT NOT NULL CHECK(state IN ('installed', 'enabled', 'disabled', 'error')),
  trust_level TEXT NOT NULL,
  installed_at DATETIME NOT NULL,
  last_enabled DATETIME,
  config JSON
);

CREATE TABLE plugin_versions (
  plugin_id TEXT NOT NULL,
  version TEXT NOT NULL,
  preserved_at DATETIME NOT NULL,
  manifest JSON NOT NULL,
  PRIMARY KEY (plugin_id, version)
);

CREATE TABLE plugin_capabilities (
  plugin_id TEXT NOT NULL,
  capability_id TEXT NOT NULL,
  capability_api_version TEXT NOT NULL,
  PRIMARY KEY (plugin_id, capability_id)
);

CREATE TABLE plugin_permissions (
  plugin_id TEXT PRIMARY KEY,
  permissions JSON NOT NULL
);

CREATE TABLE plugin_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  plugin_id TEXT NOT NULL,
  event_type TEXT NOT NULL,
  timestamp DATETIME NOT NULL,
  details JSON
);
```

#### 11.2 - CLI Commands

```bash
# Instalação e Listagem
modus plugin install @modus/smart-memory
modus plugin list --enabled

# Gerenciamento de Estado
modus plugin enable @modus/smart-memory
modus plugin disable @modus/smart-memory
modus plugin upgrade @modus/context-engine@1.3.0
modus plugin downgrade @modus/context-engine@1.1.0
modus plugin status @modus/context-engine
```

### Critérios de Sucesso

- [ ] Todas as operações de lifecycle implementadas
- [ ] CLI funcional para todas as operações
- [ ] Estado persiste em SQLite entre restarts com integridade ACID
- [ ] Transações garantem consistência após encerramento forçado

### Estimativa

3-4 semanas

---

## Fase 12: Plugin Tracing

### Objetivos

- Integrar plugins com o sistema de observabilidade e OpenTelemetry
- Rastrear execução completa: request → capability → provider → result
- Correlacionar falhas com plugins específicos via Failure Intelligence
- Health monitoring com métricas em tempo real (latência P95, taxa de erro)

### Implementação

#### 12.1 - Plugin Instrumentation

```typescript
// src/plugin/instrumentation.ts

interface PluginTrace {
  traceId: string;
  pluginId: string;
  capability: string;
  version: string;
  startTime: number;
  endTime?: number;
  duration?: number;
  status: 'success' | 'error' | 'timeout';
  error?: Error;
  metadata: {
    inputSize?: number;
    outputSize?: number;
    cacheHit?: boolean;
  };
}

class PluginInstrumentation {
  async trace<T>(
    pluginId: string,
    capability: string,
    fn: () => Promise<T>
  ): Promise<T> {
    const trace: PluginTrace = {
      traceId: generateTraceId(),
      pluginId,
      capability,
      version: this.getPluginVersion(pluginId),
      startTime: Date.now(),
      status: 'success',
      metadata: {}
    };
    
    try {
      const result = await fn();
      trace.endTime = Date.now();
      trace.duration = trace.endTime - trace.startTime;
      this.collector.collect(trace);
      return result;
    } catch (error) {
      trace.status = 'error';
      trace.error = error as Error;
      trace.endTime = Date.now();
      trace.duration = trace.endTime - trace.startTime;
      this.collector.collect(trace);
      throw error;
    }
  }
}
```

### Critérios de Sucesso

- [ ] Todas as execuções de plugin são rastreadas
- [ ] Traces integrados com HarnessObserver
- [ ] Failure Intelligence correlaciona falhas com plugins
- [ ] Health monitoring detecta plugins degradados

### Estimativa

2-3 semanas

---

## Fase 13: Isolamento e Segurança

### Objetivos

- Process isolation obrigatório para plugins comunitários/externos
- Permission brokers para filesystem, network, shell, memória e git
- Prevenção total de acesso a credenciais, tokens e chaves privadas
- Trilha de auditoria criptograficamente referenciável

### Implementação

#### 13.1 - Arquitetura de Isolamento com Brokers

```
Community Plugin
      │
      ▼
Plugin Host Process (Worker isolado sem require/fs)
      │
      ▼
Capability RPC
      │
      ▼
Permission Broker (Processo principal Modus)
      ├── Filesystem Broker (escopos estritos: workspace/temp)
      ├── Network Broker (whitelist de domínios)
      ├── Shell Broker (comandos validados)
      └── Git Broker (protege push / chaves SSH)
```

```typescript
// src/plugin/isolation.ts

class FilesystemBroker {
  async handle(request: BrokerRequest, permissions: FSPermissions): Promise<unknown> {
    switch (request.operation) {
      case 'readFile':
        if (!this.canRead(request.path, permissions)) {
          throw new PermissionDeniedError('filesystem.read', request.path);
        }
        this.audit.log('filesystem.read', request.pluginId, request.path);
        return fs.readFile(request.path, 'utf-8');
        
      case 'writeFile':
        if (!this.canWrite(request.path, permissions)) {
          throw new PermissionDeniedError('filesystem.write', request.path);
        }
        this.audit.log('filesystem.write', request.pluginId, request.path);
        return fs.writeFile(request.path, request.content);
        
      default:
        throw new Error(`Unknown operation: ${request.operation}`);
    }
  }
}
```

### Critérios de Sucesso

- [ ] Plugins externos executam em processos isolados com RPC seguro
- [ ] Queda de plugin externo não derruba o Modus
- [ ] Violações de permissão bloqueadas e logadas no audit trail
- [ ] RPC overhead < 5ms para chamadas típicas

### Estimativa

5-6 semanas

---

## Fase 14: Dependency Intelligence

### Objetivos

- Construir e persistir o grafo de dependências completo
- Cálculo de *Blast Radius* para prever impacto de remoção ou atualização
- Prevenção automática de remoção acidental de dependências críticas
- Algoritmo de atualização com ordenação topológica e paralelização

### Implementação

```bash
# Avaliação de Blast Radius antes de desinstalar
$ modus plugin blast-radius @modus/smart-memory

Removing @modus/smart-memory would affect:

Direct dependents:
  • @modus/context-engine
  • @modus/meta-controller

Transitive dependents:
  • @modus/verifier (via context-engine)
  • @modus/hyperplan (via context-engine)
  • @modus/groups (via meta-controller)

Total affected: 5 plugins
Severity: HIGH
```

### Critérios de Sucesso

- [ ] Dependency graph persistente e atualizado em tempo real
- [ ] Cálculo de blast radius preciso e visível via CLI
- [ ] Detecção e bloqueio de dependências circulares

### Estimativa

2-3 semanas

---

## Fase 15: Rollback e Safe Mode

### Objetivos

- Preservação determinística de versões anteriores antes de atualizações
- Rollback automático caso a taxa de erro suba pós-upgrade (> 50% em 60s)
- Inicialização em Safe Mode escalonado (`core`, `official`, `verified`)
- Ferramenta de diagnóstico e recuperação automática (`modus plugin recover`)

### Implementação

```bash
# Safe mode escalonado
$ modus --safe-mode
# Inicia apenas com plugins de trustLevel 'core'

$ modus plugin diagnose
Plugin System Diagnosis
───────────────────────
✗ @external/broken-plugin: Error rate 85% -> Recomenda rollback
✓ @modus/context-engine: Healthy

Run 'modus plugin recover' to apply auto-fixes.
```

### Critérios de Sucesso

- [ ] Versões anteriores preservadas automaticamente
- [ ] Rollback automático restaura estado em caso de quebra
- [ ] Safe Mode garante boot limpo para recuperação de panes

### Estimativa

3-4 semanas

---

## Fase 16: Plugin SDK Público

### Objetivos

- Pacote `@modus/plugin-sdk` publicado e documentado
- Funções declarativas: `definePlugin()`, `defineCapability()`, `defineHook()`
- CLI com scaffolding: `modus plugin create`, `modus plugin test`, `modus plugin build`
- Guias de desenvolvimento, tipagens completas e suíte de testes de integração

### Implementação

```typescript
// Exemplo de Plugin com o SDK
import { definePlugin, defineCapability } from '@modus/plugin-sdk';

export default definePlugin({
  id: 'custom-analyzer',
  name: 'Custom Code Analyzer',
  version: '1.0.0',
  provides: [
    {
      capability: 'verification.analyze',
      apiVersion: '1.0',
      implementation: './analyzer.js'
    }
  ],
  permissions: {
    required: {
      filesystem: { read: 'workspace', write: 'none', delete: 'none' },
      network: { allowed: false },
      shell: { allowed: false },
      memory: { read: 'own', write: 'own', delete: 'none' },
      capabilities: { allowed: [] },
      sensitive: { credentials: false, git: { read: false, write: false, push: false }, env: false }
    },
    reason: { 'filesystem.read': 'Analyze workspace source code' }
  }
});
```

### Critérios de Sucesso

- [ ] SDK publicado no npm com TypeScript em modo estrito
- [ ] Scaffolding CLI operacional gerando boilerplate funcional
- [ ] 5 exemplos de referência cobrindo diferentes categorias

### Estimativa

4-5 semanas

---

## Fase 17: Marketplace

### Objetivos

- Registro central para publicação e descoberta (`plugins.modus.dev`)
- Verificação de segurança automatizada (análise estática AST, dependências, credenciais)
- Badges de reputação (`official`, `verified`, `secure`, `popular`)
- Interface Web e integração transparente via CLI (`modus plugin search/install`)

### Implementação

```bash
$ modus plugin search memory
Found 3 plugins:
1. @modus/smart-memory ⭐️⭐️⭐️⭐️⭐️ (4.8/5) [Official] [Verified]
2. @community/vector-memory ⭐️⭐️⭐️⭐️ (4.2/5) [Community]
3. @labs/graph-memory ⭐️⭐️⭐️⭐️ (4.0/5) [Experimental]

$ modus plugin install @modus/smart-memory
Fetching @modus/smart-memory@1.4.0...
✓ Downloaded (2.3 MB)
✓ Security scan passed
✓ Permissions verified
Installed successfully.
```

### Critérios de Sucesso

- [ ] Serviço de registry operacional
- [ ] Varredura estática de segurança no upload
- [ ] Catálogo com busca e filtros funcionando no CLI e Web

### Estimativa

6-8 semanas

---

## Fase 18: Harness Marketplace

### Objetivos

- Permitir substituição modular de componentes centrais do Modus:
  - Agent Loop Strategy (`harness.loop`)
  - Estratégia de Compactação (`harness.compaction`)
  - Motor de Verificação (`harness.verifier`)
  - Roteamento de Modelos (`harness.model-selector`)
- Suporte a arquiteturas alternativas (ex: runtime inspirado em DeepSeek Harness)
- Ferramenta de benchmark para comparar runtimes em tarefas reais

### Implementação

```bash
# Comparação de runtimes em benchmarks de execução
$ modus harness compare --task "Implement authentication"

┌─────────────────────────┬──────────┬─────────┬──────────┬─────────┐
│ Runtime                 │ Time     │ Quality │ Cost     │ Score   │
├─────────────────────────┼──────────┼─────────┼──────────┼─────────┤
│ Meta Controller         │ 2m 15s   │ 95%     │ $0.23    │ 8.7/10  │
│ DeepSeek Harness Runtime│ 3m 42s   │ 98%     │ $0.45    │ 9.2/10  │
│ OpenCode Runtime        │ 1m 48s   │ 88%     │ $0.18    │ 7.9/10  │
└─────────────────────────┴──────────┴─────────┴──────────┴─────────┘
```

### Critérios de Sucesso

- [ ] Pontos de extensão do Harness documentados e plugáveis
- [ ] Pelo menos 2 runtimes alternativos operacionais
- [ ] Ferramenta de comparação de performance e qualidade funcional

### Estimativa

6-8 semanas

---

## Fase 19: High-Performance Sandboxing (WASM & Micro-VMs)

### Objetivos

- Reduzir o overhead de IPC de ~5ms para sub-milissegundos (< 0.2ms)
- Suportar plugins escritos em linguagens compiladas (Rust, Go, Zig) via WebAssembly/WASI
- Isolar capacidades de alto throughput (compaction de contexto, parsers AST, buscas vetoriais)
- Metering de instruções (fuel) para prevenir loops sem travar a thread principal

### Implementação

```typescript
// src/plugin/wasm/host.ts
import { Wasmtime, Store, Linker } from 'wasmtime-node';

export class WasmCapabilityHost {
  private linker: Linker;
  private engine: Wasmtime;

  constructor() {
    this.engine = new Wasmtime();
    this.linker = new Linker(this.engine);
  }

  async createInstance(wasmBytes: Uint8Array, maxFuel: bigint): Promise<WasmPluginInstance> {
    const store = new Store(this.engine);
    store.setFuel(maxFuel);
    const module = await WebAssembly.compile(wasmBytes);
    const instance = await this.linker.instantiate(store, module);
    return new WasmPluginInstance(instance, store);
  }
}
```

### Critérios de Sucesso

- [ ] Runtime WASM/WASI integrado
- [ ] Latência de chamada de capability em WASM < 0.2ms
- [ ] Proteção contra loops infinitos via fuel metering
- [ ] Suporte a plugins compilados em Rust e Go

### Estimativa

4-5 semanas

---

## Fase 20: Federated Capabilities & Multi-Agent Mesh

### Objetivos

- Capacidades distribuídas entre múltiplos servidores, instâncias locais e nós GPU
- Execução remota de inferências pesadas (vLLM, embeddings dedicados) via gRPC com mTLS
- Failover dinâmico: fallback automático para provedores locais se o nó remoto oscilar
- Roteamento inteligente na malha considerando latência e custo

### Implementação

```bash
$ modus mesh join 10.0.4.20:50051 --name "gpu-inference-worker"
Handshake successful with node: gpu-inference-worker
Discovered capabilities:
  ✓ model.embed (text-embedding-3-large)
  ✓ model.complete (qwen-2.5-coder-32b)

$ modus capabilities switch model.embed remote://gpu-inference-worker/model.embed
```

### Critérios de Sucesso

- [ ] RPC mesh bidirecional sobre gRPC + mTLS
- [ ] Descoberta dinâmica e failover em caso de indisponibilidade
- [ ] Latência de nó local/LAN < 10ms

### Estimativa

5-6 semanas

---

## Fase 21: Autonomous JIT Capabilities (Self-Synthesized Plugins)

### Objetivos

- Permitir que o agente sintetize, teste e registre dinamicamente plugins pontuais (*Just-In-Time Capabilities*)
- Sandbox efêmero com suíte de testes sintéticos antes de aprovar a capability
- Classificação estrita com `trustLevel: 'dynamic'` e expiração automática (TTL)
- Auditoria de código gerado gravada em `.modus/audit/synthesized/`

### Implementação

```typescript
// src/plugin/dynamic/synthesizer.ts
export class DynamicCapabilityEngine {
  async synthesizeAndRegister(spec: DynamicCapabilitySpec): Promise<string> {
    // 1. Validar limites de segurança para capacidades dinâmicas
    this.enforceDynamicConstraints(spec.requestedPermissions);

    // 2. Executar testes isolados antes de aprovar
    const testResult = await this.verifier.runIsolatedTests(spec);
    if (!testResult.success) {
      throw new DynamicVerificationError('Generated plugin failed verification');
    }

    // 3. Registrar com TTL
    return await this.registry.registerDynamicProvider(spec, spec.ttlSeconds);
  }
}
```

### Critérios de Sucesso

- [ ] Síntese autônoma de ferramentas com validação pré-registro
- [ ] Limpeza automática após encerramento da sessão ou expiração de TTL
- [ ] Impossibilidade estrutural de elevação de privilégios

### Estimativa

4-5 semanas

---

## Fase 22: Enterprise Governance & Policy-as-Code

### Objetivos

- Motor de políticas declarativas via Open Policy Agent (OPA/Rego)
- Assinatura criptográfica de pacotes via Sigstore/Cosign obrigatória em produção
- Suporte nativo a Registries Privados OCI em redes isoladas (*Air-Gapped*)
- Auditoria em conformidade com padrões corporativos (SOC2, ISO 27001)

### Implementação

```rego
# policies/plugins.rego
package modus.authz

default allow_plugin_install = false

allow_plugin_install {
    input.environment == "production"
    input.signature.valid == true
    input.signature.issuer == "https://auth.enterprise.com"
    input.permissions.network.allowed == false
    input.permissions.sensitive.credentials == false
}
```

### Critérios de Sucesso

- [ ] Políticas Rego avaliadas no fluxo de instalação
- [ ] Validação criptográfica de assinaturas funcionando
- [ ] Compatibilidade comprovada com registros OCI privados

### Estimativa

4-5 semanas

---

---

## Fase 23: UI Contribution Foundation

### Objetivos

- Criar UIContributionRegistry integrado com CapabilityRegistry existente
- Definir contratos de UI slots versionados (`ui.session.header.action`, `ui.activity.timeline.item`, etc)
- Implementar lifecycle integration: enable/disable/rollback de plugins afeta UI contributions
- Schema declarativo básico (button, text, badge, separator) para renderização segura
- **Provenance básico desde o início**: providerId, slot, duration, status, error

### Princípios

- **UI contributions são capabilities** com prefixo `ui.*`
- Reutiliza toda infraestrutura: provenance, versioning, permissions, lifecycle, tracing
- **Declarative-only** na Fase 1: sem React arbitrário, apenas schema JSON
- **Trust level filtering**: Safe Mode remove contributions de plugins externos
- **Brand-neutral contracts**: Nenhum contract público contém "modus" hardcoded

### Naming Strategy (Regra Transversal)

```typescript
// ❌ BAD - Acoplado ao nome do produto
capability: "modus.ui.session.header.action"
interface ModusUISlot { ... }
class ModusUIContribution { ... }

// ✅ GOOD - Brand-neutral
capability: "ui.session.header.action"
interface UISlot { ... }
interface UIContribution { ... }
interface PlatformConfig {
  productName: string;      // "Modus" | "Mave" | "Mavie"
  displayName: string;
  apiNamespace: string;
}
```

**Justificativa**: Rebrand futuro (Modus → Mave/Mavie) não deve quebrar contratos públicos. Esta regra vale desde a Fase 23 até a publicação do SDK.

### Implementação

```typescript
// Plugin manifest
{
  id: "@modus/verifier",
  provides: [
    {
      capability: "verification.run",
      apiVersion: "1.0",
      implementation: "./capabilities/run.js"
    },
    {
      capability: "ui.session.header.action",
      apiVersion: "1.0",
      implementation: "./ui/header-action.js"
    }
  ]
}

// UI contribution (declarative schema)
export async function execute(context: UIContext): Promise<DeclarativeUI> {
  return {
    type: "button",
    label: "Verify",
    icon: "check-circle",
    action: "verifier.run"
  };
}
```

**Slots Iniciais:**
- `ui.session.header.action` → Actions no header da sessão
- `ui.activity.timeline.item` → Items customizados na timeline
- `ui.composer.slash` → Slash commands no composer

### Arquivos Afetados

```
src/capability/ui-slots.ts              → NEW: Slot definitions
src/capability/ui-contribution.ts       → NEW: UI contribution types
src/renderer/ui/UISlot.tsx              → NEW: Slot renderer component
src/renderer/ui/DeclarativeUIRenderer.tsx → NEW: Render declarative schema
src/plugin/loader.ts                    → Register UI contributions
src/plugin/lifecycle.ts                 → Unregister UI on disable
```

### Critérios de Sucesso

- [ ] UI contributions registram como capabilities normais
- [ ] Lifecycle de plugin afeta contributions (enable → UI aparece, disable → UI desaparece)
- [ ] Safe Mode remove contributions de plugins externos
- [ ] Provenance tracking de renders
- [ ] 3 slots implementados e funcionais
- [ ] Schema declarativo validado antes de render

### Estimativa

4-5 semanas

---

## Fase 24: Slot Expansion & Shell Integration

### Objetivos

- Implementar 15+ slots principais cobrindo todo o shell
- Integrar slots no AppShell, TopBar, ActivityTimeline, Composer, ContextSidebar
- Refatorar features existentes para usar slots (opt-in, backward compatible)
- Documentar cada slot com context, constraints e examples

### Slots Completos

```typescript
// Session Header
"ui.session.header.action"      → Buttons/actions no header
"ui.session.header.status"      → Status indicators

// Activity Timeline
"ui.activity.timeline.item"     → Custom timeline items
"ui.activity.timeline.group"    → Group headers

// Composer
"ui.composer.attachment"        → Attachment types (@file, @url, etc)
"ui.composer.mention"           → Mention providers (@...)
"ui.composer.slash"             → Slash commands (/...)

// Context Sidebar
"ui.sidebar.context.item"       → Individual context items
"ui.sidebar.context.section"    → Section headers

// Panels
"ui.panel.primary"              → Main panels (diff, browser, etc)
"ui.panel.secondary"            → Secondary panels
"ui.inspector.tab"              → Inspector tabs

// Settings
"ui.settings.section"           → Non-core settings sections

// Tool Results
"ui.tool.result"                → Custom tool result visualizations

// Workspace
"ui.workspace.status"           → Status bar items
```

### Refatoração Exemplo

```typescript
// BEFORE (hardcoded)
<div className="session-header-actions">
  <Button onClick={verify}>Verify</Button>
  <Button onClick={commit}>Commit</Button>
</div>

// AFTER (slot-based)
<UISlot 
  slot="ui.session.header.action" 
  context={{ sessionId, sessionState }}
/>
```

### Shell Protegido (NUNCA Extensível)

```
✗ Authentication screens
✗ Billing & payment
✗ Permission approval dialogs
✗ Security warnings
✗ Credential management
✗ App update UI
✗ Safe mode UI
✗ Plugin permission prompts
✗ Core settings (API keys)
```

### Critérios de Sucesso

- [ ] 15+ slots implementados e documentados
- [ ] Features existentes migradas para slots (opt-in)
- [ ] Zero regressões visuais ou funcionais
- [ ] Visual regression tests para cada slot
- [ ] Performance: render 100 contributions em < 100ms
- [ ] A11y: keyboard navigation funcional

### Estimativa

5-6 semanas

---

## Fase 25: UI Safety & Isolation

### Objetivos

- Implementar crash containment por contribution
- Resource limits (render time < 100ms, memory < 10MB)
- Graceful degradation quando contribution falha
- Integration com Failure Intelligence para auto-disable problematic providers
- **Estabelecer fronteiras de segurança antes de adaptive UI**

### Isolation Architecture

```typescript
class IsolatedContributionRenderer {
  async render(
    contribution: RegisteredContribution,
    context: UIContext
  ): Promise<ReactNode> {
    const monitor = new ResourceMonitor({
      maxRenderTime: 100, // ms
      maxMemory: 10 * 1024 * 1024 // 10MB
    });
    
    monitor.start();
    
    try {
      const result = await Promise.race([
        this.renderDeclarative(contribution, context),
        this.timeout(100)
      ]);
      
      const usage = monitor.stop();
      
      if (usage.memory > 10 * 1024 * 1024) {
        throw new MemoryLimitExceededError();
      }
      
      return result;
    } catch (error) {
      monitor.stop();
      
      // Record failure
      this.failureIntelligence.recordUIFailure({
        providerId: contribution.providerId,
        slot: contribution.contribution.slot,
        error,
        context
      });
      
      // Graceful degradation
      return this.renderFallback(contribution, error);
    }
  }
}
```

### Error Boundary per Contribution

```typescript
class ContributionErrorBoundary extends React.Component {
  componentDidCatch(error: Error) {
    this.props.onError(error);
    
    const errorCount = this.props.getErrorCount(this.props.providerId);
    
    if (errorCount > 5) {
      // Auto-disable problematic provider
      this.props.disableProvider(this.props.providerId);
    }
  }
  
  render() {
    if (this.state.hasError) {
      return <ContributionError providerId={this.props.providerId} />;
    }
    return this.props.children;
  }
}
```

### Arquivos Afetados

```
src/ui/isolation/boundary.ts              → NEW: Isolation boundary
src/ui/isolation/monitor.ts               → NEW: Resource monitor
src/ui/isolation/error-boundary.tsx       → NEW: Error boundary
src/renderer/ui/ContributionRenderer.tsx  → Wrap with isolation
src/failure/ui-failure-correlation.ts     → NEW: UI failure analysis
```

### Critérios de Sucesso

- [ ] Crash containment funcional
- [ ] Resource limits enforced
- [ ] Graceful degradation
- [ ] Failure Intelligence integrado
- [ ] Auto-disable após 5+ failures
- [ ] User pode manually disable provider
- [ ] Monitoring overhead < 5ms

### Estimativa

3-4 semanas

---

## Fase 26: Contextual Adaptive UI

### Objetivos

- Implementar UIAdaptationEngine que reage a mudanças de estado
- Definir adaptation policies padrão (tool execution, verification, groups)
- Integrar com session state, tool execution, verification state
- Preservar consistência visual, acessibilidade e estado entre adaptações
- **Safety boundaries já estabelecidas na Fase 25**

### Adaptation Triggers

```typescript
interface AdaptationTrigger {
  type: 
    | 'session.state.changed'
    | 'tool.started'
    | 'tool.completed'
    | 'verification.started'
    | 'verification.completed'
    | 'group.state.changed'
    | 'capability.activated';
  
  data: Record<string, unknown>;
}
```

### Policies Exemplo

```typescript
// Policy 1: Tool execution focus
{
  trigger: { type: 'tool.started', tool: 'Bash' },
  adaptation: {
    expandPanel: 'terminal',
    prioritize: [{ slot: 'ui.inspector.tab', provider: '@modus/terminal' }],
    hide: ['ui.activity.timeline.item'] // Reduce noise
  },
  preserveState: true
}

// Policy 2: Verification focus
{
  trigger: { type: 'verification.started' },
  adaptation: {
    show: ['ui.session.header.status'],
    prioritize: [{ slot: 'ui.activity.timeline.item', provider: '@modus/verifier' }],
    focusSlot: 'ui.activity.timeline.item'
  },
  preserveState: true
}
```

### State Preservation

```typescript
interface UIStateSnapshot {
  slotVisibility: Map<UISlotId, boolean>;
  contributionOrder: Map<UISlotId, string[]>;
  panelSizes: Map<string, number>;
  scrollPositions: Map<string, number>;
  focusPath: string[];
}
```

### Arquivos Afetados

```
src/ui/adaptation/engine.ts               → NEW: Adaptation engine
src/ui/adaptation/policies.ts             → NEW: Built-in policies
src/ui/adaptation/state-manager.ts        → NEW: State preservation
src/renderer/features/agent/runState.ts   → Trigger adaptations
src/capability/ui-contribution.ts         → Condition evaluation
```

### Critérios de Sucesso

- [ ] Adaptation engine funcional
- [ ] 5+ built-in policies
- [ ] State preservation entre adaptações
- [ ] No layout shifts > 100ms
- [ ] Keyboard navigation preservado
- [ ] User pode desabilitar adaptações
- [ ] Scenario test: Tool starts → panel expands → tool completes → restores

### Estimativa

4-5 semanas

---

## Fase 27: Observability & Debugging

### Objetivos

- Full provenance tracking de UI renders
- Developer tools para inspecionar contributions
- Performance profiling de contributions
- Integration com HarnessObserver existente

### UI Contribution Debugger

```typescript
interface UIContributionDebugger {
  listActive(): ActiveContribution[];
  inspect(providerId: string, slot: UISlotId): ContributionInspection;
  profile(providerId: string): ContributionProfile;
  getHistory(providerId: string): RenderHistory[];
  forceRender(providerId: string, slot: UISlotId): void;
}

interface ContributionInspection {
  providerId: string;
  providerVersion: string;
  trustLevel: TrustLevel;
  slot: UISlotId;
  
  renderCount: number;
  avgRenderTime: number;
  maxRenderTime: number;
  memoryUsage: number;
  errorCount: number;
  lastError?: Error;
}
```

### DevTools UI

```typescript
// Settings > Developer > UI Contributions
function ContributionDevTools() {
  return (
    <Panel title="UI Contributions">
      <Tabs>
        <Tab label="Active">
          <ContributionList contributions={contributions} />
        </Tab>
        <Tab label="Performance">
          <ContributionPerformance />
        </Tab>
        <Tab label="History">
          <ContributionHistory />
        </Tab>
      </Tabs>
    </Panel>
  );
}
```

### Integration com HarnessObserver

```typescript
interface ExtendedHarnessEvent {
  // ... campos existentes
  
  ui?: {
    contributionsRendered: number;
    slowContributions: Array<{
      providerId: string;
      slot: UISlotId;
      duration: number;
    }>;
    failedContributions: Array<{
      providerId: string;
      slot: UISlotId;
      error: string;
    }>;
  };
}
```

### Arquivos Afetados

```
src/ui/observability/debugger.ts                → NEW: Debugger API
src/renderer/features/settings/sections/ui-contributions.tsx → NEW: DevTools UI
src/observability/harness-observer.ts           → Extend with UI events
src/ui/observability/contribution-profiler.ts   → NEW: Performance profiler
```

### Critérios de Sucesso

- [ ] DevTools panel acessível em settings
- [ ] Provenance completo de renders
- [ ] Performance profiling funcional
- [ ] Integration com HarnessObserver
- [ ] Export de debug data
- [ ] Tracking overhead < 2ms per render

### Estimativa

2-3 semanas

---

## Fase 28: Safe Mode & Rollback Integration

### Objetivos

- Safe Mode remove contributions de plugins externos
- Rollback restaura contributions anteriores
- Trust level filtering (`core` | `official` | `verified` | `community` | `local`)
- Recovery de estado de UI

### Safe Mode UI Controller

```typescript
class SafeModeUIController {
  async enterSafeMode(level: SafeModeLevel): Promise<void> {
    // 1. Snapshot current UI state
    const snapshot = this.stateManager.snapshot('safe-mode-entry');
    
    // 2. Get trust levels for this mode
    const allowedTrust = this.getTrustLevelsForMode(level);
    // 'core' → ['core']
    // 'official' → ['core', 'official']
    // 'verified' → ['core', 'official', 'verified']
    
    // 3. Disable contributions from untrusted providers
    const allContributions = this.registry.listAll();
    
    for (const contribution of allContributions) {
      if (!allowedTrust.includes(contribution.trustLevel)) {
        this.registry.unregister(contribution.providerId);
      }
    }
    
    // 4. Force re-render of all slots
    this.forceReRenderAllSlots();
  }
}
```

### Rollback Integration

```typescript
class UIContributionVersionManager {
  async rollbackProvider(providerId: string, targetVersion: string): Promise<void> {
    // 1. Snapshot current UI
    const snapshot = this.stateManager.snapshot(`rollback-${providerId}`);
    
    // 2. Unregister current contributions
    this.registry.unregister(providerId);
    
    // 3. Rollback plugin (reuses Fase 15 infrastructure)
    await this.pluginVersionManager.rollback(providerId, targetVersion);
    
    // 4. Plugin loader re-registers contributions from old version
    // This happens automatically through plugin lifecycle
    
    // 5. Verify UI restored correctly
    const restored = this.registry.getByProvider(providerId);
    if (restored.length === 0) {
      await this.pluginVersionManager.rollback(providerId, snapshot.version);
    }
  }
}
```

### Arquivos Afetados

```
src/plugin/safe-mode.ts                  → Extend with UI filtering
src/plugin/version-manager.ts            → Extend with UI rollback
src/ui/state-manager.ts                  → State snapshots
src/renderer/components/shell/SafeModeIndicator.tsx → NEW: Visual indicator
```

### Critérios de Sucesso

- [ ] Safe Mode filtra contributions por trust level
- [ ] Rollback restaura contributions anteriores
- [ ] Estado de UI preservado durante transições
- [ ] Visual indicator de Safe Mode
- [ ] Recovery automático se rollback falhar

### Estimativa

2-3 semanas

---

## Fase 29: Dynamic/JIT UI (Declarative Phase 1)

### Objetivos

- JIT capabilities (Fase 21) podem solicitar visualizações efêmeras
- Schema declarativo (não React arbitrário)
- TTL automático e destruição quando capability termina
- Permissions herdadas da capability
- Audit trail completo

### JIT UI Contribution

```typescript
interface JITUIContribution {
  capabilityId: string;           // Linked to JIT capability
  slot: UISlotId;
  render: DeclarativeUI;
  
  ttl: number;                    // Seconds
  destroyOnCapabilityEnd: boolean; // true default
  
  permissions: UIContributionPermissions;
  requestedBy: string;            // Which agent/tool
  requestedAt: Date;
}

class JITUIManager {
  async requestJITUI(
    capabilityId: string,
    contribution: JITUIContribution
  ): Promise<string> {
    // 1. Validate capability exists and is JIT
    const capability = this.capabilityRegistry.get(capabilityId);
    if (!capability?.isJIT) {
      throw new Error('Not a JIT capability');
    }
    
    // 2. Validate permissions
    if (!this.permissionBroker.canShowUI(contribution.permissions)) {
      throw new PermissionDeniedError('ui.show');
    }
    
    // 3. Validate declarative schema
    this.validateDeclarativeUI(contribution.render);
    
    // 4. Register ephemeral contribution
    const contributionId = generateContributionId();
    this.registry.registerJIT(contributionId, contribution);
    
    // 5. Schedule destruction
    this.scheduleDestruction(contributionId, contribution.ttl);
    
    // 6. Audit
    this.audit.log({
      type: 'jit_ui_requested',
      capabilityId,
      contributionId,
      slot: contribution.slot,
      ttl: contribution.ttl
    });
    
    return contributionId;
  }
}
```

### Approved Component Registry

```typescript
// Phase 1: Only pre-approved components
const APPROVED_COMPONENTS = {
  'code-review-table': CodeReviewTable,
  'diff-viewer': DiffViewer,
  'chart': Chart,
  'tree-view': TreeView,
  'timeline': Timeline
};
```

### Example Usage

```typescript
// JIT capability requests temporary UI
const contributionId = await jitUIManager.requestJITUI(
  'jit.analysis.code-review',
  {
    capabilityId: 'jit.analysis.code-review',
    slot: 'ui.panel.primary',
    render: {
      type: 'layout',
      direction: 'column',
      children: [
        {
          type: 'text',
          content: '# Code Review Results',
          markdown: true
        },
        {
          type: 'custom',
          componentId: 'code-review-table',
          props: { findings: [...] }
        }
      ]
    },
    ttl: 300, // 5 minutes
    destroyOnCapabilityEnd: true,
    permissions: { allowExternalLinks: false },
    requestedBy: 'agent:main'
  }
);
```

### Arquivos Afetados

```
src/capability/jit-ui-manager.ts          → NEW: JIT UI manager
src/ui/approved-components.tsx            → NEW: Approved component registry
src/renderer/ui/DeclarativeUIRenderer.tsx → Support custom components
src/capability/jit-capabilities.ts        → Extend with UI requests
```

### Critérios de Sucesso

- [ ] JIT capabilities podem solicitar UI
- [ ] TTL funciona corretamente
- [ ] Permissions enforced
- [ ] Audit trail completo
- [ ] 5+ approved components
- [ ] Destruction automática funcional
- [ ] Memory leaks prevented

### Estimativa

4-5 semanas

---

## Resumo das Fases e Ordem Real de Execução

### Tabela de Fases (Referência Numérica)

```
FASE                              ESCOPO                   ESTIMATIVA
────────────────────────────────────────────────────────────────────────
Fase 9:  Capability Registry      Foundation               2-3 semanas
Fase 10A: Piloto (3 plugins)      Foundation               2-3 semanas
Fase 10B: Migração Incremental    Foundation               2-3 semanas
Fase 11: Plugin Lifecycle         Runtime                  3-4 semanas
Fase 12: Plugin Tracing           Observability            2-3 semanas
Fase 13: Isolamento e Segurança   Hardening                5-6 semanas
Fase 14: Dependency Intelligence  Graph & Planner          2-3 semanas
Fase 15: Rollback e Safe Mode     Resilience               3-4 semanas
Fase 16: Plugin SDK Público       Developer Experience     4-5 semanas
Fase 17: Marketplace Central      Distribution             6-8 semanas
Fase 18: Harness Marketplace      Plataformização          6-8 semanas
Fase 19: WASM & High-Perf Sandbox Performance/Polyglot     4-5 semanas
Fase 20: Federated Capability Mesh Distribuição            5-6 semanas
Fase 21: Autonomous JIT Plugins   Agente Autônomo          4-5 semanas
Fase 22: Enterprise Governance    Compliance & OPA         4-5 semanas
Fase 23: UI Contribution Foundation UI Extensibility       4-5 semanas
Fase 24: Slot Expansion           UI Integration           5-6 semanas
Fase 25: UI Safety & Isolation    UI Hardening             3-4 semanas
Fase 26: Contextual Adaptive UI   Adaptive UX              4-5 semanas
Fase 27: UI Observability         UI Debugging             2-3 semanas
Fase 28: UI Safe Mode Integration UI Recovery              2-3 semanas
Fase 29: Dynamic/JIT UI           Ephemeral UI             4-5 semanas
────────────────────────────────────────────────────────────────────────
```

### Ordem Real de Execução

```
BLOCO 1: PLUGIN FOUNDATION & HARDENING
────────────────────────────────────────
9 → 10A → 10B → 11 → 12 → 13 → 14 → 15
(~22-31 semanas)

    ↓

BLOCO 2: REAL SANDBOX & SECURITY AUDIT
────────────────────────────────────────
19 → AUDITORIA GERAL → CORREÇÕES → SEGUNDA AUDITORIA
(~6-8 semanas incluindo auditorias)

    ↓

BLOCO 3: UI EXTENSÍVEL & ADAPTATIVA
────────────────────────────────────────
23 → 24 → 25 → 26 → 27 → 28
(~25-31 semanas)

    ↓

BLOCO 4: JIT CAPABILITIES & UI
────────────────────────────────────────
21 → 29
(~8-10 semanas)

    ↓

CORE / UX REVIEW
────────────────────────────────────────
- Internal dogfooding completo
- UX validation com usuários reais
- Performance benchmarks
- Documentation review completo
(~3-4 semanas)

    ↓

BLOCO 5: PUBLIC ECOSYSTEM
────────────────────────────────────────
16 → 17 → 18
(~16-21 semanas)

    ↓

BLOCO 6: ADVANCED/ENTERPRISE (Opcional)
────────────────────────────────────────
20 → 22
(~9-11 semanas)

────────────────────────────────────────
TOTAL ACUMULADO: ~89-116 semanas (21-27 meses)
```

**Nota sobre Ordem de Execução**:

1. **UI antes de SDK público (23-28 antes de 16-18)**: Descobrir erros de design de UI enquanto tudo é interno, antes de publicar contratos externos
2. **Safety antes de Adaptive (25 antes de 26)**: Fronteiras de segurança estabelecidas antes de adaptação automática
3. **Auditoria após sandbox real (19 → audit → 23)**: Validar isolamento completo antes de expandir para UI
4. **JIT UI após JIT Capabilities (21 → 29)**: Capabilities efêmeras precisam existir antes de solicitar UI efêmera
5. **SDK já completo na publicação (16)**: Quando publicado, inclui runtime + plugins + UI como arquitetura unificada

---
Fase 22: Enterprise Governance    Compliance & OPA     4-5 semanas
Fase 23: UI Contribution Foundation UI Extensibility   4-5 semanas
Fase 24: Slot Expansion           UI Integration       5-6 semanas
Fase 25: Contextual Adaptive UI   Adaptive UX          4-5 semanas
Fase 26: UI Isolation & Safety    UI Hardening         3-4 semanas
Fase 27: UI Observability         UI Debugging         2-3 semanas
Fase 28: UI Safe Mode Integration UI Recovery          2-3 semanas
Fase 29: Dynamic/JIT UI           Ephemeral UI         4-5 semanas
Fase 30: Branding Compatibility   Future-Proofing      1-2 semanas
────────────────────────────────────────────────────────────────────────
TOTAL ACUMULADO (Fases 9 a 30)                         79-107 semanas (19-25 meses)
```

---

## Riscos e Mitigações

1. **Overhead de Performance**: Mitigado com benchmarks contínuos em cada fase, caches de carregamento e runtime WASM para capacidades de alta frequência.
2. **Vulnerabilidades de Segurança**: Mitigado com process isolation (Fase 13), permission brokers estritos e varredura estática no marketplace.
3. **Fragmentação de Contratos**: Mitigado com separação rígida entre versão de capability e versão de plugin, além de testes de regressão automatizados.
4. **Complexidade Excessiva**: Mitigado pela abordagem *Internal-First*, validando primeiro os subsistemas nativos do próprio Modus.

---

## Métricas de Sucesso Globais

- **Fases 9-10 (Foundation)**: 100% dos componentes nativos expostos via capabilities; overhead < 3%; zero regressões em suítes de testes.
- **Fases 11-15 (Hardening)**: Lifecycle 100% funcional em SQLite; Safe Mode recupera o agente de qualquer estado falho; zero violações de sandbox nos testes de escape.
- **Fases 16-18 (Ecosystem & Platform)**: Mais de 50 plugins publicados no primeiro trimestre; pelo menos 3 runtimes de harness alternativos viáveis.
- **Fases 19-22 (Scale & Enterprise)**: Chamadas WASM < 0.2ms; malha multi-agente funcional com failover automático; aprovação em auditoria de segurança corporativa.

---

## Plano de Ação Imediato: Kickoff da Fase 9

### Sprint 9.1 — Tipagem Base e Estruturas em Memória
- Criar diretório `src/capability/` com tipos base (`Capability`, `CapabilityProvider`, `CapabilityProvenance`).
- Implementar `CapabilityRegistry` em memória com validações de ID e semver.
- Testes unitários para registro e detecção de duplicatas.

### Sprint 9.2 — Provedores Múltiplos, Seleção e Resolução
- Mecanismo de resolução com cascata de `TrustLevel` (`core` > `official` > `verified` > `community` > `local`).
- Implementar `activateProvider` e validação estrita de contratos de API.

### Sprint 9.3 — Pipeline de Execução, Provenance e Métricas
- Método de execução `registry.execute<T>()` integrado a telemetria e OpenTelemetry.
- Coleta contínua de métricas de latência e contagem de falhas.

### Sprint 9.4 — Migração dos Módulos Nativos e Interface CLI
- Migrar `memory`, `context`, `tools` e `verification` para registrarem suas capacidades.
- Implementar comandos `modus capabilities list`, `info` e `switch`.
- Documentação inicial em `docs/architecture/capabilities.md`.

---

## Architectural Decision Records (ADRs) Iniciais

### ADR-001: Separação Estrita de Versão da API de Capability vs Versão do Plugin
* **Decisão**: A versão do contrato da capability (`capabilityApiVersion: "1.0"`) é independente da versão de release do plugin (`providerVersion: "2.4.1"`).
* **Consequência**: Correções e melhorias em plugins não forçam alterações no núcleo do agente ou nos consumidores.

### ADR-002: Brokered Process Isolation vs `node:vm`
* **Decisão**: Plugins comunitários executam em processos isolados dedicados sem acesso direto a `fs` ou `net`, solicitando I/O via Brokers com permissões estritas.
* **Consequência**: Impossibilidade de travamento da thread principal do Modus ou vazamento de segredos via código não confiável.

### ADR-003: SQLite como State Store Operacional de Plugins
* **Decisão**: O estado de ativação, versões instaladas, históricos e métricas são persistidos no banco transacional `.modus/plugins/state.db` (SQLite em modo WAL).
* **Consequência**: Operações transacionais atômicas, garantindo consistência e rollback determinístico após falhas.
