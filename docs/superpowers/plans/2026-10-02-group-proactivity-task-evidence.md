# Group Proactivity and Task Evidence Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Dar aos Grupos tarefas verificáveis, ferramentas consistentes, sugestões proativas e automação limitada por opt-in, com roteamento por capacidade e integração Git confirmada pelo usuário.

**Architecture:** O Group Runtime mantém fila, budgets, recuperação e Stop. Políticas puras leem snapshots tipados; stores transacionais persistem tarefas, evidências e decisões; o runtime valida e agenda wakes usando a infraestrutura existente. QA pertence ao harness individual, e integração de branches usa o serviço Git existente por uma entrada que verifica permissão.

**Tech Stack:** Electron, TypeScript, React, SQLite, Zod/TypeBox, Vitest, Git.

**Spec:** [Especificação aprovada](../specs/2026-10-02-group-proactivity-task-evidence-design.md).

**Status:** plano criado e revisado; implementação pendente. Os comandos abaixo são para a execução futura, não foram executados durante esta revisão.

## Global Constraints

- Sugestões são o padrão; automação limitada requer opt-in explícito por Grupo: `suggest | opt_in_auto`.
- Group Runtime continua responsável por fila, persistência, limites, recuperação e Stop; nenhum scheduler ou polling adicional.
- Nenhuma proatividade provocada por silêncio, “Agreed”/“Proposed” ou menções públicas de agentes.
- Delegação explícita por ferramentas mantém seus wakes autorizados em ambos os modos. `suggest` controla iniciativas adicionais do controlador, não transforma `group_assign_task` ou `group_request_review` em pedidos inertes.
- QA real vem do harness; referências não copiam logs, transcrições ou saídas de ferramentas. `user_confirmed`, `missing`, `unavailable`, `skipped` e `failed` nunca equivalem a QA automático `passed`.
- Critérios obrigatórios e revisão obrigatória precisam estar satisfeitos antes de `done`. Cancelamento continua disponível somente ao usuário.
- Tarefas legadas mantêm conteúdo e estado; recebem política sem gate retroativo e nenhuma migração dispara trabalho.
- ToolRegistry, permission broker, isolamento por worktree e limites existentes continuam efetivos. O controlador só sugere ou agenda owner/reviewer, sem executar ferramentas de escrita.
- Integração exige prévia e confirmação, verifica `git.write`, permite abortar e não faz merge commit ou push automático.
- Cada tarefa abaixo termina em um commit local separado durante a execução. Publicar, abrir PR ou implementar são passos posteriores ao pedido atual de revisar o plano.

## Review Focus

1. Editar um arquivo sem mudar HEAD deve invalidar QA e revisão anteriores — Tarefas 3 e 11.
2. Crash entre persistir decisão e enfileirar wake não pode perder nem duplicar trabalho — Tarefa 7.
3. Dois owners/reviewers ou eventos antigos concorrentes não podem aprovar a versão errada — Tarefas 2–4 e 8.
4. Tarefa sem capacidades declaradas, Lead ausente ou membro removido deve produzir fallback útil sem escolher agente incompatível — Tarefas 9–10.
5. Branch de destino ou origem alterada durante prévia/permissão, conflito ou merge pendente deve bloquear aplicação e preservar a possibilidade de abortar — Tarefas 11–12.

## Fases e entregas

| Fase | Tarefas | Entrega utilizável | Depende de |
| --- | --- | --- | --- |
| A | 1–5 | Tarefas persistidas, critérios, gates QA, ferramentas e painel consistentes | Infraestrutura atual |
| B | 6–8 | Sugestões por padrão e wakes opt-in duráveis | A |
| C | 9–10 | Capacidades configuráveis e fluxo supervisionado tipado | A; usa B para sugestões |
| D | 11–12 | Prévia e aplicação de branches com confirmação e permissão | A |
| E | 13 | Regressões, documentação e liberação verificadas | A–D |

Executar na ordem numérica. Cada fase pode ser revisada e entregue separadamente. Este plano mantém as interfaces entre as fases no mesmo documento porque elas compartilham `GroupTask` e Group Runtime.

## Mapa de arquivos e responsabilidades

Os caminhos desta seção partem de `/workspace/modus/`. Nos blocos de tarefas, `desktop/` significa `/workspace/modus/apps/desktop/src/`.

- `desktop/shared/group-work-state.ts` (novo): contratos de tarefa, evidência resolvida, transição, snapshot e decisão; reexportar por `shared/contracts.ts` e usar em `contracts-parts/contracts-part-08.ts`.
- `desktop/shared/group-task-policy.ts` (novo): validação de critérios/dependências e gates puros; sem SQLite, Electron ou Git.
- `desktop/main/groups/group-task-store.ts` (novo): operações de tarefa, histórico e vínculos task/run. Extrair somente o bloco de tarefas de `group-store.ts`, mantendo reexports compatíveis.
- `desktop/main/groups/group-task-evidence.ts` (novo): resolver referências do harness, escopo/revisão e gates. Nenhuma interpretação de texto de logs.
- `desktop/main/groups/group-proactivity-policy.ts` (novo): decisão pura; `group-proactivity-store.ts` (novo): sugestões e entrega idempotente.
- `desktop/main/groups/group-capability-router.ts` (novo): roteamento determinístico; `shared/group-capabilities.ts` (novo): IDs e metadados.
- `desktop/main/groups/group-integration-service.ts` (novo): prévia, validações, permissão e adaptação ao Git existente.
- `desktop/main/ipc/group-work-ipc.ts` e `group-integration-ipc.ts` (novos): handlers específicos; conectar em `register-app-ipc.ts`, `channels.ts` e preload.
- `desktop/renderer/src/features/groups/GroupTaskDetails.tsx`, `GroupProactivityControls.tsx`, `GroupIntegrationDialog.tsx` (novos): critérios/evidências, sugestões/modo e integração.
- Preservar os módulos atuais de runtime, registry, QA e Git; estendê-los apenas nas interfaces indicadas nas tarefas.

