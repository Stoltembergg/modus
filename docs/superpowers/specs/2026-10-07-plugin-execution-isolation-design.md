# Executor isolado para plugins não confiáveis

**Status:** baseline arquitetural aprovado pelo usuário em 2026-10-07; implementação autorizada, começando por provas de viabilidade.  
**Escopo:** remediação futura de A01–A04. Este documento não afirma que qualquer achado foi fechado.

## Invariantes

- O bloqueio atual de `community`, `local` e origens sem autoridade host-owned permanece ativo durante toda a tranche, incluindo testes de integração. Artefatos de teste só podem ser autorizados por fixtures explicitamente isoladas.
- Código externo nunca executa no processo principal do Modus nem recebe Node, `process.env`, `fs`, `child_process`, sockets, Electron APIs, handles arbitrários ou acesso genérico ao host.
- Primeira versão de plugins externos é WASM-only. WASM/WASI não é, por si só, um sandbox; `node:wasi` não executa código não confiável.
- Um helper Rust dedicado com Wasmtime é a direção aprovada, condicionada à viabilidade dos adapters. O confinamento do SO deve preceder o recebimento, parsing, compilação, instanciação e execução dos bytes do guest.
- `CapabilityRegistry`, `PluginLoader`, `PluginLifecycleService`, catálogo, permissions, tracing, dependency graph, rollback, Safe Mode e `PiSdkRuntime` permanecem o control plane único. Não criar segundo registry ou lifecycle manager.
- Falha de adapter, política incompleta, quota não aplicada ou reap não confirmado significa negação fail-closed; nunca iniciar helper sem sandbox como fallback.
- Filesystem, network, shell, Git e credentials ficam sem grants até os brokers e respectivos riscos A07–A09 serem remediados e provados.
- Não stage/commit; preservar alterações locais preexistentes.

## Fronteira e fluxo

Um provider externo registrado no `CapabilityRegistry` é proxy criado pelo host e delega ao `PluginExecutionHost`. Os hooks de load/enable/lifecycle também atravessam o mesmo host. O guest não pode declarar identidade, trust, origem, versão, grants, IDs de request ou geração.

Fluxo: autorizar origem e digest imutável → preparar artefato → iniciar helper já confinado → validar handshake → conceder capabilities calculadas pelo host → enviar artefato → compilar/instanciar/executar no helper → validar resultado e evidência no host → encerrar ou descartar a geração. Reuso de processo só poderá ser considerado depois de prova explícita de limpeza e isolamento entre gerações; padrão inicial é processo novo por plugin/generation.

No encerramento: quarantine e bloqueio de dispatch → revogar grants e requests broker pendentes → cancel cooperativo limitado → kill do grupo de processos pelo adapter → confirmar ausência de execução remanescente → remover/restaurar providers e concluir rollback/estado durável. Timeout, Stop, crash, disable, uninstall, rollback e Safe Mode usam a mesma sequência. Para processos filhos do host, confirmar reap via API apropriada (`waitpid`/Job/cgroup). Um serviço `launchd` não é um filho waitable: o adapter não pode alegar `waitpid`; deve demonstrar término do PID e ausência de descendentes/execução por mecanismo suportado antes de concluir.

## RPC e recursos provisórios

Protocolo v1: frames JSON prefixados por comprimento; schemas estritos; versão, tipo, ordem, IDs, campos desconhecidos, duplicatas e tamanho validados antes do dispatch. Mensagens allowlisted: `hello`, `load`, `execute`, `lifecycle`, `broker`, `result`, `cancel`, `fatal`. Canal privado separado de stdout/stderr limitado. IDs, plugin, digest, grants e generation são atribuídos pelo host; respostas antigas, duplicadas ou cruzadas são rejeitadas. Mensagem malformada ou limite excedido invalida e termina a geração.

