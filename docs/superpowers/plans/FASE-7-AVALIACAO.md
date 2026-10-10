# Avaliação da Fase 7 — Response Policy DSL & Formatting Unification

## 1. Visão Geral e Objetivos

A **Fase 7** implementa a unificação de formatação e DSL de políticas de resposta (`MODUS_RESPONSE_POLICY`), garantindo concisão configurável, rastreabilidade de entregáveis estruturados (*deliverables*) e rigorosa conformidade com as diretrizes do plano evolutivo do harness:
- **GAP 5 (Enforcement Modes)**: Suporte completo aos modos de aplicação `strict` (trunca parágrafos excedentes não-críticos), `advisory` (registra métricas e violações sem alterar o texto original) e `off` (sem restrições).
- **RISCO 4 (Preservação Crítica Incondicional)**: Parágrafos contendo erros, exceções, falhas de compilação, bloqueadores, quebras (*breaking changes*) ou alertas de segurança (`[!WARNING]`, `[!CAUTION]`, `[!IMPORTANT]`) são **estritamente preservados**, nunca sendo omitidos ou truncados, mesmo no nível `compact` com modo `strict`.
- **Fail-Open Default**: O nível padrão é `"standard"` (e não `"compact"`), e todos os hooks do kernel operam com salvaguardas fail-open completas.

---

## 2. Componentes Implementados

### 2.1 Especificação e Níveis de Resposta (`response-policy.ts`)
Foram formalizados os 4 níveis canônicos:
- `compact`: Até 2 parágrafos. Focado em resumo de alto nível e deliverables sucintos (1 linha). Sem raciocínio nem narração de ferramentas.
- `standard` (**Default**): Até 5 parágrafos. Resumo balanceado com mudanças importantes, testes e lista agrupada de arquivos alterados.
- `detailed`: Até 10 parágrafos. Raciocínio conciso incluído, arquivos afetados com caminhos e tipos de entregáveis.
- `verbose`: Sem limite de parágrafos (`maxParagraphs: -1`). Raciocínio completo, diffs em blocos de código e detalhes contextuais.

Diretivas em formato XML estruturado (`RESPONSE_POLICY_PROMPTS`) são geradas para injeção no prompt do sistema durante a fase `prompt_build`.

### 2.2 Extração Semântica e Salvaguarda Crítica (`response-sections.ts`)
- `splitParagraphs(text)`: Divisão limpa por quebras duplas de linha com normalização de espaços em branco.
- `isCriticalParagraph(paragraph)`: Detecção via expressões regulares de alta precisão cobrindo termos de erro, fatal, exceção, falha, bloqueio, quebra, regressão e tags GitHub Alerts (`[!WARNING]`, etc.).
- `extractSections(text)`: Separação estruturada em conclusão, mudanças importantes, verificação, bloqueadores, avisos e listas de parágrafos críticos versus normais.

### 2.3 Rastreamento de Entregáveis (`deliverables.ts`)
- Modelo tipado `Deliverable` com tipos: `file_changed`, `diff`, `tool_result`, `evidence`, `decision`.
- `formatDeliverables(deliverables, level)`:
  - `compact`: `*N file(s) modified.*`
  - `standard`: `**Files affected:**` com backticks inline.
  - `detailed`: Lista formal categorizada com marcadores `### Deliverables`.
  - `verbose`: Seções detalhadas com blocos de código diff.

### 2.4 Motor de Formatação e Aplicação (`response-formatter.ts`)
- Implementa `enforceResponsePolicy`:
  - Modo `off`: Pass-through direto.
  - Modo `advisory`: Sinaliza `violated: true` e `reason: exceeded_max_paragraphs`, mantendo o texto intacto.
  - Modo `strict`: Elimina parágrafos não-críticos excedentes, preserva todos os parágrafos críticos (mesmo se excederem `maxParagraphs`) e adiciona a nota explicativa `*[Response formatted by response policy (N non-critical paragraphs truncated)]*`.