## Interfaces compartilhadas decididas

Definir estes nomes na Tarefa 1 e usá-los sem variantes nas demais tarefas:

```ts
type GroupTaskKind = "legacy" | "code" | "docs" | "design" | "review" | "research" | "question";
type GroupTaskStage = "plan" | "implement" | "verify" | "review" | "deliver";
type GroupTaskPriority = "low" | "normal" | "high";
type GroupProactivityMode = "suggest" | "opt_in_auto";
type GroupTaskCriterion = {
  id: string; description: string; requiredCheckKinds: HarnessTaskCheckKind[];
};
type GroupTaskVerificationPolicy = { mode: "none" | "required"; requireReview: boolean };
type GroupTaskEvidenceRef = {
  criterionId: string; criteriaVersion: number;
  sessionId: string; runId: string; eventRowId: number; evidenceId: string;
  sourceFingerprint: string;
};
type GroupTaskReview = {
  reviewerSessionId: string; verdict: "approve" | "changes";
  criteriaVersion: number; sourceFingerprint: string; eventId: string;
  approvedCriterionIds: string[];
};
type GroupTaskDraft = {
  groupId: string; title: string; description?: string;
  kind: GroupTaskKind; priority: GroupTaskPriority;
  dependencyIds: string[]; criteria: GroupTaskCriterion[];
  verificationPolicy: GroupTaskVerificationPolicy;
  reviewerSessionId?: string;
};
type GroupTaskCriterionOutcome = {
  criterionId: string; criteriaVersion: number;
  status: VerificationEvidenceStatus | "review_approved";
  sourceFingerprint: string;
};
type GroupTaskGateInput = {
  task: GroupTask; criterionOutcomes: GroupTaskCriterionOutcome[];
  review?: GroupTaskReview; sourceFingerprint: string;
  dependencies: Array<Pick<GroupTask, "id" | "status">>;
};
type GroupTaskGateResult = { satisfied: boolean; reasonCodes: string[] };
type GroupTaskValidationResult = {
  issues: Array<{ code: string; field: string; message: string }>;
};
```

Adicionar a `GroupTask`: `kind`, `priority`, `stage?`, `blockedReason?`, `dependencyIds`, `criteria`, `criteriaVersion`, `verificationPolicy`, `evidenceRefs`, `review?` e `stateVersion`. `stateVersion` cresce a cada mutação; `criteriaVersion` cresce quando critérios/política mudam. Adicionar somente `blocked` aos statuses atuais. Não guardar status QA afirmado pelo agente na referência: o resultado resolvido é transitório e lido da fonte persistida.

`GroupTaskTransitionEvent` contém `id`, `groupId`, `taskId`, `taskVersion`, `action`, `actorSessionId?`, `sourceEventId?`, `executionId?`, `fromStatus`, `toStatus` e `createdAt`. `GroupWorkState` contém tarefas, gates resolvidos, membros, execução e budgets existentes. `GroupDecisionSnapshot` acrescenta modo, evento de origem e gates Stop/espera pelo usuário. `GroupProactivityDecision` contém `kind: "suggest" | "wake_owner" | "wake_reviewer"`, `taskId`, `targetSessionId?`, `sourceEventId`, `reasonCode` e `idempotencyKey`; ausência de ação é `null`.

## Tarefa 1: Contratos e política pura de tarefa

**Files:** criar `desktop/shared/group-work-state.ts`, `group-task-policy.ts`, `group-task-policy.test.ts`; modificar `desktop/shared/contracts.ts`, `contracts-parts/contracts-part-08.ts`, `group-errors.ts`.

**Interfaces:** consome `HarnessTaskCheckKind` e `VerificationEvidenceStatus` existentes. Produz os tipos acima, `validateGroupTaskDraft(draft: GroupTaskDraft, tasks: readonly GroupTask[]): GroupTaskValidationResult` e `evaluateGroupTaskGate(input: GroupTaskGateInput): GroupTaskGateResult`. `criterionOutcomes` representa os resultados resolvidos pelo serviço main; `review_approved` só aparece quando o reviewer aprovou aquele critério para a versão/fingerprint atual. `sourceFingerprint` é a revisão corrente e dependências são snapshots do mesmo grupo.

- [x] Adicionar testes `required_qa_is_not_satisfied_by_user_confirmation`, `review_is_bound_to_criteria_and_source`, `rejects_dependency_cycles_and_cross_group_ids`, `required_policy_rejects_empty_criteria`, `legacy_none_policy_can_complete`: assertar que `passed` atual satisfaz QA, demais statuses não; revisão/fingerprint antigos não satisfazem; ciclos e outro Grupo são rejeitados; required sem critérios é inválido; tarefa legada sem gate mantém conclusão.
- [x] Rodar `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/shared/group-task-policy.test.ts`; esperar falha nas interfaces novas.
- [x] Implementar tipos e funções puras. Usar limites existentes do Task State para critérios/referências, e os limites atuais de título/descrição do store. Critério sem check declarado exige aprovação explícita vinculada à revisão atual e política `requireReview=true`; sucesso global de QA não o comprova sozinho. Definir erros `verification-required`, `stale-task`, `dependency-cycle`, `invalid-dependency` e `stale-evidence` na lista compartilhada de erros.
- [x] Rodar o mesmo comando; esperar todos os testes aprovados.
- [x] Commit: `feat(groups): define verifiable task contracts`.

## Tarefa 2: Migração e store transacional

**Files:** criar `desktop/main/groups/group-task-store.ts`, `group-task-store.test.ts`; modificar `desktop/main/db/database.ts`, `groups/group-store.ts`, `group-store.test.ts`.