Tetos iniciais aprovados como política provisória, ainda não provados: artifact 32 MiB; IPC 256 KiB/frame; result 64 KiB; output/stderr 64 KiB/invocação; memória WASM 128 MiB; RSS helper 256 MiB; agregado 1 GiB; Wasmtime fuel 50 M/invocação e 200 M/min/plugin; CPU 25% de um core; handshake 2 s; compile/instantiate/start 5 s; execute/lifecycle 10 s; broker 5 s; 64 hostcalls/invocação, 256/s/plugin e 16 requests pendentes; um helper/plugin, oito simultâneos no app, zero filhos do guest e 64 handles/FDs. Valores só podem ser elevados com evidência de compatibilidade e sem enfraquecer enforcement.

Violação: rejeitar novas broker calls, tentar cancel cooperativo por até 100 ms, encerrar a árvore e confirmar reap em até 2 s. Falha de reap mantém provider em quarantine/Safe Mode e bloqueia reuse. Todos os limites cobrem compile, instantiate, start sections e execute, não apenas a chamada final. Fuel, memória máxima do guest, watchdog, telemetria e `RLIMIT_CPU` acumulado não substituem os limites aprovados de CPU-rate, memória, tempo e processos do helper inteiro.

Imports WASM são somente funções `modus:host` allowlisted de capabilities concedidas e logging limitado. Sem WASI env/filesystem/socket/network/process/stdio imports, sem preopens, threads ou memória compartilhada por padrão. Não expor handles de filesystem, sockets, callbacks ou canal genérico de comandos.

## Adapters e gate de viabilidade

- **Windows:** launcher nativo com token restrito/AppContainer sem capability de rede e handles herdados minimizados; criar suspenso, associar a Job Object com kill-on-close, sem breakaway, limites de processos/memória/CPU e só então retomar. Job Object sozinho não restringe filesystem/rede. Pesquisa oficial encontrou hard CPU-rate e limite de processos, mas memória do Job é committed memory (não RSS) e não há quota pública documentada de quantidade de handles. O `PROC_THREAD_ATTRIBUTE_HANDLE_LIST` limita herança, não handles criados depois. Portanto os tetos estritos de 256 MiB RSS e 64 handles permanecem NO-GO até outro mecanismo suportado ser demonstrado.
- **macOS:** XPC em `Host.app/Contents/XPCServices/<Service>.xpc` continua candidato apenas para isolamento de acesso ambiente; **XPC sozinho está NO-GO no contrato atual**. Pesquisa Apple não documenta CPU-rate, orçamento de CPU por serviço, RSS/VA rígido, processos por serviço ou deadline XPC: `RLIMIT_CPU` é acumulado/sinalizado, `RLIMIT_RSS` é advisory e `RLIMIT_NPROC` é por UID. `NSXPCConnection.invalidate()` não mata o serviço; PID sinalizável não o torna filho waitable. Antes de qualquer probe XPC, identificar mecanismo macOS suportado que aplique cada quota obrigatória antes dos bytes do guest e permita confirmar ausência de execução. Não substituir limites por fuel, memória máxima de guest, watchdog, telemetria ou `RLIMIT_CPU`; não relaxar a política. O serviço pode ser encerrado pelo `launchd` quando ocioso e relançado após crash/conexão; toda conexão nova exige reautorização e geração/estado novos. Sem mecanismo compatível identificado e demonstrado, macOS permanece NO-GO e a tranche não avança ao runner/integração multiplataforma. Ad-hoc signing é somente prova local/CI, não evidência de distribuição.
- **Linux:** namespaces compatíveis, `no_new_privs`, seccomp e Landlock; cgroup v2 para CPU/memória/processos quando realmente disponível. Pesquisa oficial encontrou `cpu.max`, `pids.max`, `cgroup.kill` e `RLIMIT_NOFILE`; `memory.max` é limite hard para memória cobrada pelo cgroup, não uma quota RSS-only. Não tratar como equivalente ao requisito explícito de 256 MiB RSS sem decisão do usuário. Kernel/permissões/delegação ausentes significam NO-GO, sem fallback.

**Autorização de execução atual:** o usuário autorizou somente probes exploratórios de viabilidade em Windows e Linux enquanto macOS permanece NO-GO. Esses resultados parciais não fecham A01–A04, não liberam plugins externos e não autorizam runner nem integração host-side. Os limites aprovados e o critério final Windows/macOS/Linux permanecem inalterados.

