# Fase 5: Repeat Guards & Circuit Breakers — Relatório de Conclusão e Avaliação

**Data**: 2026-10-06  
**Status**: Concluído com Sucesso ✅  
**Feature Flag**: `MODUS_REPEAT_GUARDS` (requer `MODUS_USE_KERNEL`)

---

## 1. Resumo Executivo

A Fase 5 introduziu salvaguardas proativas contra loops repetitivos de chamadas de ferramentas, cycling de hipóteses estéreis de diagnóstico e travamento de estratégias de falha no pipeline de execução do Modus.

Todos os módulos foram implementados com estrita conformidade aos princípios de **fail-open** (não bloquear nem travar sessões interativas em caso de exceção de guard) e **calibração de baixa taxa de falso-positivo (< 5% FP)**, com whitelist explícita de ferramentas somente-leitura.

---

## 2. Componentes Entregues

### 2.1 Configuração Calibrada (`repeat-guard-config.ts`)
- **Janela deslizante**: 300.000 ms (5 minutos)
- **Threshold de repetição de ferramentas**: 3 invocações com os mesmos argumentos para ferramentas mutantes (threshold relaxado para 6 em ferramentas na whitelist de leitura).
- **Razão de diversidade de hipóteses**: Mínimo de 0.50 (50%).
- **Circuit breaker**: disparo automático ao alcançar 5 tentativas de falha registradas no ledger da run (contagem total de falhas do run, não necessariamente consecutivas).
- **Whitelist de ferramentas de leitura/inspeção**: `view_file`, `client_view_file`, `retrieve_spilled_tool_result`, `search_files`, `grep_search`, `list_dir`, `find_by_name`, `read_url_content`.

### 2.2 Repeat Tool Guard (`repeat-tool-guard.ts`)
- **Fingerprinting determinístico**: Normalização recursiva de parâmetros e hashing SHA-256 (`fingerprintToolArgs`).
- **Análise em janela temporal**: Filtragem estrita dentro de `windowMs` (`detectRepeatTools`).
- **Rastreamento em memória limitado**: `ToolInvocationTracker` com expiração de TTL e limite máximo de 200 entradas por sessão, prevenindo memory leaks.

### 2.3 Repeat Hypothesis Guard (`repeat-hypothesis-guard.ts`)
- **Análise de hipóteses adaptativas**: Inspeção de `AdaptiveFailureAttempt` e categorização de hipóteses de falha repetidas (`detectRepeatHypothesis`).
- **Cálculo de diversidade**: `hypothesisDiversityRatio = uniqueHypotheses / totalAttempts`.
- **Extração de estratégias travadas**: Identificação de estratégias dominantes falhas (`dominantStuckStrategy`) para exclusão proativa.

### 2.4 Failure Loop Guard & Circuit Breaker (`failure-loop-guard.ts`)
- **Ações graduais de contenção (`detectFailureLoop`)**:
  - `none`: Operação regular.
  - `change_strategy`: Disparado quando repetição de ferramenta ou hipótese é detectada, forçando o planejador a evitar o código de estratégia falho.
  - `delegate`: Recomenda delegação para especialistas (`debugger` ou `explore`) quando há falhas persistentes.
  - `circuit_break`: Disparado ao atingir o limite estrito (5 tentativas).
- **CircuitBreakerRegistry**: Gerenciador de estado singleton (`closed` → `open`, reset por sessão). O estado `half_open` está tipado mas ainda não é transitado (recuperação atual = `reset()` na dispose da sessão).

### 2.5 Kernel Hooks & Lifecycle (`repeat-guard-hook.ts`)
- **`defaultTurnStartRepeatGuardHook` (prioridade 25)**: Monitora o estado do circuit breaker no início de cada turno, injeta avisos no contexto do harness sem abortar o fluxo interativo (fail-open).
- **`defaultVerificationRepeatGuardHook` (prioridade 30)**: Avalia o histórico de falhas no checkpoint de verificação, aciona o circuit breaker se necessário e sugere ação `replan`.

### 2.6 Integração com MetaController e Runtime
- **MetaController (`meta-controller.ts`)**: Quando `MODUS_REPEAT_GUARDS` está ativo, hipóteses repetidas alimentam a lista de `avoidStrategyCodes` com `strategyAvoided = true`.
- **Runtime (`pi-sdk-runtime.ts`)**:
  - Registra automaticamente chamadas no evento `tool.started` via `ToolInvocationTracker`.
  - Limpa o histórico de invocações e o circuit breaker em `abortSessionOnly` e `disposeSessionOnly`.

### 2.7 Wiring de Execução (rodada de revisão de 2026-10-06)
A versão inicial entregue os guards como código **não conectado**: os dois hooks não estavam registrados e a fase `verification_check` nunca era executada. Corrigido em `pi-sdk-runtime.ts`:

1. **Registro dos hooks** — `defaultTurnStartRepeatGuardHook` (fase `turn_start`, já executada pelo runtime) e `defaultVerificationRepeatGuardHook` (fase `verification_check`) são registrados junto dos 7 hooks originais.
2. **Fase `verification_check` no boundary `post_failure`** — novo método `runFailureLoopGuard()` executa a fase com `exitCode: 1` e semeia `context.state["harness.failure_attempts"]` com `tracker.failureAttempts` (o guard antes lia `?? []` sem escritor algum).
3. **Veredito no `decideNext`** — `harness.loop_action` vira `snapshot.failureLoopAction` (novo tipo `AdaptiveFailureLoopAction` em `shared/contracts`): `circuit_break` força `action: "replan"` com `repeat_guard_circuit_break`; demais ações definem `strategyAvoided = true` (→ `avoid_retry` / `suggest_oracle` / `spawn_readonly_specialist`).
4. **Pass-through do intent gate** — como o kernel **encadeia** as saídas (a saída do hook N vira a entrada do hook N+1), os guards preservam integralmente o que veio de cima (`passThroughTurnStart`), incluindo um `proceed: false` do intent gate. Este era exatamente o tipo de bug que derrubou a Fase 3; agora há teste de regressão cobrindo-o (flag on e off).

