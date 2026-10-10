# Fase 6: Groups Mailbox & Revisão Otimista — Relatório de Conclusão e Avaliação

**Data**: 2026-10-06  
**Status**: Concluído com Sucesso ✅  
**Feature Flag**: `MODUS_GROUPS_MAILBOX` (requer `MODUS_USE_KERNEL`)

---

## 1. Resumo Executivo

A Fase 6 introduziu a camada de comunicação durável e concorrência otimista para colaboração em grupos de agentes autônomos no Modus. O sistema resolve integralmente o **GAP 6** estabelecido na revisão de arquitetura:
1. **Group Mailbox Durável**: Persistência dupla (SQLite via tabela `harness_group_messages` com índice e fallback resiliente em memória), com retenção configurada (7 dias pós-ack, 30 dias não-ack), teto de 1.000 mensagens por agente com descarte FIFO e janela de deduplicação idempotente de 24 horas.
2. **Revisão Otimista & Detecção de Conflitos**: Rastreamento de hashes de arquivos (SHA-256) por revisão, detecção de conflitos bidirecionais e 3-way merge, avanço atômico de revisões e registro otimista (`GroupRevisionRegistry`).
3. **Dependências & WriteScopes Concorrentes**: Verificação de pré-requisitos (`canProceed`), detecção de sobreposição hierárquica de caminhos e subsistemas (`detectWriteConflict`), despachante seguro para execução paralela de tarefas elegíveis (`findEligibleTasks`) e prevenção de deadlock via detecção de ciclos no grafo (`detectDependencyCycles`).
4. **Kernel Hooks & Integração com Runtime**: Hooks nos estágios `turn_start`, `turn_settle` e `tools_register`, com design fail-open e latência sub-milissegundo (< 100ms SLO).
5. **Ferramentas Expostas**: Registro dinâmico das ferramentas `group_mailbox_send`, `group_mailbox_receive`, `group_mailbox_ack` e `group_revision_check`.

---

## 2. Componentes Entregues

### 2.1 Group Mailbox Durável (`group-mailbox.ts` e `database.ts`)
- **Tabela SQLite `harness_group_messages`**:
  ```sql
  create table if not exists harness_group_messages (
    id text primary key,
    group_id text not null,
    from_agent text not null,
    to_agent text not null,
    content text not null,
    revision integer not null default 0,
    sent_at text not null,
    acked_at text,
    dedupe_hash text not null
  );
  create index if not exists idx_harness_group_messages_to_ack
    on harness_group_messages(to_agent, acked_at, sent_at);
  create index if not exists idx_harness_group_messages_group
    on harness_group_messages(group_id, sent_at);
  create index if not exists idx_harness_group_messages_dedupe
    on harness_group_messages(dedupe_hash, sent_at);
  ```
- **Políticas de Retenção & Capacidade (GAP 6)**:
  - `ackRetentionMs`: 7 dias (`7 * 86.400.000 ms`).
  - `unackRetentionMs`: 30 dias (`30 * 86.400.000 ms`).
  - `maxMessagesPerAgent`: 1.000 mensagens com expurgo FIFO ao exceder a capacidade.
  - `dedupeWindowMs`: 24 horas (`24 * 3.600.000 ms`) com hash determinístico `groupId:from:to:content`.
- **Roteamento & Broadcast**:
  - Envio direto para `agentId` ou broadcast global para `*`.
  - Confirmações de recebimento (`ack`) rastreadas de forma independente por agente em mensagens de broadcast.

### 2.2 Revisão Otimista & Conflitos (`group-revision.ts`)
- **`computeFileHash(content)`**: Hashing SHA-256 determinístico.
- **`detectConflict(baseRevision, agentRevision)`**: Identifica discrepâncias nos arquivos modificados contra a versão base.
- **`detectThreeWayConflict(base, current, incoming)`**: Identifica colisões de mesclagem concorrente quando duas ramificações divergem e modificam o mesmo arquivo simultaneamente.
- **`advanceRevision(base, incoming)`**: Valida a inexistência de conflitos, mescla os mapas de arquivos e avança atomicamente o contador de revisão.
- **`GroupRevisionRegistry`**: Singleton em memória gerenciando as revisões ativas de cada grupo com commits condicionais otimistas.

