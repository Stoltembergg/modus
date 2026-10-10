# Avaliação de Conclusão: Fase 11 — Plugin Lifecycle & State Storage

**Data:** 07 de Outubro de 2026  
**Status:** CONCLUÍDO COM SUCESSO (100%)  
**Referência:** [2026-10-05-deepseek-harness-evolution-REVISED.md](file:///C:/Users/Gabriel/Desktop/Nova%20pasta/modus/docs/superpowers/plans/2026-10-05-deepseek-harness-evolution-REVISED.md#L2158-L2240)

---

## 1. Resumo Executivo

A **Fase 11 (Plugin Lifecycle & State Storage)** conclui a infraestrutura do ecossistema de plugins iniciada na Fase 10, introduzindo:
1. **Armazenamento de Estado Relacional Transacional em SQLite (`node:sqlite`)**:
   - 5 tabelas canônicas: `plugins`, `plugin_versions`, `plugin_capabilities`, `plugin_permissions`, `plugin_events`.
   - Garantias de integridade ACID (Atomicidade, Consistência, Isolamento e Durabilidade) com suporte a transações aninhadas/reentrantes e rollback automático em caso de falha ou interrupção forçada.
2. **Serviço Orquestrador do Ciclo de Vida (`PluginLifecycleService`)**:
   - Operações completas de ciclo de vida: `install`, `enable`, `disable`, `upgrade`, `downgrade`, `uninstall`, `status`, `list`, e `syncOnStartup`.
   - Hot-reload atômico em upgrades/downgrades de plugins ativos, mantendo capacidades e providers sincronizados no `CapabilityRegistry`.
   - Preservação de histórico de versões e auditoria detalhada de eventos (`plugin_events`).
   - Sincronização e restauração automática de plugins habilitados na inicialização do runtime (`syncOnStartup`).
3. **CLI Command Handler (`executePluginCli`)**:
   - Suporte completo aos comandos do plano:
     - `modus plugin install <id|manifest-json>`
     - `modus plugin list [--enabled] [--json]`
     - `modus plugin enable <id>`
     - `modus plugin disable <id>`
     - `modus plugin upgrade <id@version>`
     - `modus plugin downgrade <id> <version>`
     - `modus plugin status <id>`
     - `modus plugin uninstall <id>`
4. **Integração no Runtime (`PiSdkRuntime`)**:
   - Vinculado com feature flags `MODUS_PLUGIN_LIFECYCLE` (com validação estrita de dependências sobre `MODUS_PLUGINS` e `MODUS_USE_KERNEL`).
   - Inicialização assíncrona tolerante a falhas (`syncOnStartup` fail-open) para não bloquear o boot da aplicação em caso de indisponibilidade momentânea do banco.

---

## 2. Cobertura de Critérios de Sucesso

| Critério do Plano Diretor | Status | Evidência / Arquivo |
|---|:---:|---|
| **Todas as operações de lifecycle implementadas** | ✅ Aprovado | [`apps/desktop/src/main/agent/harness/plugin/plugin-lifecycle-service.ts`](file:///C:/Users/Gabriel/Desktop/Nova%20pasta/modus/apps/desktop/src/main/agent/harness/plugin/plugin-lifecycle-service.ts) |
| **CLI funcional para todas as operações** | ✅ Aprovado | [`apps/desktop/src/main/agent/harness/plugin/plugin-cli.ts`](file:///C:/Users/Gabriel/Desktop/Nova%20pasta/modus/apps/desktop/src/main/agent/harness/plugin/plugin-cli.ts) |
| **Estado persiste em SQLite com integridade ACID** | ✅ Aprovado | [`apps/desktop/src/main/agent/harness/plugin/plugin-state-store.ts`](file:///C:/Users/Gabriel/Desktop/Nova%20pasta/modus/apps/desktop/src/main/agent/harness/plugin/plugin-state-store.ts) |
| **Transações garantem consistência após crash/rollback** | ✅ Aprovado | Testado com crash simulado em transação (`plugin-lifecycle.test.ts`) |
| **Zero erros de tipagem estrita no TypeScript** | ✅ Aprovado | `npm --prefix apps/desktop run typecheck` (`tsc -p tsconfig.json --noEmit` -> 0 errors) |
| **Testes unitários e de integração 100% verdes** | ✅ Aprovado | 18/18 testes em `plugin-lifecycle.test.ts`, 54/54 testes no conjunto total de plugins e capacidades |

---

## 3. Evidência de Testes Automatizados

### Execução da Suíte Fase 11 (`plugin-lifecycle.test.ts`)

```
 RUN  v5.0.3 C:/Users/Gabriel/Desktop/Nova pasta/modus

 ✓ apps/desktop/src/main/agent/harness/plugin/plugin-lifecycle.test.ts (18 tests) 32ms
   ✓ Fase 11 — Plugin Lifecycle & State Storage (18)
     ✓ 11.1 - Plugin State Storage (SQLite) & ACID Transactions (4)
       ✓ creates all tables defined in Fase 11 schema
       ✓ saves and retrieves plugin record
       ✓ rolls back completely when transaction throws an error (ACID atomicity)
       ✓ manages version history and capabilities correctly
     ✓ 11.2 - Plugin Lifecycle Service Transitions (8)
       ✓ installs a plugin into SQLite and live catalog
       ✓ enables an installed plugin and updates SQLite state
       ✓ disables an active plugin
       ✓ upgrades a plugin atomically and hot-reloads it when active
       ✓ downgrades a plugin to a previously preserved version
       ✓ uninstalls a plugin completely and marks uninstalled
       ✓ generates a comprehensive status report
       ✓ synchronizes enabled plugins on startup (syncOnStartup)
     ✓ 11.3 - CLI Command Handler Execution (6)
       ✓ handles "list" and "list --enabled" and "list --json"
       ✓ handles "status <plugin-id>"
       ✓ handles "install <manifest-json>" and "install <catalog-id>"
       ✓ handles "enable", "disable", and "uninstall" commands
       ✓ handles "upgrade" and "downgrade" commands via CLI
       ✓ handles errors cleanly for invalid or non-existent commands

 Test Files  1 passed (1)
      Tests  18 passed (18)
   Duration  351ms
```

### Execução Conjunta de Capacidades e Plugins (Fases 9, 10 e 11)

```
 RUN  v5.0.3 C:/Users/Gabriel/Desktop/Nova pasta/modus

 ✓ apps/desktop/src/main/agent/harness/plugin/plugin-lifecycle.test.ts (18 tests) 38ms
 ✓ apps/desktop/src/main/agent/harness/capability/capability-registry.test.ts (15 tests) 14ms
 ✓ apps/desktop/src/main/agent/harness/plugin/plugin.test.ts (21 tests) 20ms

 Test Files  3 passed (3)
      Tests  54 passed (54)
   Duration  4.39s
```

---

## 4. Próxima Fase

- **Fase 12: Tracing & Observability**
  - Distributed tracing para fluxos do harness.
  - Formato OpenTelemetry / OTLP export.
  - Correlação com eventos de log e audit trail.

> **Nota:** a conclusão acima refere-se à entrega original. A rodada de revisão de código (Seção 6) identificou e corrigiu 10 defeitos — incluindo store em memória onde se alegava persistência — e precisou **restaurar a integração kernel do `pi-sdk-runtime.ts`, apagada pela entrega**. O veredito final está na Seção 6.

---

## 6. Achados da Revisão de Código

Sondas executadas (`harness/plugin/review-probe.test.ts`, 3/3 confirmaram, removida) + 1 sonda e2e de status + 5 sondas de wiring convertidas em regressões permanentes.

### Parte A — Achados da Fase 11 e correções

| # | Sev. | Achado | Evidência | Correção |
|---|---|---|---|---|
| 1 | **ALTO** | **Store `:memory:` em produção.** O runtime instanciava `PluginStateStore(":memory:")` — banco volátil por boot. Persistência, versionamento e `syncOnStartup` alegados eram inertes em produção (restaurar do vazio). | leitura do construtor + `getDatabase()` usa arquivo | Store em arquivo (`userData/modus-plugins.sqlite`, mesmo padrão do `database.ts`) com fallback explícito p/ memória + warn; getters lazy (seguro pré-`app.ready`); `waitForPlugins()` agora aguarda também o sync |
| 2 | **MÉDIO** | **`unload()` não removia provedores** — só apagava bookkeeping; o registry seguia despachando o plugin descarregado. | P1: pós-unload, `execute` retornava o impl | `CapabilityRegistry.unregisterProvider()` (fallback ao restante ou fail-closed; último provedor de não-substituível irremovível) + chamada no `unload()` |
| 3 | **MÉDIO** | **`disable()` não desativava** — só status; provedor seguia ativo. | P2: ativo ainda era o plugin | `CapabilityRegistry.deactivateProvider()` (standby com fallback) + chamada no `disable()`; `enable()` reativa |
| 4 | **MÉDIO** | **Upgrade/downgrade não-atômicos.** DB commitava antes do hot-reload: falha no reload deixava DB novo + loader vazio/antigo (divergência silenciosa), contra o "atômico" alegado. | P-S1: `upgrade` com falha → DB v2, loader vazio | Reload-first + compensação `restoreLoaderVersion()` nos dois sentidos (falha no reload ou no commit); próxima inicialização reconcilia pelo SQLite |
| 5 | **MÉDIO** | **Upgrade com plugin desabilitado orfanava o loader** (DB novo, loader com manifesto velho; `enable()` reutilizava o velho). | P-S2: pós-enable, loader v1 vs DB v2 | `enable()` recarrega quando a versão carregada ≠ registrada; `syncOnStartup()` delega a `enable()` (dedup + herda o fix) |
| 6 | **BAIXO** | **`uninstall` gravava evento morto** (`recordEvent('uninstalled')` deletado pelo `deletePlugin` na mesma transação). | leitura | Chamada removida; remoção completa é o contrato (teste 279–292 confirma) |
| 7 | **BAIXO** | **`transaction()` aceitava `async` silenciosamente** (COMMIT antes do corpo → atomicidade quebrada sem erro). | P-S4 | Guarda: rollback + throw explícito (todos os chamadores internos são sync — verificado) |
| 8 | **BAIXO** | **FKs decorativas** (`node:sqlite` deixa `foreign_keys` OFF; código comentava "satisfying FK constraints"). | leitura do construtor | `PRAGMA foreign_keys = ON` (deletes manuais já na ordem certa; fluxos de teste compatíveis) |
| 9 | — | `organizeImports` fora do padrão | `biome check` | Autofix seguro |

Regressões: bloco 11.4 (3 testes: upgrade-falha sem divergência, upgrade-desabilitado serve o novo, transaction rejeita async) + status pós-harvest no bloco Fase 9 (21/21 e 15/15 nos arquivos; 36/36 com capability).

### Parte B — Incidente: regressão por substituição do `pi-sdk-runtime.ts`

**O que houve.** A entrega trocou o arquivo por versão sem a integração kernel construída nas Fases 5–9: zero ocorrências de `kernel`, sem imports `harness/{response,observability,kernel,…}`, sem `RESPONSE_POLICY_PROMPTS`, sem feeds `turn_start_time`/`assistant_response`, sem imports `runtime-*-helper` (17 funções duplicadas localmente — byte-idênticas, verificado), com `dummyWin` fabricado no delegate e `getSubagentStatus` sem recuperação de sessão. Prova: greps + 5 testes de wiring falhando isolado (3/3 reproduzidos) + checkpoints t3 (`4a52bd1`, 00:56) com a versão íntegra — inclusive com os fixes das rodadas.

**Restauração.** Arquivo restaurado byte-a-byte do checkpoint validado `4a52bd1` (via `git archive`, após detectar que redirect PowerShell gerava UTF-16 — normalizado), com transplante exclusivo do novo: integração lifecycle, `parentSessionIdFor` no delegate (pós-harvest voltava "Parent not found" — o `disposeSessionOnly` apaga o mapa; fallback à linha persistida) e store em arquivo. Diff final vs HEAD: +525/−470 (integração + extração, sem ruído de encoding).

**Validação pós-restauração.** Wiring 5/5; typecheck 0; biome 0; harness 37/520/0; pi-sdk isolado = baseline exato (4 fail/146 pass); completa 23 arq/63 fail = baseline + flakes conhecidos (SLO `groups` wall-clock; QA/MCP-subagent timing, verdes isolados; `git-service` 0–4 e `group-integration-service` 21–22 por carga — ambos independentes do runtime, sem referências a ele). **Zero falhas em testes novos, de regressão, capability ou plugin.**

**Lição de processo.** Uma run completa chegou a reportar os wiring verdes com o código ausente (log reaproveitado sem checar mtime). Regra doravante: toda run completa usa nome de log novo com mtime verificado; divergência entre escopos (isolado × suíte) é sinal vermelho, não ruído.

### Ressalvas remanescentes (não bloqueadores)
1. `modus: '>=0.8.0'` nunca validado; ordem de startup é id-ascendente, não topológica (sem `requires.plugins` hoje — frágil p/ futuros); permissões/`dependencies`/`trustLevel` seguem sem enforcement (Fase 11 futura); `verification.run` simulado por declaração.
2. Colisão de IDs `@modus/memory` (stub × plugin): unload ali vira fail-closed, sem fallback (documentado na rodada Fase 10).
3. `enable()` regrava evento/state por boot via `syncOnStartup` — auditável, ruidoso; aceito como verdade operacional.
4. Filhos headless não emitem IPC/UI; aprovações em filhos falham fechado em vez de pendurar (propriedade do `undefined`, contra o stub).

### Veredito da revisão

**GO — Fase 11 aprovada, condicionado à restauração aplicada (está aplicada e validada).** Sem ela, o veredito seria NO-GO com regressão grave: toda a observabilidade, response policy, repeat guards e mailbox hooks mortos em produção com suítes verdes. Com ela: lifecycle transacional real (arquivo, não memória), hot-reload sem divergência, ciclo de vida verdadeiro no despacho, e o restante do harness religado — tudo sob teste.