---

## 3. Matriz de Testes e Validação

| Verificação | Resultado | Observações |
|---|---|---|
| `tsc --noEmit` (apps/desktop) | **0 erros** ✅ | Compatibilidade 100% com `exactOptionalPropertyTypes` |
| `guards.test.ts` (24 testes) | **24 pass, 0 fail** ✅ | Overrides, hashing, whitelist (8 tools), circuit breaker, SLO <5ms, pass-through do intent gate, `failureLoopAction` no meta controller |
| Harness Test Suite (28 arquivos) | **365 pass, 5 skipped, 0 fail** ✅ | Todas as 28 suítes do harness passam sem quebras |
| `pi-sdk-runtime.test.ts` (141 testes) | **137 pass, 4 fail (0 unhandled)** ✅ | **Contrato de baseline estrito preservado** (exatamente as 4 falhas pré-existentes de HEAD) |
| Suíte completa (`apps/desktop/src` + `scripts`) | **22 arq. fail / 59 tests fail / 0 unhandled** ✅ | Baseline: 23 arq. / 67 tests. **Nenhum arquivo novo falhando** |
| Biome `organizeImports` no escopo do trabalho | **0 erros** ✅ | 24 arquivos corrigidos com `biome check --write` (somente assist) |

---

## 4. SLO de Performance e False Positives

- **Latência de Fingerprint e Detecção**: < 0.2ms por invocação (SLO < 5ms plenamente satisfeito em benchmark de 500 chamadas).
- **Taxa de Falsos Positivos**: 0% nos testes de leituras repetidas (`view_file` / `retrieve_spilled_tool_result` operam livremente até 2x o threshold mutante).

---

## 5. Próximo Passo: Fase 6

A Fase 5 está 100% pronta e validada.
O próximo passo no plano de evolução é a **Fase 6: Groups Mailbox & Revisão Otimista**:
- 6.1 `GroupMailbox` para comunicação e coordenação entre agentes de grupo.
- 6.2 Revisão otimista não-bloqueante para builds de subagentes.
- 6.3 Resolução de conflitos de checkout em worktrees compartilhados.

---

## 6. Achados da Revisão de Código e Correções Aplicadas

### Corrigidos nesta rodada
| # | Achado | Correção |
|---|---|---|
| 1 | **Hooks nunca registrados**: `defaultTurnStartRepeatGuardHook` e `defaultVerificationRepeatGuardHook` só existiam em teste; `detectRepeatTools` e `CircuitBreakerRegistry.trip` nunca rodavam em produção. | Registrados em `pi-sdk-runtime.ts` (junto dos 7 hooks originais). |
| 2 | **Fase `verification_check` sem executor**: o runtime só chamava `turn_start` e `turn_settle`; o guard nunca disparava. | `runFailureLoopGuard()` roda a fase no boundary `post_failure`. |
| 3 | **`harness.failure_attempts` sem escritor**: o guard lia `?? []`, tornando o branch `circuit_break` inatingível. | Estado semeado com `tracker.failureAttempts` (ledger real da run). |
| 4 | **Veredito não chegava ao meta controller**. | Novo campo `AdaptiveDecisionSnapshot.failureLoopAction` consumido por `decideNext` (`circuit_break` → `replan`; demais → `strategyAvoided`). |
| 5 | **Whitelist com 3 tools** vs 8 declarados no doc → FP no churn de `grep_search`/`list_dir`/etc. | `repeat-guard-config.ts` alinhado aos 8 tools (teste `toHaveLength(8)`). |
| 6 | **Guard podia descartar o abort do intent gate** (a saída `{ proceed: true }` sobrescrevia o `proceed: false` do hook upstream). | `passThroughTurnStart()` preserva toda a saída upstream; testes de regressão flag on/off. |
| 7 | **Saída de fase encadeada** descartava `violations`/`allPassed` do hook de QA. | Guardes re passam o upstream via spread e só sobrescrevem o que decidem. |
| 8 | **`organizeImports` em 24 arquivos** (nivel error, faria o CI parar antes dos testes). | `biome check --write` (assist apenas) → 0 erros no escopo. |

### Itens conhecidos remanescentes (não bloqueadores)
- **`biome check .` na raiz falha no baseline do repositório** com ~1027 diagnósticos de `format` (fim de linha CRLF vs LF) — pré-existente, fora do escopo desta fase; nenhum deles foi introduzido por este trabalho.
- **`half_open` nunca é transitado** no `CircuitBreakerRegistry` (só `closed → open` + `reset()`), e `recordFailure()` não tem chamador: o disparo real é `detectFailureLoop` → `trip()`.
- **`ToolInvocation.error`** é registrado mas nunca é lido pelos guards (campo hoje inerte).
- Guards permanecem atrás de `MODUS_REPEAT_GUARDS` (default `false`) — nenhum risco em produção até ativação deliberada.

### Veredito da revisão
**GO para Fase 6.** Entregáveis da Fase 5 agora estão efetivamente conectados ao runtime, com comportamento fail-open preservado, baseline de testes intocado e correções das lacunas B/C da Fase 4 aplicadas (ver `FASE-4-AVALIACAO.md` §5).