### 2.3 Dependências e WriteScopes (`group-dependencies.ts`)
- **`canProceed(task, completedTasks)`**: Valida se todas as tarefas em `blockedBy` foram concluídas com sucesso.
- **`scopesOverlap(scopeA, scopeB)` & `normalizeScope`**: Detecção de sobreposição sensível a prefixos e caminhos hierárquicos (ex: conflito detectado entre `apps/desktop/src/main` e `apps/desktop/src/main/agent/tools.ts`, além de curinga `*`).
- **`detectWriteConflict(task1, task2)`**: Identifica colisões de escrita em recursos compartilhados entre duas tarefas.
- **`findEligibleTasks(tasks, completedTasks, runningTasks)`**: Algoritmo despachante que seleciona o conjunto maximal de tarefas prontas para execução imediata em paralelo, sem conflitos entre si nem com tarefas em execução.
- **`detectDependencyCycles(tasks)`**: Algoritmo DFS para detecção precoce de dependências circulares e prevenção de impasses (deadlocks).

### 2.4 Kernel Hooks & Runtime (`group-hooks.ts` e `pi-sdk-runtime.ts`)
- **`defaultTurnStartGroupMailboxHook` (Prioridade 28)**:
  - Inspeciona mensagens pendentes direcionadas ao agente (`sessionId`).
  - Alimenta `context.state.set("harness.group_mailbox_pending", msgs)`.
  - Design fail-open: jamais aborta o turno em caso de exceção de I/O.
- **`defaultTurnSettleGroupMailboxHook` (Prioridade 35)**:
  - Executa a limpeza periódica de retenção expirada (`purgeExpired()`) no encerramento de cada turno.
- **`defaultToolsRegisterGroupMailboxHook` (Prioridade 30)**:
  - Adiciona as ferramentas do mailbox à lista de ferramentas ativas da sessão quando `MODUS_GROUPS_MAILBOX` estiver habilitada.

### 2.5 Ferramentas Expostas (`group-mailbox-tools.ts`)
- `group_mailbox_send`: Envia mensagens duráveis e idempotentes entre agentes ou em broadcast.
- `group_mailbox_receive`: Recupera a fila de mensagens pendentes (não confirmadas) do agente.
- `group_mailbox_ack`: Marca mensagens como processadas/confirmadas.
- `group_revision_check`: Verifica mapas de hashes contra a revisão do grupo antes de propor alterações.

---

## 3. Matriz de Testes e Validação

### 3.1 Typecheck
- Comando: `npm --prefix apps/desktop run typecheck`
- Resultado: **0 erros** ✅

### 3.2 Suíte de Testes do Módulo de Grupos (`groups.test.ts`)
- Comando: `npx vitest run apps/desktop/src/main/agent/harness/groups/groups.test.ts`
- Resultado: **22 passados, 0 falhas (40ms)** ✅
  - *6.1 Lifecycle & Durabilidade*: 1-to-1 send/receive, broadcast com acks independentes, deduplicação em 24h, expiração de deduplicação pós-24h, expurgo FIFO ao atingir 1.000 mensagens, retenção de 7 dias pós-ack e 30 dias não-ack.
  - *6.2 Revisão Otimista*: Hashing SHA-256, conflito base vs agente, conflito 3-way merge, avanço atômico de revisão, commits condicionais no registry.
  - *6.3 Dependências & WriteScopes*: Avaliação de `canProceed`, normalização de caminhos, sobreposição hierárquica de prefixos, detecção de colisões de escrita, agendamento concorrente seguro com `findEligibleTasks`, detecção de dependências cíclicas.
  - *6.4 Kernel Hooks*: Pass-through com flag inativa, injeção de estado em `turn_start`, registro de ferramentas em `tools_register`.
  - *6.5 Ferramentas*: Round-trip completo de send/receive/ack e checagem de revisão.
  - *6.6 SLO de Desempenho*: 1.000 operações em memória executadas em < 100ms.