**Interfaces:** consome Tarefa 1. Produz reexports compatíveis das operações atuais e `reportGroupTaskProgress(input: GroupTaskProgressInput): GroupTask`, `recordGroupTaskEvidence(input: GroupTaskEvidenceInput): GroupTask`, `bindGroupTaskRun(input: BindGroupTaskRunInput): void`, `getGroupTaskRunBinding(sessionId: string, runId: string): GroupTaskRunBinding | undefined`, `listGroupTaskTransitions(taskId: string): GroupTaskTransitionEvent[]`. Todos os inputs mutáveis incluem `expectedVersion` e `operationId`; o registro durável `GroupTaskRunBinding` mantém apenas task/criteria version, execução e identidade do run, e seu input de bind também valida versão esperada e idempotency key.

Definir `GroupTaskProgressInput` com groupId, taskId, actorSessionId, expectedVersion, operationId, stage opcional e blockedReason opcional/null para resolver bloqueio; `GroupTaskEvidenceInput` com os mesmos identificadores e refs validadas pelo serviço main; `GroupTaskRunBinding` com groupId, taskId, taskVersion, criteriaVersion, sessionId, runId, executionId, role (`owner | reviewer`) e sourceFingerprint; `BindGroupTaskRunInput` é o binding acrescido de `expectedVersion` e `operationId`. Nenhum desses inputs de evidência é exposto como payload livre ao renderer/agente.

- [x] Adicionar testes de migração usando banco antigo: preservar IDs, FK, executionId, branches, estados e timestamps; defaults `kind=legacy`, `priority=normal`, `dependencyIds=[]`, `criteria=[]`, política `none`, versões iniciais `1`; aceitar `blocked`. Adicionar testes de concorrência: versão antiga falha sem write/evento; mesmo operationId repete resultado sem duplicação; remoção de owner/reviewer preserva histórico e invalida atribuição ativa.
- [x] Rodar `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/main/groups/group-task-store.test.ts apps/desktop/src/main/groups/group-store.test.ts`; esperar falha nos novos casos.
- [x] Migrar `group_tasks` com preservação do CHECK/FKs e colunas adicionadas por migrações anteriores. Guardar arrays/política versionados em JSON validado; criar `group_task_events` e `group_task_runs` para histórico e associação durável. Garantir identidade única para operationId e `(sessionId, runId)`; nenhuma migração emite eventos ou wakes.
- [x] Extrair operações de tarefa para o módulo novo com reexports; usar transações para estado, histórico, evidência e associação de run. Aplicar owner/reviewer/usuário autorizados e `expectedVersion`; `cancelled` só pelo caminho IPC do usuário. Manter API atual até a Tarefa 4 atualizar callers.
- [x] Rodar o mesmo comando; esperar migração idempotente, integridade FK e todos os testes aprovados.
- [x] Commit: `feat(groups): persist task state and transition history`.

## Tarefa 3: Vincular QA real a critérios da tarefa

**Files:** criar `desktop/main/groups/group-task-evidence.ts`, `group-task-evidence.test.ts`; modificar `desktop/main/groups/group-task-store.ts`, `group-task-store.test.ts`, `desktop/main/agent/agent-event-store.ts`, `agent-event-store.test.ts`, `agent/pi-sdk-runtime.ts`, `agent/runtime.ts`, `groups/group-runtime.ts`; estender `desktop/main/git/git-service.ts` e seus testes para fingerprint.

**Interfaces:** consome Tarefas 1–2 e `HarnessQAResult`, `recordAgentEvent`, `getRunToolEvidence` existentes. Produz `resolveGroupTaskEvidence(task: GroupTask, sourceFingerprint: string): GroupTaskGateInput`, `collectGroupTaskRunEvidence(binding: GroupTaskRunBinding, qaEventRowId: number): GroupTaskEvidenceRef[]`, `getGroupSourceFingerprint(cwd: string): Promise<string>`. Fingerprint cobre HEAD, diff do index/worktree e conteúdo de arquivos não rastreados relevantes; não depende apenas de nome de arquivo/mtime. Leitura por rowId fica no event-store com validação session/run.

Produzir também `verifyGroupTaskForTransition(input: { taskId: string; expectedVersion: number; action: "approve" | "agree"; review?: GroupTaskReview }): Promise<GroupTaskGateInput>` como entrada main para resolver Git/evidência antes da transação síncrona. Em `approve`, a revisão proposta é validada e incluída no snapshot; a Tarefa 4 persiste revisão e transição de status atomicamente, conferindo `expectedVersion` novamente. Fingerprint usa a origem associada à tarefa, nunca o cwd do reviewer. Um snapshot positivo anterior não é autorização permanente: revalidar taskVersion e sourceFingerprint no gateway de conclusão, com serialização das transições da tarefa.

**Semântica do fingerprint:** o `sourceFingerprint` em `GroupTaskRunBinding` é a revisão-base capturada ao iniciar o run. A evidência de QA registra a revisão final coberta pelos checks: para run vinculado a tarefa, o main calcula o fingerprint da origem da tarefa imediatamente antes de persistir `harness.qa`, anexando-o ao resultado persistido; ausência da fonte/fingerprint torna QA indisponível. Cada `GroupTaskEvidenceRef.sourceFingerprint` aponta para essa revisão final, que pode diferir da base do run. `recordGroupTaskEvidence` valida task/group/criteria version e run/event exatos; não exige igualdade entre fingerprint inicial e final. O resolvedor só aprova quando fingerprint final da evidência ainda corresponde à origem atual. A origem é o worktree do owner da tarefa (ou a raiz do projeto quando não há owner), nunca o cwd do reviewer; captura e checks devem usar essa mesma origem. `HarnessTaskCheckKind` exigido por critérios é unido aos checks já calculados pelo harness, sem substituí-los.