O deliverable exploratório é prova de viabilidade, não runner de produção: processo benigno de probe lançado sob cada política, canários controlados para ambiente/arquivo/rede/processo filho, limites e kill/reap. Registrar versões, política aplicada, recursos medidos e resultado real de cada runner. Um SO não prova outro.

## Threat model e provas adversariais

Atacante controla bytes WASM, imports, mensagens, timings, resposta a cancelamento e chamadas a capability; pode tentar exaurir CPU, memória, output e hostcalls, explorar restart/stale replies, acessar recursos ambient e criar descendentes. A fronteira inclui bugs no runner, adapter, protocolo, empacotamento e brokers. Não pressupõe que código WASM, manifesto ou processo filho seja confiável.

Probes: `process.env`/segredos sintéticos e APIs Node/Electron; traversal, symlink/junction e TOCTOU; localhost IPv4/IPv6, metadata, redirect e DNS rebinding; spawn/worker/descendente; loops em start/instantiate/execute; memory bomb e múltiplas memórias; WASM inválido/imports inesperados; amplificação/reentrância hostcall; frames oversized, duplicados, fora de ordem e versão inválida; crash/OOM; resposta stale após restart; saturação concorrente. Cada negação deve provar ausência de side effect, host responsivo, atribuição de identidade no broker e árvore vazia após kill.

## Arquivos existentes e novos

Reutilizar e integrar: `apps/desktop/src/main/agent/harness/capability/capability-registry.ts`, `capability-registration-authority.ts`; `harness/plugin/plugin-loader.ts`, `plugin-lifecycle-service.ts`, `plugin-catalog.ts`, `plugin-state-store.ts`, `dependency-graph.ts`, `plugin-instrumentation.ts`, `permission-brokers.ts`, `safe-mode.ts`, `auto-rollback.ts`, `plugin-recovery.ts`; `apps/desktop/src/main/agent/pi-sdk-runtime.ts`; `apps/desktop/src/main/process/platform-process-ops.ts`; `apps/desktop/electron-builder.config.ts`, `apps/desktop/package.json`, `Cargo.toml`, `.github/workflows/ci.yml`.

Conter como trusted/test-only, sem caminho externo: `harness/plugin/plugin-isolation-host.ts`, `harness/plugin/wasm/wasm-capability-host.ts` e `wasi-sandbox.ts`.

Novos componentes após o gate: `plugin-execution-host.ts`, `plugin-execution-protocol.ts`, `plugin-artifact-authorizer.ts`, `plugin-capability-broker.ts`, `plugin-sandbox-ops.ts` e `crates/plugin-runner/` com executor/protocolo/adapters. Arquivos de probe e helper macOS só são mantidos se forem necessários como regressão durável. Alterar schema de persistência apenas se for indispensável para digest/origem imutáveis.

## Critérios de fechamento

- **A01:** E2E em desktop empacotado por SO mostra que, antes do parsing/instantiate, guest não autorizado não lê ambiente/segredos, filesystem fora do permitido, rede, shell, Git, credentials, Node/Electron; operações concedidas são somente brokers nomeados, escopados e auditados.
- **A02:** compile, instantiate, start e execute estão sujeitos a CPU/memória/tempo/hostcall/output/IPC/process/handle limits efetivos. Loops e Stop terminam e reapam a árvore dentro do limite em cada SO, sem bloquear host nem efeitos depois do cancel.
- **A03:** origem, digest, versão, grants e geração vêm do host; spoof de trust/provider/namespace, artifact adulterado e resposta stale não substituem nem ativam providers protegidos. Provenance registra identidade autenticada pelo host.
- **A04:** revisão de callsites de install/load/restore/enable/hook/execute/upgrade/uninstall e E2E demonstram que cada caminho externo usa o mesmo executor; nenhum hook/execute direto, autoload Pi ou fallback permissivo permanece.

Fechamento exige todos os critérios em Windows, macOS e Linux, em configuração empacotada. Mesmo assim, plugins externos não serão reabertos automaticamente; isso exige decisão posterior. A01–A04 não representam aprovação de release nem encerram outros achados.

## Riscos que permanecem fora desta tranche