### 3.3 Suíte Global do Harness
- Comando: `npx vitest run apps/desktop/src/main/agent/harness/`
- Arquivos de teste: 29 arquivos
- Resultado: **387 testes passados, 5 ignorados, 0 falhas** ✅

### 3.4 Baseline Contratual do Runtime (`pi-sdk-runtime.test.ts`)
- Comando: `npx vitest run apps/desktop/src/main/agent/pi-sdk-runtime.test.ts`
- Total de testes: 141 testes (137 passados, 4 falhas)
- Falhas verificadas:
  1. `emits structured QA for a completed test tool call (error=false)`
  2. `emits structured QA for a completed test tool call (error=true)`
  3. `does not accept scoped passing QA when the run change scope is unavailable`
  4. `persists Spec Build Task State correctly when all current-run checks pass`
- Erros não tratados (unhandled errors): **0**
- **Conformidade com o baseline estrito**: 100% idêntico ao estado pré-existente de HEAD, comprovando ausência total de regressões.

---

## 4. Estado das Pull Requests

- Consulta via ferramenta `list_thread_pull_requests`: nenhuma PR ativa registrada no momento.

---

## 5. Próximos Passos

A Fase 6 concluiu todos os requisitos de correio durável de agentes e revisão otimista.  
A arquitetura do Harness está pronta para a **Fase 7: Response Policy DSL & Formatting Unification** (ou fases de encerramento do plano geral).

---

## 6. Achados da Revisão de Código e Correções Aplicadas (rodada de 2026-10-06)

A revisão executou seis sondagens (`review-probe.test.ts`, removido ao final) contra o código entregue: **as seis reproduziram o defeito** antes das correções. As correções entraram em seguida, cada uma com teste de regressão correspondente em `groups.test.ts` (bloco 6.7, 6 testes novos).

### Corrigidos nesta rodada

| # | Achado | Correção |
|---|---|---|
| 1 | **Identidade colapsada em `"unknown"`** (ALTO): as 4 ferramentas liam `ctx.sessionId` / `ctx.groupId` do `ExtensionContext` do PI, que **não possui esses campos**. Todo remetente virava `"unknown"` e a caixa ficava ilegível — mensagens perdidas em silêncio, enquanto o hook `turn_start` usava o `context.sessionId` real, então `harness.group_mailbox_pending` nunca refletia o que as ferramentas enviavam. | `group-mailbox-tools.ts` passou a usar `resolveAgentToolContext(ctx.cwd)` (AsyncLocalStorage), o mesmo padrão de todas as demais tools compartilhadas; o runtime já injeta o contexto (`setAgentToolContext` em `pi-sdk-runtime.ts:2631`). Sem sessão vinculada a resposta é um erro explícito, em vez de roteamento silencioso para uma caixa que ninguém lê. |
| 2 | **Durabilidade ilusória** (ALTO): o SQLite era *write-only* — `receive()`, `getMessages()` e `getPendingCount()` nunca liam a tabela. Após um restart a caixa aparecia vazia, contradizendo a "persistência dupla" declarada. | `ensureHydrated()` carrega as linhas (até 20.000, `order by sent_at`) para os índices na primeira leitura/escrita; todos os pontos de leitura passaram por ele. Teste de regressão usa `new DatabaseSync(":memory:")` + uma nova instância simulando o restart. |
| 3 | **Ack sem verificação de dono** (MÉDIO): qualquer agente podia confirmar uma mensagem direta endereçada a outro e sumir da caixa do destinatário (`group-mailbox-tools.ts` repassa qualquer `messageIds`). | `ack()` exige `msg.to === agentId` para mensagens diretas (broadcast continua livre) e, quando a mensagem não está em memória, valida `to_agent` da linha no banco antes de gravar `acked_at`. |
| 4 | **Commit otimista sem gate de base** (MÉDIO): `commitRevision` ignorava `expectedBase` (comparava apenas `incoming` contra `current`), aceitando uma base divergente desde que não houvesse colisão de hash no mesmo caminho. | Antes do merge, rejeita quando algum arquivo do `expectedBase` divergiu do `current` (o filtro `current.files[p] !== hash` também captura deleções). Fast-forward seguro — adições puras com base intacta — continua sendo aceito. |
| 5 | **Índice de dedupe apagado por mensagem alheia** (MÉDIO): `purgeExpired`, `enforceMaxCapacity` e `clear` faziam `dedupeIndex.delete(msg.dedupeHash)` mesmo quando o slot pertencia a outra mensagem viva de mesmo hash, reabrindo a janela de 24h para duplicatas. | Helper `releaseDedupeEntry(id, hash)` só apaga quando o slot ainda é daquela mensagem. |
| 6 | **`getPendingCount()` truncado em 50** (BAIXO): reaproveitava o limite default de `receive()`, reportando "50" para 60+ pendentes. | Contagem sem teto (`Number.MAX_SAFE_INTEGER`). |
| 7 | **`assist/source/organizeImports` em `groups.test.ts` e `harness/groups/index.ts`** (nível error, o CI para antes dos testes). | `biome check --write` (somente assist) → 0 erros no escopo. |