Adicionar `checkName?: HarnessTaskCheckKind` a `HarnessEvidenceRef` e preenchê-lo no resolvedor QA para cada check reconhecido. O resolvedor de Grupo usa esse campo tipado para associar check→critério; não deriva capacidade/check de label, ID opaco ou texto livre. Cada outcome de critério é `passed` apenas quando todos os checkName exigidos têm referência `passed` no mesmo evento `harness.qa`.

A captura usa o fingerprint-base antes do run para `GroupTaskRunBinding` e um fingerprint final após os checks, imediatamente antes de persistir `harness.qa`; este vai no `HarnessQAResult` persistido somente em runs vinculados a tarefa. O coletor de eventos lê o resultado pelo rowId exato e exige sessão/run/evento correspondentes. `GroupTaskRunBinding.sourceFingerprint` não é copiado para `GroupTaskEvidenceRef`; a referência QA recebe o fingerprint final. Ao guardar refs, verificar vínculo task/group/criteria version/run e linha QA correspondente; não comparar fingerprint final com a base do run. Falha ao resolver a origem/fingerprint produz evidência `unavailable`.

`taskVersion` no binding registra a versão otimista do início do run e sua proveniência; evidência tardia é recusada se a `criteriaVersion` mudou ou se sessão/role deixou de ser owner/reviewer ativo. Uma mudança de estado apenas por progresso não deve invalidar QA se critérios, atribuição e fingerprint continuam atuais; `stateVersion` não substitui `criteriaVersion` como chave de freshness. O teste de QA tardia deve exercitar mudança de critérios/atribuição. Um critério só recebe outcome `passed` quando toda `requiredCheckKind` tem evidência `passed` no QA exato; `HarnessQAResult.status` agregado sozinho nunca comprova cada critério.

- [x] Adicionar testes `rejects_other_run_or_group_evidence`, `unchanged_head_with_edit_invalidates_evidence`, `criterion_without_checks_needs_scoped_review`, `missing_or_deleted_source_is_unavailable`, `late_qa_cannot_verify_new_task_version`. Assertar correspondência exata de run, critério, escopo, fingerprint e versão; recusar `user_confirmed` como QA automático.
- [x] Rodar `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/main/groups/group-task-evidence.test.ts apps/desktop/src/main/agent/agent-event-store.test.ts apps/desktop/src/main/git/git-service.test.ts`; esperar falhas novas.
- [x] Ao iniciar wake vinculado à tarefa, persistir associação task/run e passar requiredChecks dos critérios ao harness existente; ampliar o input de prompt e contrato compartilhado apenas se não houver campo para esse seed. Unir checks declarados aos atuais sem reduzir requisitos. Receber `harness.qa` depois de sua persistência, ligar referências por criterionId/check declarado e guardar apenas identidade/fingerprint, não output.
- [x] Implementar resolvedor que consulta a fonte, verifica scope/revision e ignora eventos de outro run/versão. Receber `GroupTaskReview` como snapshot tipado separado de QA; Task 4 persistirá revisão e transição atomicamente. Associação ambígua entre tarefas do mesmo membro retorna indisponível, sem atribuição por proximidade temporal.
- [x] Aplicar o gate no gateway assíncrono antes de conclusão/review approve e conferir expectedVersion no store, com resolvedor injetado e fail closed quando a fonte estiver indisponível. Não manter transação SQLite aberta enquanto aguarda Git. Rodar os testes citados e `harness/qa-evidence.test.ts`; esperar aprovação e compatibilidade do QA individual.
- [x] Commit: `feat(groups): gate task completion on harness evidence`.

## Tarefa 4: Ferramentas com operações consistentes

**Files:** modificar `desktop/main/agent/tools/group-tools.ts`, `group-tools.test.ts`, `registry.ts`, `registry.test.ts`, `desktop/shared/tools.ts`, `desktop/main/groups/group-runtime-lib.ts`; criar `desktop/main/groups/group-work-state.ts`, `group-work-state.test.ts`.

**Interfaces:** consome Tarefas 1–3. Produz `getGroupWorkState(groupId: string, executionId?: string): GroupWorkState`, parâmetros TypeBox para `group_report_progress(taskId, expectedVersion, stage?, blockedReason?, operationId)` e `group_get_work_state(executionId?)`. Criação aceita draft; listagem aceita status/owner/execution. Handoff adiciona `operationId` para retry e pode aceitar `taskId` para tarefa existente; com taskTitle cria e atribui atomicamente.

- [x] Adicionar testes `handoff_title_assigns_before_wake`, `handoff_retry_returns_same_task_and_wake`, `agree_cannot_bypass_required_qa`, `block_persists_task_status`, `explicit_review_dispatches_in_suggest_mode`, `work_state_is_bounded_and_read_only`. Assertar que falha de atribuição reverte criação; review e block alteram a tarefa indicada; concordância registra decisão sem encerrar tarefa gated quando falta evidência.
- [x] Rodar `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/main/agent/tools/group-tools.test.ts apps/desktop/src/main/agent/tools/registry.test.ts apps/desktop/src/main/groups/group-work-state.test.ts`; esperar falhas novas.
- [x] Registrar novas ferramentas no catálogo/registry e atualizar schemas, snippets e prompts em conjunto. Atualizar `group_block`, claim/release/assign, request/review/agree para usar store autoritativo, gates e versões; review recebe `approvedCriterionIds` para confirmação explícita dos critérios sem check. Criar `runGroupVerifiedTool` assíncrono para review/agree, usando o gateway da Tarefa 3; atualizar `SyncGroupToolName` e wrappers sem fingir que fingerprint Git é síncrono. Para chamadas antigas gerar operationId estável a partir de run/toolCallId; retries do mesmo call não criam novas tarefas.
- [x] Produzir snapshot compacto usando budgets de contexto atuais e omissão com contagem; incluir somente IDs/estado/resumo de QA. Wake explícito usa transição persistida com origem; controlador posterior não cria segundo wake dessa mesma operação.
- [x] Rodar o mesmo comando e testes existentes de `group-worktree.test.ts`; esperar aprovação.
- [x] Commit: `feat(groups): make task tools atomic and evidence aware`.