A05–A06 para WASM/WASI legado in-process; A07–A09 (filesystem junction/TOCTOU, SSRF/DNS/IP, shell/Git); A10–A14 (restart, atomicidade, concorrência, Safe Mode e dependências); partes gerais de A15; A20–A25 (auditoria durável, wiring, escala, stubs, métricas e escopo de permissions); CVEs/escape de Wasmtime/kernel; cadeia de assinatura/runner; máquinas sem API/privilégios necessários. As sete falhas da suíte ampla Pi permanecem sem atribuição a baseline.

## Adenda — Prova real de enforcement do probe Windows (não produção)

**Autorização:** o usuário aprovou um supervisor Rust para provar quotas Windows em worker descartável. Esta adenda não autoriza runner de produção, integração ao loader, execução de artefatos WASM, reabertura de plugins, alteração de quotas, nem fechamento de A01–A04. Gate externo continua fechado e macOS continua NO-GO. O escopo Linux só poderá avançar depois que todos os oito casos Windows passarem; não presumir equivalência de mecanismos.

### Worker e lançamento

- Usar somente o executável host-owned `plugin-sandbox-probe`, com modos enumerados e fixos. O worker pode fazer loops, alocar, criar handles/descendentes para os casos de teste; não recebe bytes, comandos, caminhos ou argumentos arbitrários de plugins.
- Este worker diagnóstico é código fixo e confiável do host; esta prova limitada não requer nem reivindica AppContainer/restricted-token, negação de filesystem/rede ou contenção de código externo. Nenhum plugin/guest é executado e nenhum resultado desses casos fecha os requisitos de isolamento de produção.
- Um caso = um Job Object novo e um processo worker novo. Criar/configurar o Job e consultar os limites antes de iniciar trabalho; criar o worker suspenso, associá-lo ao Job antes de retomar e verificar membership/effective policy antes de qualquer challenge. Preferir `PROC_THREAD_ATTRIBUTE_JOB_LIST` na criação se disponível no alvo; caso contrário, usar criação suspensa mais `AssignProcessToJobObject` e fazer cleanup bounded se qualquer passo falhar. Nenhum fallback sem Job.
- Usar pipes privados limitados, protocolo v1 com mensagens de enum/schemas estritos, tamanho e ordem limitados. Inherit somente os handles explicitamente enumerados; Job/process/thread handles não são herdados. Ambiente do worker é mínimo. A comunicação/worker não é uma fronteira contra guest arbitrário e o probe não afirma isolamento de filesystem/rede.
- Capture `GetLastError` imediatamente após cada API Win32 falhar. Setup/query de API é pré-condição, nunca prova de enforcement. A prova requer challenge ativo, observação independente do parent, atribuição ao mecanismo, encerramento do worker/descendentes e espera concluída dentro do prazo.

### Resultado estruturado e regra de passagem

Versão de relatório do probe passa a `schema_version: 2`. Registrar exatamente uma entrada para cada cenário fixo: `cpu_loop`, `memory_bomb`, `wall_clock_timeout`, `child_process_tree`, `hard_kill`, `reap_deadline`, `handle_limit`, `process_limit`. Campos por caso: `status` (`passed|failed|not_tested`), razão, limite/unidade/escopo requerido, mecanismo Win32, valores configurado e consultado, estado de enforcement, erros Win32 crus, launch suspenso/membership/ready, challenge, medições do parent/worker, reason do término e exit code, processos ativos antes/depois, waits concluídos, `duration_ms`, `kill_to_reap_ms`, `stop_to_reap_ms`, deadline e confirmação de árvore vazia. Medições não feitas são `null`, não zero. Relatório guarda também OS build/arquitetura, logical processor count, contexto de Job pai observado, identidade/hash do executável e política aplicada.

`status=passed` exige mecanismo e valor efetivos verificados, desafio realmente executado/ativo, evidência parent-observed de enforcement atribuível, processo worker terminado, árvore Job vazia e waits/reap dentro do deadline. Não aceitar claims do worker, configuração API isolada, exit code imposto pelo parent, job inicialmente vazio, falha de alocação sem atribuição, nem amostra baixa por falta de carga como prova. Se cleanup/reap falhar, abortar cenários seguintes, preencher os restantes como `not_tested` e nunca reutilizar processo/Job. `platform_probe_status=passed` somente se todos os oito casos passarem; de outro modo `NO_GO`. O veredito de release continua sempre NO-GO e os invariantes `audit_findings_closed=false` e `plugin_bytes_received=false` permanecem fixos.