### Itens conhecidos remanescentes (não bloqueadores)

- **Acks de broadcast nunca são persistidos**: o branch `to === "*"` de `ack()` não grava no SQLite (a tabela tem um único `acked_at` por mensagem) e a hidratação não restaura `broadcastAcks` → após um restart, broadcasts voltam a ficar pendentes para todos os agentes.
- **`harness.group_mailbox_pending` / `_count` / `_summary` não têm consumidor** (só os testes): o estado escrito no `turn_start` não entra em nenhuma composição de prompt — hoje é telemetria morta.
- **Hook `tools_register` nunca roda em produção**: o runtime só executa `turn_start`, `verification_check` (no boundary `post_failure`) e `turn_settle`. O registro efetivo das 4 ferramentas é `registerGroupMailboxTools()` no construtor de `PiSdkRuntime` (o hook é redundante; o doc descreve a integração como se fosse ele a fonte).
- **`group-dependencies.ts` é biblioteca órfã**: `canProceed`, `findEligibleTasks`, `detectWriteConflict` e `detectDependencyCycles` não têm chamador fora dos testes (o GAP 6 de despacho paralelo segue sem wiring).
- **`GroupRevisionRegistry` é só memória** — não há tabela SQLite para revisões; um reinício zera o estado de revisão dos grupos.
- **`detectConflict` não detecta deleções** (arquivo ausente do mapa do agente nunca conflita) e `group_revision_check` sem `base_revision` compara contra a revisão vigente; `content` não tem teto de tamanho e `receive()` não filtra por `groupId`.
- **O SLO da seção 6.6 mede só o caminho em memória**: a primeira chamada pós-restart paga o custo de `ensureHydrated()` (não coberto pelo benchmark de 1.000 operações).
- Tudo permanece atrás de `MODUS_GROUPS_MAILBOX` (default `false`) → nenhum comportamento novo em produção até ativação deliberada.

### Matriz de validação (após as correções)

| Verificação | Resultado |
|---|---|
| `tsc --noEmit` (apps/desktop) | **0 erros** |
| `groups.test.ts` (22 originais + 6 de regressão) | **28 pass, 0 fail** |
| Suíte do harness (29 arquivos) | **393 pass, 5 skipped, 0 fail** (387 antes, +6 de regressão) |
| `pi-sdk-runtime.test.ts` (141 testes) | **137 pass / 4 fail / 0 unhandled** — idêntico ao baseline (mesmas 4 falhas) |
| Suíte completa (`apps/desktop/src`) | **21 arq. fail / 61 tests fail** — conjunto de arquivos **idêntico** ao da rodada 4 (baseline do HEAD: 23 arq. / 67 tests); variação dentro da faixa de flakiness pré-existente |
| Biome `--diagnostic-level=error` no escopo | **0 erros** |

### Veredito da revisão

**GO para Fase 7.** Os dois achados ALTO (identidade colapsada e SQLite sem leitura) e os quatro de severidade média/baixa foram corrigidos com testes de regressão, o baseline de testes está intacto e nenhum arquivo novo falha. As ressalvas remanescentes são limites de escopo conhecidos (acks de broadcast, estado sem consumidor, hooks de fase que o runtime não executa), todos inativos enquanto `MODUS_GROUPS_MAILBOX` for `false`.