## Tarefa 5: IPC e painel de tarefa verificável

**Files:** criar `desktop/main/ipc/group-work-ipc.ts`, `group-work-ipc.test.ts`, `desktop/renderer/src/features/groups/GroupTaskDetails.tsx`, `GroupTaskDetails.test.tsx`; modificar `group-ipc.ts`, `channels.ts`, `register-app-ipc.ts`, `preload/index.ts`, `preload/types.ts`, `GroupTaskPanel.tsx`, `groupSidePanelRefresh.ts`, `GroupRoom.tsx` e testes correspondentes.

**Interfaces:** consome Tarefas 1–4. Produz `window.modus.group.getWorkState(groupId, executionId?)`, `listTaskTransitions(taskId)` e evento `group.task-changed` com groupId/taskId/stateVersion. Mudanças de draft pelo usuário usam `updateTask(taskId, draft, expectedVersion)`, sem aceitar owner/QA status afirmados pelo renderer.

- [x] Adicionar testes de handlers trusted/strict e painel: `shows_blocker_dependencies_and_qa`, `stale_response_does_not_replace_newer_task`, `removed_evidence_source_is_visible`, `cancel_is_user_only`. Assertar owner/reviewer/stage/priority, critérios e link QA; atualização fora de ordem respeita stateVersion e troca de Grupo desmonta subscriptions.
- [x] Rodar `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/main/ipc/group-work-ipc.test.ts apps/desktop/src/renderer/src/features/groups/GroupTaskDetails.test.tsx apps/desktop/src/renderer/src/features/groups/GroupRoom.test.tsx`; esperar falhas novas.
- [x] Implementar bridge/preload e painel com estados `blocked`, evidência aprovada/pendente/obsoleta/indisponível, histórico e navegação para a sessão/run real. Reutilizar UI existente para detalhes de execução; IDs técnicos não viram títulos de cards. Atualizar contadores e ordenação para incluir blocked.
- [x] Rodar os testes citados e `groupSidePanelRefresh.test.ts`; esperar aprovação. Fase A fica utilizável com delegação explícita.
- [x] Commit: `feat(groups): surface task criteria and verification state`.

## Tarefa 6: Política pura de proatividade

**Files:** criar `desktop/main/groups/group-proactivity-policy.ts`, `group-proactivity-policy.test.ts`; ampliar tipos em `desktop/shared/group-work-state.ts`.

**Interfaces:** consome `GroupWorkState`, transições e gates. Produz `decideGroupNextAction(snapshot: GroupDecisionSnapshot): GroupProactivityDecision | null`. Chave é derivada de groupId, executionId, sourceEventId, taskVersion, ação e target; função não lê relógio, DB, Git ou rede.

- [x] Adicionar testes de tabela para modo suggest/opt-in em atribuição, desbloqueio, review_requested, changes_requested e QA atualizado. Assertar uma ação no máximo; owner/reviewer correto; eventos com wake explícito já agendado retornam null; snapshot idêntico retorna decisão idêntica.
- [x] Adicionar `stop_or_waiting_user_prevents_auto_wake`, `missing_qa_suggests_without_claiming_completion`, `unavailable_member_or_exhausted_budget_never_wakes`, `silence_and_public_text_are_not_events`. Impedimentos terminais não criam sugestão acionável; falta de QA/capacidade usa motivo útil.
- [x] Rodar `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/main/groups/group-proactivity-policy.test.ts`; esperar falha inicial.
- [x] Implementar política com prioridade determinística: respeitar gates, dependências, maior prioridade de tarefa, sequência de evento e taskId como desempate. Somente transições tipadas permitem wake; mudança de modo não ressuscita eventos antigos nem cria execução nova.
- [x] Rodar o mesmo comando; esperar aprovação.
- [x] Commit: `feat(groups): add deterministic proactivity policy`.

## Tarefa 7: Entrega durável dentro do Group Runtime

**Files:** criar `desktop/main/groups/group-proactivity-store.ts`, `group-proactivity-store.test.ts`; modificar `desktop/main/db/database.ts`, `groups/group-runtime.ts`, `group-job-store.ts`, `group-runtime-lib.ts`, `group-runtime-service.ts`; criar `group-proactivity-runtime.test.ts`.

**Interfaces:** consome Tarefas 2, 4 e 6. Produz `persistGroupProactivityDecision(decision: GroupProactivityDecision): GroupActionRecord`, `listPendingGroupActions(groupId?: string): GroupActionRecord[]` e `GroupRuntime.handleTaskTransition(event: GroupTaskTransitionEvent): void`. `GroupActionRecord` inclui decision, deliveryState (`suggested | pending | dispatched | discarded | invalidated`), wakeMessageId/jobId opcionais e versão.