### Política e critérios dos oito casos

- **`cpu_loop`:** workload continuamente runnable e single-thread para calibrar consumo. `CpuRate=2500` significa 25% da capacidade total do sistema, não 25% de um core. Sem parent Job CPU cap, derivar `floor(2500/N)` (`N` logical processors) para não exceder 25% de um core; se não houver informação confiável sobre Job pai/denominador, `not_tested`. Consultar Job policy e comparar delta de CPU time do Job com wall time, incluindo controle uncapped que comprove demanda sustentada. Granularidade e medição devem ser registradas; não arredondar para cima nem inferir pelo affinity mask.
- **`memory_bomb`:** requisito continua 256 MiB de RSS. `JOB_OBJECT_LIMIT_JOB_MEMORY/PROCESS_MEMORY` prova commit charge, não RSS; `SetProcessWorkingSetSizeEx(QUOTA_LIMITS_HARDWS_MAX_ENABLE)` permite page-out, pode ser alterado pelo worker e também não prova RSS. Commit/working-set podem constar como evidência suplementar, mas não podem passar o critério RSS. Até surgir enforcement resistente a bypass, o resultado RSS será `failed` ou `not_tested`, mantendo Windows NO-GO.
- **`wall_clock_timeout`:** workload não cooperativo vivo até o limite aprovado de 10 s; parent monotonic deadline dispara kill/cancel. Medir a partir do deadline/stop, com reap de árvore em até 2 s. Não reutilizar o máximo atual de 5 s do worker genérico.
- **`child_process_tree`:** processo fixo cria descendentes vivos sob Job membership; usar e registrar override de teste no active-process count (por exemplo root + filho + neto). Observar os PIDs/membership e matar toda a árvore. Isto prova containment do caminho `CreateProcess` testado; não prova o limite zero-filhos da produção.
- **`hard_kill`:** manter worker/árvore viva e não cooperativa; `TerminateJobObject`, waits do worker e confirmação de zero processos. Exit code passado ao kill não prova o motivo. Kill-on-close só pode ser alegado se houver subteste independente do último handle do Job.
- **`reap_deadline`:** novo worker/árvore, separado do hard_kill; medir stop/violação → kill → espera de cada processo → árvore vazia, com reap ≤2 s.
- **`handle_limit`:** requisito é limite rígido de 64 handles kernel gerais. Whitelist de handles herdados e `GetProcessHandleCount` são controles/telemetria, não quota. Worker mantém handles de tipos benignos e tenta exceder 64; sem mecanismo de enforcement atribuível, resultado é `failed`/`not_tested`, nunca `passed`.
- **`process_limit`:** configurar `JOB_OBJECT_LIMIT_ACTIVE_PROCESS=1`, verificar membership do root e tentar criar filho via `CreateProcess`. Passar somente com recusa/terminação atribuível ao limite, ausência de execução do child, accounting estabilizado e reap do root/Job. Erro de ACL, executável ou Job pai não é evidência do quota.

Deadlines de cada cenário incluem criação/handshake/challenge/cleanup. Cancel cooperativo tem no máximo 100 ms; encerramento forçado e reap até 2 s. Se processo já estiver em Job pai e o limite/denominador efetivo não puder ser determinado, não alegar enforcement. O Job objeto não restringe sozinho filesystem/rede, e este probe mede quotas/process lifecycle apenas.

### Gate Windows → Linux

Implementar e executar as provas Windows primeiro. Se qualquer caso for `failed`/`not_tested`, ou não houver reap confirmado, Windows fica NO-GO e o lane de execução Linux não começa. A pesquisa atual prevê dois bloqueios inevitáveis sem novo mecanismo suportado: RSS rígido e quota geral de 64 handles. Qualquer revisão desses requisitos precisa de aprovação explícita do usuário; não reinterpretar commit ou working-set como RSS. Mesmo se oito casos passarem no futuro, isso não fecha A01–A04 nem abre plugins externos.