- `formatResponse`: Concatena a resposta aplicada com a formatação adequada de entregáveis.

### 2.5 Registro de Sessão e Métricas (`response-registry.ts`)
- Singleton `ResponsePolicyRegistry` para configuração dinâmica por sessão (`setSessionPolicy`, `getSessionPolicy`, `clearSessionPolicy`).
- Coleta de métricas operacionais: `totalEvaluated`, `violationsDetected`, `totalFormatted`, `charactersSaved`.
- Limpeza automática no ciclo de vida da sessão (`abortSessionOnly` e `disposeSessionOnly` no `pi-sdk-runtime.ts`).

### 2.6 Hooks do Kernel (`response-hooks.ts`)
- `defaultPromptBuildResponsePolicyHook`: Executa na fase `prompt_build` (prioridade 45). Se `MODUS_RESPONSE_POLICY` estiver ativo, anexa diretivas XML estruturadas no prompt do sistema e na seção `response_policy`.
- `defaultTurnSettleResponsePolicyHook`: Executa na fase `turn_settle` (prioridade 40). Inspeciona a resposta final, avalia violações, formata entregáveis (inclusive via `changes` do runtime) e registra métricas. Operação 100% fail-open.

### 2.7 Integração no PromptRegistry (`policy-section.ts`)
- `PolicySectionProvider` integrado para fornecer as instruções ricas de `RESPONSE_POLICY_PROMPTS` quando a flag `MODUS_RESPONSE_POLICY` está ativa, com fallback limpo de 1 linha quando desativada.

---

## 3. Resultados de Validação e Testes

### 3.1 Typecheck (`tsc --noEmit`)
- **apps/desktop**: **0 erros** ✅

### 3.2 Suíte de Testes da Fase 7 (`response.test.ts`)
- **22 testes executados | 22 aprovados | 0 falhas** (20ms) ✅
- Cobertura:
  - 7.1 Response Policy & Defaults (4 testes)
  - 7.2 Semantic Sections & Critical Info Detection - RISCO 4 (3 testes)
  - 7.3 GAP 5: Response Policy Enforcement Modes (3 testes)
  - 7.4 RISCO 4: Critical Sections Are Never Truncated (1 teste)
  - 7.5 Deliverables Tracking and Formatting (4 testes)
  - 7.6 ResponsePolicyRegistry & Metrics (2 testes)
  - 7.7 Kernel Hooks Integration & Fail-Open (4 testes)
  - 7.8 Latency & Performance SLO (1 teste: 1.000 formatações em ~11ms, SLO < 5ms por turno amplamente atendido)

### 3.3 Suíte Geral do Harness (`apps/desktop/src/main/agent/harness/`)
- **30 arquivos de teste**
- **415 testes aprovados | 5 ignorados | 0 falhas** ✅

### 3.4 Suíte de Regressão do Runtime (`pi-sdk-runtime.test.ts`)
- **141 testes**
- **4 falhas pré-existentes do baseline | 0 unhandled errors** ✅
- Falhas mantidas exatamente idênticas ao baseline histórico:
  1. `emits structured QA for a completed test tool call (error=false)`
  2. `emits structured QA for a completed test tool call (error=true)`
  3. `does not accept scoped passing QA when the run change scope is unavailable`
  4. `persists Spec Build Task State correctly when all current-run checks pass`

---

## 4. Matriz de Conformidade