- [x] Adicionar testes de recuperação em três pontos: depois de decisão persistida, depois de criar message/job e antes do pump, depois de iniciar job. Assertar uma mensagem/job por chave e retomada de ação pending; Stop/archive/removal entre decisão e dispatch invalida; budgets não dobram após retry.
- [x] Rodar `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/main/groups/group-proactivity-store.test.ts apps/desktop/src/main/groups/group-proactivity-runtime.test.ts`; esperar falhas novas.
- [x] Persistir modo por Grupo com default `suggest` e tabela `group_proactivity_actions` com chave única. Usar outbox transacional para decisão pendente; criação de message/job e marcação dispatched ocorrem na mesma transação da persistência atual do runtime. Só chamar pump depois do commit; recuperar pela infraestrutura atual, sem timer adicional.
- [x] Revalidar tarefa/versão, execução ainda ativa, budgets, Stop, espera pelo usuário, membro e dependências imediatamente antes de materializar wake. Processar a transição tipada antes de aposentar a chain idle no encerramento do turno. Não usar `handleTaskWake` de forma que um evento automático tardio abra outra chain após a original terminar. Consumir transições existentes e QA vinculado; não adicionar ferramentas de Grupo ao safe-dispatch individual.
- [x] Rodar testes citados, `group-runtime-reliability.test.ts`, `group-runtime.test.ts` e `group-runtime-supersede.test.ts`; esperar aprovação, incluindo silêncio sem retomada.
- [x] Commit: `feat(groups): dispatch proactive wakes durably`.

Revisão independente: round 1 solicitou quatro correções; a round 2 aprovou o diff `fbd11b7..d3a0cfd`, confirmando as quatro como resolvidas e sem regressões críticas/importantes. Registro completo em `reviews/task-7-review-round-1.md` e `reviews/task-7-review-round-2.md` no ledger SDD.

## Tarefa 8: Preferência, sugestões e aprovação de próxima ação

**Files:** criar `desktop/renderer/src/features/groups/GroupProactivityControls.tsx`, `GroupProactivityControls.test.tsx`; modificar `group-work-ipc.ts`, seus testes, preload/channels, `GroupActivityPanel.tsx`, `GroupRoom.tsx`, `groupSidePanelRefresh.ts`.

**Interfaces:** consome Tarefas 5–7. Produz `setProactivityMode(groupId, mode)`, `listSuggestions(groupId)`, `resolveSuggestion(actionId, decision: "accept" | "discard", expectedVersion)`; evento `group.suggestion-changed`. Aceitar usa o mesmo caminho validado/durável da Tarefa 7.

- [x] Adicionar testes `default_is_suggest`, `opt_in_is_per_group`, `accept_stale_suggestion_rechecks_task`, `double_accept_creates_one_wake`, `accept_after_chain_end_requires_explicit_new_execution`, `discard_survives_reopen`, `stop_during_accept_prevents_dispatch`. Assertar motivo/origem visíveis e rollback do toggle quando IPC falhar.
- [x] Rodar `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/renderer/src/features/groups/GroupProactivityControls.test.tsx apps/desktop/src/main/ipc/group-work-ipc.test.ts`; esperar falhas novas.
- [x] Implementar controle explícito e cards com próxima ação, destino e motivo. Editar sugestão significa enviar delegação explícita com tarefa/target validados; não editar reasonCode/QA/operationId pelo renderer. Aceitar após fim da chain exige ação explícita rotulada para iniciar nova execução, via o caminho existente de execução do usuário; preservar referência ao evento antigo, sem ressuscitar a chain encerrada. Reabertura carrega modo e sugestões persistidos; mudança para suggest cancela ações automáticas ainda não iniciadas, preservando jobs explícitos.
- [x] Rodar os testes citados e `GroupActivityPanel.test.tsx`; esperar aprovação. Fase B fica utilizável.
- [x] Commit: `feat(groups): expose proactivity mode and suggestions`.
- [x] Revisão independente da implementação aprovada após o fix de recuperação; iniciar Tarefa 9 a partir do head aprovado.

## Tarefa 9: Metadados explícitos de capacidades

**Files:** criar `desktop/shared/group-capabilities.ts`, `group-capabilities.test.ts`; modificar `shared/agent-templates.ts`, `agent-templates.test.ts`, `contracts-parts/contracts-part-08.ts`, `main/agents/agents-store.ts`, `agents-store.test.ts`, `main/db/database.ts`, `main/ipc/agents-ipc.ts`, `main/ipc/schemas.ts`, `main/ipc/schemas-part-02.ts`, `renderer/src/features/agents/AgentDialog.tsx` e testes.

**Interfaces:** produz `GroupMemberCapabilities = { capabilityIds: string[]; supportedTaskKinds: GroupTaskKind[] }`, campos equivalentes em Create/UpdateAgentInput e AgentInfo; `normalizeGroupMemberCapabilities(input: GroupMemberCapabilities): GroupMemberCapabilities`. IDs canônicos: `plan`, `implement`, `verify`, `review`, `research`, `docs`; ferramentas ativas não são armazenadas como permissões presumidas.

- [x] Adicionar testes `custom_agent_can_edit_capabilities`, `legacy_missing_capabilities_stay_empty`, `renaming_role_does_not_change_capabilities`, `template_capabilities_are_explicit`. Assertar edição persistida, nenhuma inferência por nome/persona e duplicatas normalizadas.
- [x] Rodar `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/shared/group-capabilities.test.ts apps/desktop/src/main/agents/agents-store.test.ts apps/desktop/src/renderer/src/features/agents/AgentDialog.test.tsx`; esperar falhas novas.
- [x] Persistir capability metadata validada no perfil existente, preservar campos anteriores e publicar no roster DTO. Declarar capacidades nos templates oficiais por IDs de template conhecidos; não aplicar regex ao nome do template. Gerador de persona mantém apenas role/instructions; não inventa permissões ou capacidades sem escolha explícita.
- [x] Expor seleção de capacidades/tipos no editor e respeitar schemas de criação de Grupo, edição e templates. Ler ferramentas ativas pelo registry/profile/overrides atuais durante snapshot, sem ativá-las para atender um match.
- [x] Rodar comandos citados e testes de templates/IPC; esperar aprovação.
- [x] Commit: `feat(agents): configure explicit group capabilities`.
- [x] Revisão independente aprovou os metadados de capacidade e a cópia entre Grupos após fix; iniciar Tarefa 10 a partir do head aprovado.

