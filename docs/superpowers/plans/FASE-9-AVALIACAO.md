# Avaliação da Fase 9 — Capability Registry + Provenance Architecture

## 1. Visão Geral
A **Fase 9** estabelece os alicerces do ecossistema extensível do Modus, introduzindo uma camada de abstração que desacopla a interface abstrata de uma capacidade (`Capability`) da sua implementação concreta fornecida por provedores internos ou plugins externos (`CapabilityProvider`).

Além do desacoplamento estrito e semântico de versões (Capability API Version vs. Provider Semver Version), a arquitetura incorpora rastreamento de proveniência (`ProvenanceTracker`), telemetria por ring-buffer, verificação de permissões granulares, proteção contra sequestro de componentes vitais do runtime (`replaceable: false`), e camada de descoberta JSON/CLI para inspeção e alternância de provedores em tempo de execução.

---

## 2. Componentes Entregues

| Componente | Arquivo | Responsabilidade |
|---|---|---|
| **Contratos & Tipagem** | [`apps/desktop/src/main/agent/harness/capability/capability-types.ts`](file:///C:/Users/Gabriel/Desktop/Nova%20pasta/modus/apps/desktop/src/main/agent/harness/capability/capability-types.ts) | Definições de `Capability`, `CapabilityProvider`, `TrustLevel`, `PluginPermissions`, `CapabilityProvenance`, `CapabilityExecutionTrace`, `DiscoveredCapability`, e classes de erro. |
| **Proveniência & Rastreio** | [`apps/desktop/src/main/agent/harness/capability/capability-provenance.ts`](file:///C:/Users/Gabriel/Desktop/Nova%20pasta/modus/apps/desktop/src/main/agent/harness/capability/capability-provenance.ts) | `ProvenanceTracker` com ring buffer de traces (limite configurável), agregação de latência média, taxa de erro por provedor, e timestamp de último uso. |
| **Capability Registry** | [`apps/desktop/src/main/agent/harness/capability/capability-registry.ts`](file:///C:/Users/Gabriel/Desktop/Nova%20pasta/modus/apps/desktop/src/main/agent/harness/capability/capability-registry.ts) | Gerenciador central de capacidades e provedores. Suporta registro multi-provedor, ativação, verificação de compatibilidade de versão SemVer (major match), chaveamento dinâmico (`switchProvider`), e proteção de invariantes (`agent.loop` não substituível). |
| **Capacidades Núcleo** | [`apps/desktop/src/main/agent/harness/capability/core-capabilities.ts`](file:///C:/Users/Gabriel/Desktop/Nova%20pasta/modus/apps/desktop/src/main/agent/harness/capability/core-capabilities.ts) | Especificação das 21 capacidades padrão do Modus (memória, contexto, agente, modelo, ferramentas, verificação, compactação, grupos, falhas) e ligação com provedores `@modus/*`. |
| **Descoberta & CLI** | [`apps/desktop/src/main/agent/harness/capability/capability-discovery.ts`](file:///C:/Users/Gabriel/Desktop/Nova%20pasta/modus/apps/desktop/src/main/agent/harness/capability/capability-discovery.ts) | `CapabilityDiscovery` com queries em JSON estruturado, formatação de tabela CLI limpa e comando `switch`. |
| **Feature Flagging** | [`apps/desktop/src/main/agent/harness/feature-flags.ts`](file:///C:/Users/Gabriel/Desktop/Nova%20pasta/modus/apps/desktop/src/main/agent/harness/feature-flags.ts) | Flag `MODUS_CAPABILITY_REGISTRY` integrada às variáveis de ambiente e overrides. |
| **Integração no Runtime** | [`apps/desktop/src/main/agent/pi-sdk-runtime.ts`](file:///C:/Users/Gabriel/Desktop/Nova%20pasta/modus/apps/desktop/src/main/agent/pi-sdk-runtime.ts) | Registro automático de capacidades no construtor do runtime e exposição através do getter público `getCapabilityRegistry()`. |
| **Testes de Unidade e E2E** | [`apps/desktop/src/main/agent/harness/capability/capability-registry.test.ts`](file:///C:/Users/Gabriel/Desktop/Nova%20pasta/modus/apps/desktop/src/main/agent/harness/capability/capability-registry.test.ts) | 13 testes cobrindo registro, versionamento, multi-provedores, chaveamento, proteções de imutabilidade, medição de latência, erros de execução, telemetria de proveniência, e tabelas de descoberta. |

---

## 3. Matriz de Capacidades Núcleo (21 Standard Capabilities)

| Domínio | Capacidade | Versão API | Substituível? | Provedor Padrão |
|---|---|---|---|---|
| **Memory** | `memory.retrieve` | 1.0 | Sim | `@modus/memory` |
| **Memory** | `memory.store` | 1.0 | Sim | `@modus/memory` |
| **Memory** | `memory.search` | 1.0 | Sim | `@modus/memory` |
| **Context** | `context.resolve` | 1.0 | Sim | `@modus/context` |
| **Context** | `context.compact` | 1.0 | Sim | `@modus/context` |
| **Context** | `context.summarize` | 1.0 | Sim | `@modus/context` |
| **Agent** | `agent.loop` | 1.0 | **Não (Core)** | `@modus/agent` |
| **Agent** | `agent.pause` | 1.0 | **Não (Core)** | `@modus/agent` |
| **Agent** | `agent.resume` | 1.0 | **Não (Core)** | `@modus/agent` |
| **Model** | `model.select` | 1.0 | Sim | `@modus/model` |
| **Model** | `model.switch` | 1.0 | Sim | `@modus/model` |
| **Tools** | `tools.shell` | 1.0 | Sim | `@modus/tools` |
| **Tools** | `tools.file` | 1.0 | Sim | `@modus/tools` |
| **Tools** | `tools.search` | 1.0 | Sim | `@modus/tools` |
| **Verification** | `verification.run` | 1.0 | Sim | `@modus/verification` |
| **Verification** | `verification.analyze` | 1.0 | Sim | `@modus/verification` |
| **Compaction** | `compaction.strategy` | 1.0 | Sim | `@modus/compaction` |
| **Groups** | `group.route` | 1.0 | Sim | `@modus/group` |
| **Groups** | `group.select` | 1.0 | Sim | `@modus/group` |
| **Failure** | `failure.analyze` | 1.0 | Sim | `@modus/failure` |
| **Failure** | `failure.predict` | 1.0 | Sim | `@modus/failure` |

---

## 4. Resultados da Validação

1. **TypeScript Typecheck (`tsc --noEmit`):**
   - 0 erros em `apps/desktop`.
2. **Suíte da Fase 9 (`capability-registry.test.ts`):**
   - 13 testes executados, 13 aprovados (100%).
3. **Suíte Completa do Harness (`harness/**`):**
   - 35 arquivos de teste, 476 testes aprovados, 0 falhas, 5 pulados.
4. **Contrato de Baseline de Regressão (`pi-sdk-runtime.test.ts`):**
   - 145 aprovados, 4 falhas pré-existentes idênticas ao baseline HEAD, 0 unhandled rejections.

---

## 5. Próximo Passo
Avançar para a **Fase 10: Modus Internal Plugins (Migração Incremental)**:
- **10A**: Criação dos 3 plugins piloto padrão (`@modus/memory`, `@modus/model-router`, `@modus/verifier`).
- **10B**: Migração incremental dos subsistemas para consumir o `CapabilityRegistry`.

> **Nota de versionamento deste documento:** este arquivo substituiu o relatório anterior da Fase 9 (refatoração do `pi-sdk-runtime` + delegação de subagentes, revisado com veredito GO e 5 correções). Aquele trabalho permanece válido e verificado: os feeds `turn_start_time`/`assistant_response`, o delegate com headless+isolamento+fail-closed e os 8 testes de regressão em `pi-sdk-runtime.test.ts` foram reauditados intactos nesta rodada.

---

## 6. Achados da Revisão de Código (rodada de 2026-10-06)

A revisão leu integralmente os 7 arquivos do subsistema, executou 3 sondas (`harness/capability/review-probe.test.ts`, removida ao final — 3/3 confirmaram os achados) e converteu as correções em regressões permanentes.

### Achados e correções

| # | Sev. | Achado | Evidência (sonda) | Correção |
|---|---|---|---|---|
| 1 | **ALTO** | **Proteção `replaceable: false` burlável.** Só `switchProvider` verificava o flag. `registerProvider` aceitava provedores atacantes e `activateProvider` trocava o ativo sem checar — sequestro de `agent.loop` em 2 linhas. | P1: register + activate de `@attacker/hijack-loop` → ativo trocado. P2: listagem com 2 provedores | `registerProvider` recusa provider-id diferente em capability não-substituível (mesmo id = update, permitido); `activateProvider` recusa troca com ativo definido (ativação inicial e idempotente permitidas — preserva `registerCoreCapabilities`). Mesma ordem de checagem do `switchProvider` |
| 2 | **MÉDIO** | **Tabela §3 divergente do código.** O doc listava `memory.compact`, `context.filter`, `model.route`, `tools.execute/spill`, `verification.assess`, `compaction.coordinate/prune`, `groups.coordinate/mailbox`, `failure.classify/recover`, `@modus/groups` — nenhum existe no código (que tem `memory.search`, `context.compact/summarize`, `model.switch`, `tools.shell/file/search`, `verification.analyze`, `compaction.strategy`, `group.route/select`, `failure.analyze/predict`, `@modus/group`). Contagem 21 confere; IDs não. O código é autoconsistente (dependências e `providerId` derivados batem), logo canônico. | diff doc × `CORE_CAPABILITIES` | Tabela §3 corrigida para os IDs do código (esta edição) |
| 3 | — | **`organizeImports` fora do padrão** nos arquivos do subsistema | `biome check` (4 erros) | Autofix seguro; testes revalidados após |
| 4 | — | **Teste 9.2 codificava o bypass** (registrava o atacante e só assertava o `switch`) | leitura | Reescrito: registro recusado + ativo inalterado + `switch` recusado; novos testes de `activate` e de flip do flag |

### Testes de regressão adicionados
- `capability-registry.test.ts` 9.2: recusa de registro/ativação/troca em não-substituível + ativação inicial/idempotente permitida + flip de `replaceable` via re-registro ignorado (15/15 no arquivo: 13 + 2 novos).

### Ressalvas remanescentes (não bloqueadores)
1. **Permissões declaradas, não aplicadas.** `PluginPermissions` (`tools.deny`, `filesystem`, `network`…) viajam no tipo e no registro, mas `execute()` não avalia nada (sonda P3: provider com `deny:['*']` executa normalmente). Não há ponto de enforcement implementável nesta camada sem um contrato de avaliação de ação — fica para a Fase 10A/10B, quando plugins reais existirem. A Seção 1 ("verificação de permissões granulares") deve ser lida como *modelo de dados*, não enforcement.
2. **Implementações default são stubs de eco** (`{status:'ok', contextEcho}`), não wiring real com memória/contexto/agente. Inócuo hoje: **nada em produção chama `execute()`** (grep: só testes); o runtime apenas registra o catálogo sob flag (default off). Risco latente do mesmo tipo do provider Fase 8 — reavaliar quando 10B ligar consumo real.
3. **`dependencies` (`verification.run@^1.0`) nunca validadas** — metadados decorativos até haver resolução de dependências.
4. **`trustLevel` só informativo** (tabela/JSON); nenhuma decisão o consome. Coerente com switching livre, mas documentado aqui.
5. `registerProvider` para capability inexistente e `switchProvider` idem lançam `NoProviderError` (tipo impreciso, mensagem clara) — cosmético, mantido.
6. Semântica `major-match` do SemVer é intencionalmente leniente (`1.0` ≡ `1.0.0`) — documentada, aceita.

### Matriz de validação (após as correções)

| Verificação | Resultado |
|---|---|
| `npm run typecheck` (apps/desktop) | **0 erros** ✅ |
| Biome `--diagnostic-level=error` (`harness/capability/`) | **0 erros** após autofix ✅ |
| `capability-registry.test.ts` | **15/15** (13 + 2 novos) ✅ |
| Suíte do harness | **35 arquivos / 478 pass / 5 skip / 0 fail** ✅ (era 34/463; +13 entrega +2 regressões) |
| `pi-sdk-runtime.test.ts` isolado | **149 testes: 4 fail (exatamente o baseline) / 145 pass** ✅ |
| Fixes das rodadas 7/8/9 (refatoração) | Reauditados intactos ✅ |
| Suíte completa no escopo dos baselines (`vitest run --root ../.. apps/desktop`) | **24 arquivos / 67 testes fail** vs. 22/59 (round4) e 23/60–64 (Fases 7–9): **mesmo conjunto** + 2 flakes sob carga já conhecidos (SLO `groups` 6.6 wall-clock; `GroupMessageList.timeline` animação — ambos verdes isolados) + 2 flakes de timing QA/subagent (verdes isolados). **Zero falhas em testes novos, de regressão ou do subsistema capability** ✅ |

### Veredito da revisão

**GO — Fase 9 (Capability Registry + Provenance) aprovada.** O registry é íntegro (registro, versionamento major-match, multi-provider, switch, proveniência com ring-buffer limitado, descoberta JSON/tabela), e sua garantia de segurança headline — inviolabilidade do núcleo — agora é real nas três portas (registro, ativação e troca), com prova automatizada. O escopo honesto do entregue fica registrado: **catálogo + proteções + telemetria, sem execução em produção e sem enforcement de permissões** — a Fase 10A/10B (plugins reais e migração do consumo) é onde essas ressalvas se resolvem.