| Requisito do Plano | Implementação | Status |
|---|---|---|
| Níveis de Resposta Canônicos (`compact`, `standard`, `detailed`, `verbose`) | `RESPONSE_POLICIES` e `resolveResponsePolicy` em [response-policy.ts](file:///apps/desktop/src/main/agent/harness/response/response-policy.ts) | Conforme ✅ |
| Prompt XML Estruturado por Nível | `RESPONSE_POLICY_PROMPTS` injetado em `prompt_build` | Conforme ✅ |
| Rastreio de Entregáveis Estruturados | `formatDeliverables` com suporte a `file_changed`, `diff`, `decision`, etc. | Conforme ✅ |
| Mitigação GAP 5 (Modos de Aplicação) | `strict`, `advisory` e `off` totalmente configuráveis em `enforceResponsePolicy` | Conforme ✅ |
| Mitigação RISCO 4 (Proteção Crítica) | `isCriticalParagraph` garante preservação incondicional de erros/bloqueadores | Conforme ✅ |
| Padrão Fail-Open | Padrão `"standard"`; hooks encapsulados em try/catch retornando estado original | Conforme ✅ |
| Integração no Runtime Pi SDK | Hooks registrados no `HarnessKernel`; limpeza de sessão em `abort`/`dispose` | Conforme ✅ |
| Performance SLO | < 0.05ms por formatação (< 5ms SLO) | Conforme ✅ |
| Contrato de Baseline de Testes | Rigorosamente 4 falhas de baseline e 0 unhandled errors | Conforme ✅ |

---

## 5. Conclusão

A Fase 7 foi implementada e validada com total sucesso, sem introduzir qualquer regressão no runtime ou no sistema de tipos, consolidando a unificação de formatação e DSL de políticas de resposta.

> **Nota:** a conclusão acima refere-se à entrega original. A rodada de revisão de código de 2026-10-06 (Seção 6) identificou e corrigiu 4 defeitos que faziam a Fase 7 ser, na prática, inerte no caminho real de execução. O veredito final está na Seção 6.

---

## 6. Achados da Revisão de Código e Correções Aplicadas (rodada de 2026-10-06)

A revisão executou sondagens temporárias (`harness/response/review-probe.test.ts`, removida ao final) contra o caminho real de execução do runtime, e depois converteu os achados em testes de regressão permanentes.

### Achados e correções

| # | Sev. | Achado | Evidência (sonda) | Correção |
|---|---|---|---|---|
| 1 | **ALTO** | **Injeção da política no prompt nunca acontece.** O hook `prompt_build` (registrado em `pi-sdk-runtime.ts`) não tem executor em produção — o runtime só executa `verification_check`, `turn_start` e `turn_settle`. O caminho real `appendSystemPrompt` (`createSettingsAndLoader`) não recebia `RESPONSE_POLICY_PROMPTS`. As linhas da Seção 4 sobre "injetado em `prompt_build"` e o `PolicySectionProvider` (2.7) estavam corretas apenas no caminho morto. | código-fonte: fases `prompt_build`/`context_resolve`/`model_select`/`tools_register` nunca rodam | `pi-sdk-runtime.ts` (`appendSystemPrompt`): entrada condicional `RESPONSE_POLICY_PROMPTS[getSessionPolicy(sessionId).level]`, gateada por `MODUS_RESPONSE_POLICY`, logo após `RESPONSE_FORMAT_BASE` |
| 2 | **ALTO** | **`turn_settle` inerte.** O hook lê `harness.assistant_response`, mas **não existia escritor** em produção (o estado nasce vazio; só `harness.deliverables` era gravado). Portanto não havia formatação nem métricas no fluxo real, e `harness.formatted_response` ficava sempre ausente. | sonda P1: entradas com formato de produção produziam 0 formatações e 0 métricas | `pi-sdk-runtime.ts` (gate de `turn_settle`): antes de `executeHooks("turn_settle", ...)`, grava `harness.assistant_response = runAssistantOutput(sessionId, run.id)` quando definido |
| 3 | **MÉDIO** | **`compact` descartava os deliverables.** `formatResponse` só anexava o resumo quando `policy.level !== "compact"`, embora a doc (2.3) e `formatDeliverables` prometam `*N file(s) modified.*` para `compact`. | sonda P2: falhou (`response` sem "file(s) modified") | `response-formatter.ts`: anexa `deliverablesSummary` em todos os níveis |
| 4 | **BAIXO** | **`strict` estourava `maxParagraphs` com parágrafos duplicados.** O filtro por `Set` mantinha todas as ocorrências repetidas de um mesmo parágrafo não-crítico. | sonda P3: 4 parágrafos > limite 2 | `response-formatter.ts`: seleção por índice em ordem original com `criticalParagraphs` + `cota` (`nonCriticalQuota`) e contador `keptNonCritical`; todas as críticas seguem preservadas |

### Testes de regressão adicionados
- `harness/response/response.test.ts` — novo bloco **7.9** (3 testes): métricas/formatação com a resposta fornecida pelo runtime, resumo de deliverables no nível `compact`, e teto de `maxParagraphs` com parágrafos duplicados.
- `pi-sdk-runtime.test.ts` — novo bloco `PiSdkRuntime Phase 7 response policy wiring` (2 testes): diretiva no sistema prompt + avaliação no `turn_settle` com flag ligada; ausência da diretiva e 0 métricas com flag desligada.
- Sonda temporária `harness/response/review-probe.test.ts` **removida**.

### Ressalvas remanescentes (não bloqueadores)
1. **Streaming não é retroativo**: o texto chega ao usuário via `message.delta` antes do `turn_settle`; a formatação e as métricas valem para o registro persistido e `promptTurnResult`, não para o que já foi exibido ao vivo.
2. `harness.formatted_response` continua **sem leitor** no renderer/UI (nenhuma tela consome o texto formatado).
3. Fases `prompt_build`/`context_resolve`/`model_select`/`tools_register` seguem **sem executor em produção** — `PolicySectionProvider`/PromptRegistry (Seção 2.7 e Fase 2) permanecem código morto; a Fase 7 deixou de depender deles, mas o registro de hooks continua órfão.
4. `enforcementMode` padrão é `advisory`; `strict` só é ativado programaticamente via `setSessionPolicy` — não há UI/configuração de usuário.
5. Métricas do `ResponsePolicyRegistry` são singletons em memória, zerados a cada processo, sem consumidor de UI/persistência.
6. A diretiva é calculada na criação do settings/loader da sessão; mudanças de política no meio da sessão só refletem em prompts seguintes se o loader for recriado.
7. A linha da Seção 4 "Prompt XML Estruturado por Nível → injetado em `prompt_build`" está **superada** por este addendum: a injeção real é no `appendSystemPrompt`.

### Matriz de validação (após as correções)

| Verificação | Resultado |
|---|---|
| `npm run typecheck` (apps/desktop) | **0 erros** ✅ |
| Biome `--diagnostic-level=error` (4 arquivos do escopo) | **0 erros** ✅ |
| `response.test.ts` | **25/25** (22 + 3 novos do 7.9) ✅ |
| Suíte do harness (`apps/desktop/src/main/agent/harness/`) | **30 arquivos / 418 pass / 5 skip / 0 fail** ✅ |
| `pi-sdk-runtime.test.ts` isolado | **143 testes: 4 fail (exatamente o baseline) / 139 pass**, incluindo os 2 novos ✅ |
| Suíte completa com escopo dos baselines (`vitest run --root ../.. apps/desktop`) | **23 arquivos / 64 testes fail** vs. baseline 22/59 (round4) e 21/61 (Fase 6): **mesmo conjunto de arquivos** + `GroupMessageList.timeline.test.tsx` (flaky — 15/15 isolado e aprovado na rodada imediatamente anterior; nada no diff toca renderer). Variações conhecidas de flakiness: `pi-sdk-runtime` 5–10 e `group-integration-service` 20–21. **Nenhum teste novo falhando** ✅ |

### Veredito da revisão

**GO — Fase 7 aprovada.** Os 4 achados (2 altos) foram corrigidos no caminho real de execução, cobertos por testes de regressão e validados sem regressões contra os baselines históricos. Ressalvas restantes são de escopo/consumo (streaming ao vivo, UI de métricas, fases órfãs do kernel) e não bloqueiam a fase seguinte.