## Tarefa 10: Roteamento e fluxo supervisionado tipados

**Files:** criar `desktop/main/groups/group-capability-router.ts`, `group-capability-router.test.ts`; modificar `shared/group-supervised-flow.ts`, seu teste existente, `main/groups/group-runtime-lib.ts`, `group-runtime.ts`, `group-autonomous-wake.test.ts`, `group-supervised-flow.runtime.test.ts`.

**Interfaces:** consome Tarefas 1, 4, 6–9. Produz `routeGroupTask(input: GroupRoutingInput): GroupRoutingResult`, resultado `selected | suggest_lead | needs_user` com target opcional, motivos e candidatos; `planSupervisedCodeFlow(input: { task: GroupTask; workState: GroupWorkState }): SupervisedFlowPlan` substitui classificação por body.

- [x] Adicionar testes `explicit_mention_takes_priority`, `busy_or_permission_incompatible_member_is_not_auto_selected`, `renamed_portuguese_and_english_roles_route_identically`, `no_capabilities_or_no_lead_needs_user`, `reviewer_removal_blocks_review`. Mesmos metadados e tarefas com texto PT/EN devem retornar mesmos agentes/estágios.
- [x] Rodar `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/main/groups/group-capability-router.test.ts apps/desktop/src/main/groups/group-autonomous-wake.test.ts apps/desktop/src/main/groups/group-supervised-flow.runtime.test.ts`; esperar falhas novas.
- [x] Implementar filtro por capacidades necessárias, ferramentas realmente ativas e disponibilidade; desempatar por owner existente, prioridade, menor carga e sessionId. Roteamento e revalidação consultam o mesmo conjunto filtrado de ferramentas que PiSdkRuntime instala no prompt; `ToolRegistry.resolveActiveTools(profile, overrides)` permanece como fallback para chamadas sem conjunto efetivo fornecido. Ferramenta ativa não significa permissão concedida, e o roteamento não abre prompt nem amplia permissões. Menção do usuário preserva target válido; se indisponível ou incompatível, retornar motivo ao usuário sem troca silenciosa. Sem confiança/capacidade, sugerir Lead; sem Lead elegível, `needs_user`.
- [x] Remover `classifySupervisedAsk(body)` do caminho de execução e regex de cargo do roteamento; calcular stages a partir de kind/política/dependências/estado. Pedidos sem tarefa tipada seguem recepção pelo Lead ou membro explicitamente mencionado para criar/propor tarefa; não iniciar pipeline por comprimento/palavra do texto. Atualizar wake prompts/snapshots com IDs, gates e delegações tipados.
- [x] Rodar testes citados e testes compartilhados de supervised-flow; esperar aprovação. Fase C fica utilizável em ambos os modos.
- [x] Commit: `feat(groups): route typed work by agent capabilities`.
- [x] Revisão independente aprovou a implementação após correção de projeção de delegação e ferramentas efetivas; commit corretivo `5df56d7`. Registrar checkpoint e iniciar Tarefa 11 a partir dele.

## Tarefa 11: Serviço de integração com prévia e permissão

**Files:** criar `desktop/main/groups/group-integration-service.ts`, `group-integration-service.test.ts`; modificar `main/git/git-service.ts`, `git-service.test.ts`, `main/db/database.ts`, `groups/group-task-store.ts`; acrescentar contratos a `shared/group-work-state.ts`.

**Interfaces:** consome gates/fingerprint das Tarefas 1–3. Produz `previewGroupTaskIntegration(taskId: string): Promise<GroupIntegrationPreview>`, `applyGroupTaskIntegration(input: { taskId: string; previewId: string; confirmedByUser: true }): Promise<GroupIntegrationRecord>`, `abortGroupTaskIntegration(taskId: string): Promise<GroupIntegrationRecord>`. Preview inclui source/target branch/SHAs, taskVersion, sourceFingerprint, commits, arquivos/diff resumido e ID persistido; record usa `ready | applying | applied | conflict | aborted | no_changes`.

- [ ] Adicionar testes `permission_denied_never_applies`, `changed_source_or_target_rejects_preview`, `dirty_target_or_pending_merge_rejects_apply`, `conflict_blocks_task_and_can_abort`, `apply_retry_does_not_repeat_merge`, `applied_is_not_committed_or_pushed`. Usar repositórios temporários reais nos cenários Git e broker stub nos cenários de permissão.
- [ ] Rodar `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/main/groups/group-integration-service.test.ts apps/desktop/src/main/git/git-service.test.ts`; esperar falhas novas.
- [ ] Implementar preview somente de leitura. Se houver mudanças não commitadas na origem, mostrar que precisa finalizar a branch e manter aplicação indisponível; não chamar `finishSubagentWorktree` silenciosamente para montar prévia, pois ele pode executar add/commit. Finalizar origem usa ação Git explícita já autorizada; depois recalcular fingerprint e os gates antes de integrar.
- [ ] Aplicação exige confirmação e `requestPermission`/decisão existente para `git.write`; só depois chama `applySubagentWorktree`. Não presumir proteção porque outra IPC de subagent chama o mesmo serviço. Revalidar source/target/task depois de aguardar permissão, serializar por repositório e impedir duas aplicações concorrentes. Persistir intenção antes do efeito e reconciliar `applying` com Git na recuperação, sem executar merge novamente às cegas.
- [ ] Registrar conflito e arquivos; transição especial `done → blocked` só por conflito de integração confirmada, preservando QA/revisão da origem. Abort volta a ready e restaura o estado pré-integração; revisão/código alterado exige gates novamente. `applied` significa merge aplicado sem commit, não task entregue/commit confirmado. Reusar abort que valida pertença do merge ao worktree; nunca abortar merge alheio.
- [ ] Rodar testes citados; esperar aprovação sem merge commit/push. Não remover worktree enquanto houver aplicação pendente.
- [ ] Commit: `feat(groups): preview and authorize branch integration`.

## Tarefa 12: IPC e UI para integrar e abortar

**Files:** criar `desktop/main/ipc/group-integration-ipc.ts`, `group-integration-ipc.test.ts`, `desktop/renderer/src/features/groups/GroupIntegrationDialog.tsx`, `GroupIntegrationDialog.test.tsx`; modificar channels/register-app-ipc/preload, `GroupTaskDetails.tsx`, `GroupActivityPanel.tsx` e testes.

**Interfaces:** consome Tarefa 11. Produz métodos preload correspondentes a preview/apply/abort e evento `group.integration-changed` com taskId, record e versão. Handler resolve cwd/branches no main; renderer manda só IDs e confirmação.

- [ ] Adicionar testes `preview_names_both_branches_and_diff`, `apply_requires_current_preview_confirmation`, `stale_preview_requires_new_confirmation`, `conflict_shows_abort`, `denied_permission_keeps_preview`, `ipc_rejects_forged_paths_or_missing_confirmation`. Assertar comportamento acessível e ausência de aplicação no mount/reopen/toggle opt-in.
- [ ] Rodar `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/main/ipc/group-integration-ipc.test.ts apps/desktop/src/renderer/src/features/groups/GroupIntegrationDialog.test.tsx`; esperar falhas novas.
- [ ] Implementar handlers trusted/strict, bridge e diálogo com commits/diff resumido, destino, confirmação, estado pendente, motivo de gate e abortar. Exibir `applied` como alterações aplicadas aguardando conclusão Git; não chamar de integrada/entregue antes do usuário concluir o merge. Prévia inválida é recarregada, sem reaplicar a confirmação antiga.
- [ ] Rodar comandos citados e testes de GroupTaskDetails/GroupActivityPanel; esperar aprovação. Fase D fica utilizável.
- [ ] Commit: `feat(groups): add confirmed integration workflow`.

## Tarefa 13: Cobertura completa, documentação e entrega por fase

**Files:** modificar `docs/natural-groups-n4-proactive.md`; criar `docs/group-task-proactivity.md`, `desktop/main/groups/group-workflow.integration.test.ts`; atualizar testes existentes de runtime/safe-dispatch somente para garantir compatibilidade.

**Interfaces:** consome todas as entregas anteriores. Não acrescenta comportamento novo.

- [ ] Adicionar cenário completo: criação com critérios/dependência → atribuição explícita → run QA → revisão vinculada → done → preview → confirmar → aplicação sem commit. Separar cenário suggestion-only e opt-in; assertar origem/versão de todos os eventos e uma ação por transição.
- [ ] Adicionar recuperação com eventos fora de ordem, Stop/supersede, owner removido, run individual não associado, evidência obsoleta e falha de storage. Assertar que Task State/QA do harness individual e safe-dispatch não ganham escrita/dispatch de Grupo.
- [ ] Rodar `npm exec --workspace @modus/desktop -- vitest run --root ../.. apps/desktop/src/main/groups/group-workflow.integration.test.ts`; esperar aprovação depois de implementar fixtures, sem LLM/API externos.
- [ ] Corrigir N4 com nota histórica e comportamento atual; documentar ferramentas, critérios, requisitos de verificação, defaults legados, capacidades, transições, aceitação de sugestões, opt-in/Stop e integração/abort. Vincular spec/plano e citar exemplos PT/EN tipados. Reconciliar a documentação da Fase A primeiro; adicionar descrição das fases seguintes conforme entregues.
- [ ] Rodar uma vez os testes focados criados e existentes impactados, mais `harness/qa-evidence.test.ts`, `harness/task-state.test.ts`, `harness/safe-dispatch.test.ts`, registry, store, IPC e renderer de Grupos. Rodar `npm run typecheck --workspace @modus/desktop`, `npm run check` e `npm run build --workspace @modus/desktop`; todos devem sair com código 0. Reportar pré-requisito ou falha real de build separadamente de regressão; não afirmar aprovação se comando não executou.
- [ ] Revisar diff por cobertura dos critérios da especificação e ausência de efeitos em permissões/budgets. Atualizar checkboxes e registrar resultados reais no plano; manter grupos padrão em suggest e não migrar tarefas antigas para required.
- [ ] Commit: `docs(groups): document verified proactive workflows`.

## Matriz de cobertura da especificação

| Requisito | Tarefas responsáveis |
| --- | --- |
| Estado, critérios, dependências, prioridade, bloqueio e cancelamento | 1–2, 4–5 |
| QA real, referências por critério e revisão/fingerprint atual | 1–3, 11 |
| Ferramentas novas, handoff atribuído atomicamente, agree/review gated | 4 |
| Store autoritativo, eventos/IPC e painel | 2, 5, 8, 12 |
| Política pura, sugestão default, opt-in limitado | 6–8 |
| Idempotência, reinício, Stop, espera pelo usuário e budgets | 2, 6–8, 13 |
| Metadados, disponibilidade, tools reais, fallback e idioma | 9–10 |
| Fluxo supervisionado tipado | 3, 10 |
| Prévia, confirmação, git.write, conflitos e abort | 11–12 |
| Legados, N4 e compatibilidade com harness individual | 2, 7, 13 |

## Resultado da revisão do plano

A revisão conectou cada requisito a uma tarefa, conferiu caminhos existentes e diferenciou módulos novos. Foram incorporados fingerprint para arquivos não commitados, versionamento otimista, associação task/run explícita, outbox para recuperar wakes e proteção contra aprovação ou prévia obsoleta. Integração usa permissão na entrada nova e preserva a semântica `merge --no-commit` do serviço Git. Os testes são critérios de execução futura; nenhum resultado de implementação é presumido por este documento.
