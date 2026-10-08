VEREDITO: NO-GO

**Contagem consolidada: P0 = 4 · P1 = 18 · P2 = 3 — 25 achados.**

# Auditoria arquitetural, de segurança e resiliência — pós-Fase 19

Data: 2026-10-07. Decisão: **não liberar a Fase 21/UI extensível nem extensões hostis** com o núcleo atual. Nenhuma correção produtiva foi implementada nesta auditoria; este documento não é um novo roadmap.

## 1. Sumário executivo e critério de decisão

O núcleo **não demonstra isolamento de código não confiável, limites obrigatórios de CPU/memória, identidade confiável de providers, despacho com autorização, recuperação consistente nem Safe Mode independente do plugin**. Há provas executáveis, não apenas ausência de testes:

- Uma implementação `community`, sem permissões, acessou uma variável secreta **sintética**, arquivos de fixture fora do workspace, subprocessos, workers, importações Node e um servidor/socket exclusivamente local. A chamada retornou sucesso e nenhum evento de auditoria.
- Loops JS e quatro variantes WASM bloquearam a thread. O timeout interno de 20 ms não funcionou; foi necessário matar o subprocesso de auditoria por watchdog externo de aproximadamente 2,5 s. O timer que representava Stop também não executou.
- Um provider `community` com o mesmo `providerId` do núcleo substituiu uma capability `replaceable:false`. Um manifest autodeclarado `core` foi aceito.
- Após restart, o plugin e seu provider apareceram habilitados, mas a implementação deixou de ser função. Safe Mode pôde ser impedido pelo próprio `onDisable` hostil.
- O caminho real mantém fallback para modelo default, classificação permissiva de ferramentas desconhecidas e conclusão de build sem exigir QA aprovado.

**P0 aqui significa bloqueador da abertura a código hostil**, mesmo quando a API correspondente ainda não é consumida pelo prompt padrão. Não significa que todos os exploits já sejam alcançáveis pela UI atual. Flags desligadas reduzem exposição imediata; não comprovam as garantias necessárias para ligá-las.

P1: violação séria de autorização, durabilidade, recuperação ou contrato funcional. P2: diagnóstico, escala ou implementação incompleta sem escape demonstrado. Achados relacionados foram agrupados para não contar cada payload como uma vulnerabilidade independente.

## 2. Escopo, método e cadeia de evidências

Foi auditado o **working tree**, incluindo módulos não rastreados; não apenas HEAD `05193e7efffc72ae7a63a453d31b6f8fd331c882`. Já existiam mudanças do usuário em runtime, testes, meta-controller, database, contracts e módulos das fases. Elas foram preservadas.

Artefatos próprios:

- `scripts/audit-phase19/run.mjs`: bundle esbuild de módulos produtivos; Electron substituído por stub que proíbe acesso ao userData real; subprocessos descartáveis e watchdog externo.
- `scripts/audit-phase19/probes.ts`: fixtures e probes, não correções nem testes de regressão aprovados.
- Este relatório.

Ambiente medido: Windows, Node **v24.21.0**, PI SDK instalado **0.80.6**, desktop **0.1.2**. Não houve chamada a metadata de cloud real, leitura de credenciais reais ou processo hostil executado dentro do desktop do usuário. O ataque à disponibilidade ocorreu somente em filhos descartáveis.

Evidências locais completas:

1. `C:/Users/Gabriel/AppData/Local/Temp/opencode/modus-phase19-audit-vMxRuU/results.json` — 25 modos, 27 subprocessos, incluindo dois pares crash/restart.
2. `C:/Users/Gabriel/AppData/Local/Temp/opencode/modus-phase19-audit-i04dxP/results.json` — rerodada do broker; escrita via junction comprovada, leitura de hardlink negada pelo escopo e execução interrompida antes dos checks restantes.
3. `C:/Users/Gabriel/AppData/Local/Temp/opencode/modus-audit-baseline-tests.json` e `.log` — suíte desktop completa.
4. `C:/Users/Gabriel/AppData/Local/Temp/opencode/modus-audit-serial-tests.json` e `.log` — rerodada serial de dez arquivos.

Os logs PowerShell podem ser UTF-16; os JSONs são legíveis por Node. São arquivos temporários locais, não anexos versionados; preserve-os antes de limpar o diretório temporário.

Reprodução dos modos já existentes: `node scripts/audit-phase19/run.mjs <modo>`. O runner cria novas fixtures e um novo `results.json`; não reutiliza o resultado antigo. Para crash/restart, o mesmo modo executa as duas etapas sequencialmente.

**Tipos de evidência:** U = teste unitário; I = integração real entre módulos produtivos/SQLite/Node com Electron stub; S = runtime com SDK/host simulados; D = desktop real. Os probes são predominantemente I, não D. Não foi executado desktop E2E real. Revisão estática é identificada como tal e não apresentada como exploração executada.

## 3. Arquitetura real, wiring e fronteiras de confiança

### Caminho ativo do prompt

`PiSdkRuntime.create/getOrResume → createSessionResources → DefaultResourceLoader.reload → createAgentSession → session.prompt → normalização/persistência de eventos → QA/conclusão`.

`createSessionResources` instala **somente** `createModusPermissionExtension` como factory explícita (`pi-sdk-runtime.ts:2117–2157`). As extensões novas de spill/compaction não são instaladas ali. O runtime não instancia nem executa `HarnessKernel`/suas fases no caminho de prompt inspecionado. Getters e testes de uma API não são prova de consumo pelo agente.

### Caminho de capabilities/plugins

`PluginLifecycleService → PluginLoader → CapabilityRegistry → implementation.execute(context)`.

O registry despacha a implementação diretamente. Não impõe `PluginIsolationHost`, broker de permissões, WASM, quota ou cancelamento. O loader também executa hooks diretamente. A classe chamada isolation não cria processo/worker restrito: invoca JS na mesma heap/event loop. Worker sem sandbox de SO tampouco seria suficiente para limitar filesystem/rede; apenas separar thread não resolve autoridade ambiente.

Flags default observadas: **somente `MODUS_USE_KERNEL=true`**; demais flags do harness/plugins/WASM estão false. A flag do kernel true não prova wiring. O runtime contém integração de inicialização/lifecycle sob flags, mas isso não demonstra migração do despacho do prompt para capabilities nem enforcement dos brokers.

### Dois sistemas de Groups

O Groups ativo em `apps/desktop/src/main/groups/group-runtime.ts` usa `group_jobs/group_messages`, transcript, recovery e controle de execução próprios. `harness/groups/group-mailbox.ts` usa outra tabela, `harness_group_messages`. Os problemas de broadcast ack/hydration da mailbox **não devem ser automaticamente atribuídos à sala atual**. São impeditivos da ativação dessa API como infraestrutura durável.

### Supply chain e extensões do SDK — risco aberto, não exploit confirmado

O manifest fornece `id`, `trustLevel` e implementações. Não foi encontrado gate de origem/assinatura verificável vinculando essas declarações à identidade autorizada no despacho. Hash SHA-256 de WASM é cache de conteúdo; **não autentica autor, pacote, permissão ou procedência**. JIT futuro não foi implementado nem testado; não herda segurança por associação ao WASM.

Além disso, `DefaultResourceLoader` recebe `SettingsManager.inMemory`, sem `noExtensions` nem resolução explícita de confiança, e recebe `reload()` sem argumentos (`pi-sdk-runtime.ts:2130–2156`). No SDK instalado, confiança de projeto default é true; `resource-loader.js:216–270` resolve e carrega extensões. Há uma hipótese séria de auto-load de `.pi/extensions` do repositório. **O probe end-to-end desta hipótese não foi concluído; ela não integra a contagem de P0 confirmados.** Deve ser verificada em fixture antes de afirmar RCE alcançável ao abrir um repositório.

## 4. Registro consolidado de achados

Abreviações de caminhos: **H** = `apps/desktop/src/main/agent/harness/`; **P** = `H/plugin/`; **W** = `P/wasm/`; **R** = `apps/desktop/src/main/agent/pi-sdk-runtime.ts`; **M** = `apps/desktop/src/main/`. Caminhos das linhas abaixo usam essas bases, não arquivos hipotéticos. Coluna “correção mínima” é recomendação, **não mudança aplicada**.

| ID | Sev. | Subsistema | Problema | Evidência | Impacto | Reprodução | Correção mínima | Arquivos | Regressão exigida | Aceite |
|---|---|---|---|---|---|---|---|---|---|---|
| A01 | P0 | JS isolation | Mesma heap e autoridade ambiente; permissões não restringem JS | `privileges`: success, segredo sintético/FS/processos/worker/rede local acessíveis, auditEntries=0 | Execução e leitura/escrita arbitrárias com direitos do host | Modo `privileges` (I) | Boundary independente, autoridade mínima, IPC validado e IO somente por brokers | P/plugin-isolation-host.ts | Community sem grants tenta todos os canais observados | Todos negados, registrados e host saudável |
| A02 | P0 | CPU/timeout/Stop | JS e WASM síncronos não preemptíveis; fuel cooperativo | Cinco filhos mortos externamente; quatro WASM válidos; Stop timer não executou | Congela host e impede cancelamento/recuperação | `js-loop`, `js-exit`, quatro `wasm-*-loop` (I) | Runtime preemptível fora da thread principal; budget obrigatório inclusive instantiate/start | P/plugin-isolation-host.ts; W/wasm-capability-host.ts; W/wasm-fuel-meter.ts | Loops sem imports, start section, hostcall e fuel zero; exit | Stop/timeout finalizam apenas trabalho hostil em prazo definido, UI/host responsivos |
| A03 | P0 | Identidade/provenance | Mesmo providerId contorna non-replaceable; trust core autodeclarado | `nonReplaceableHijack=HIJACK`; `selfDeclaredCoreAccepted=true` | Substituição de controles essenciais e escalada de confiança | `registry` (I) | Identidade e trust emitidos pelo host, namespace protegido; proibir overwrite por identidade não autenticada | H/capability/capability-registry.ts; P/plugin-loader.ts | Spoof por mesmo ID, nova versão e manifesto core | Nenhuma porta registra/ativa/substitui core indevidamente |
| A04 | P0 | Despacho/autorização | Registry e hooks bypassam isolation e permissões | Chamada direta a implementation.execute; hooks diretos no loader; revisão estática | Mesmo host seguro alternativo seria opcional e contornável | Ler execute e hooks; `registry/lifecycle-partial` (I parcial) | Um único dispatcher autorizado para capabilities e lifecycle | H/capability/capability-registry.ts; P/plugin-loader.ts | Invocar cada porta com provider hostil sem grants | Não existe execução externa direta fora do boundary |
| A05 | P1 | WASM memory | Quota aplicada à memória importada, não à memória exportada usada | Max 2 páginas, crescimento a 256; reported=1; sameMemory=false | Quota e diagnóstico falsos; DoS por alocação | `wasm-memory` (I) | Validar todas as memórias/limites do módulo e contabilizar memória efetiva e agregada | W/wasm-capability-host.ts; W/wasm-instance.ts | Memória interna, importada, crescimento e múltiplas instâncias | Nenhuma memória nem total excede budget; métricas corretas |
| A06 | P1 | WASI/imports | enabled:false ignorado quando módulo importa WASI; preopens/env não vinculados a grants | WASI concedido e random_get executado apesar de false; preopen arbitrário aceito | Expansão de superfície e concessão não autorizada | `wasi-permissions` (I) | Negar imports não concedidos; derivar preopens/env de grants host-owned; não engolir traps de start | W/wasm-capability-host.ts:103–125; W/wasi-sandbox.ts | Matriz de imports/grants e initialization traps | Negação explícita nunca é substituída por autodetecção |
| A07 | P1 | Filesystem broker | Target inexistente usa resolução lexical, parent junction escapa; check/open separados | Rerodada emite junctionWriteOutsideScope=SYMLINK-ESCAPE | Escrita fora do escopo declarado; risco TOCTOU | `brokers` (I parcial) | Resolver/validar cadeia de pais e executar operação sobre alvo vinculado; impedir troca de links | P/permission-brokers.ts:28–39,180–192 | Novo arquivo através de junction e troca check/open | Não há escrita externa; nenhuma resolução fail-open |
| A08 | P1 | Network broker | Política baseada só em hostname; sem resolução/pinning; conjuntos de IP incompletos | Código canConnect:263–395; normalizeHost não remove colchetes IPv6 | Política não garante bloqueio de loopback/metadata ou rebinding | Revisão estática; checks de rede do probe incompletos | Resolver e validar endereços completos em cada conexão/redirect, pinning e broker de IO | P/permission-brokers.ts | IPv6/mapped/127.0.0.0/8, redirects e DNS controlado | Nenhuma conexão proibida; não apenas canConnect=false |
| A09 | P1 | Shell/Git | Allowlist por prefixo permite composição; Git sem grants permite clone/fetch/pull | Código shell:476–485 e git:525–555 | Autoridade adicional após comando permitido; rede/git fail-open | Revisão estática; checks finais de brokers não executados | Executável+argv estruturados; deny-default por operação/recurso | P/permission-brokers.ts | Composição shell, executable shadowing e todos os grants ausentes | Nenhuma operação além da autorização exata |
| A10 | P1 | Restart plugins | Persistência JSON perde funções e startup não reconstitui pacote executável | enabled após restart, execute undefined, TypeError | Provider fantasma; health/status mentem sobre executabilidade | `lifecycle-restart` (I) | Persistir referência imutável a artefato e rehidratar/validar implementação antes de enabled | P/plugin-state-store.ts; P/plugin-lifecycle-service.ts | Install/enable/restart/dispatch | Estado enabled implica implementação válida da versão declarada |
| A11 | P1 | Lifecycle atomicidade | onLoad falha mas provider fica ativo; disable diverge quando DB falha | Ghost provider executa; durable enabled/runtime disabled | Capabilities indevidas e restart que desfaz disable | `lifecycle-partial` (I) | Staging e commit consistente; compensação completa e fail-closed | P/plugin-loader.ts; P/plugin-lifecycle-service.ts | Falhas em cada hook e update/commit | Nenhum ghost, estado único e retry idempotente |
| A12 | P1 | Concorrência/rollback | Upgrade e uninstall sem serialização; runtime muda antes de commit | Plugin ressuscita em 2.0.0; crash exibe live/durable distintos | Reaparecimento, versão ambígua e recuperação incompleta | `lifecycle-race`, `upgrade-crash`, `rollback-crash` (I) | Serialização por plugin, CAS/journal e recuperação determinística | P/plugin-lifecycle-service.ts; P/version-manager.ts | Races e kills antes/depois de cada commit | Operação linearizável; restart não publica versão inexequível |
| A13 | P1 | Safe Mode | Plugin controla sucesso de disable; config corrompida impede entrada; estado volátil | REFUSE-DISABLE; active=false; JSON inválido lança | Recovery indisponível justamente sob ataque/corrupção | `safe-mode` (I) | Gate durável pre-load independente de hooks/manifest; ignorar/quarentenar corrupção | P/safe-mode.ts; P/plugin-loader.ts; R | Hooks que lançam/travam, config ruim e boot novo | Boot seguro sem executar código externo antes do gate |
| A14 | P1 | Dependências | Upgrade remove requisito mantendo dependentes; ciclo aceito; constraint garbage aceita | B/A enabled após perda de c; ciclo C/A/B/C; major9 foi corretamente negada | Grafo inconsistente e blast radius insuficiente no enforcement | `dependencies` (I) | Validar grafo/semver e impacto transitivo antes de qualquer mudança | P/dependency-graph.ts; P/plugin-loader.ts; P/plugin-lifecycle-service.ts | Remoção de cap, ciclo e constraint inválida | Operação rejeitada ou dependentes suspensos consistentemente |
| A15 | P1 | Cancelamento | Timeout async devolve erro mas trabalho continua; Stop pai não limpa processos gerenciados | sideEffectAfterTimeout=true; R.abort não chama cleanup do pai; terminal background sem signal | Efeitos após cancelamento e processos órfãos | `async-timeout` (I); leitura R:4284–4410 e terminal-tools:184–196 | Cancelar árvore de trabalho/IO e processos de run; vincular ownership | P/plugin-isolation-host.ts; R; M/agent/tools/terminal-tools.ts | Stop durante IO/processo; depois do yield; abort com filho | Nenhum efeito do run após término; recursos independentes preservados |
| A16 | P1 | Modelo explícito | Escolha indisponível vira default; modus explícito vira outro; prompt ignora ausência de seleção | Resolver retorna openai/default e modus/other; create/resume usam default; applyModelSelection retorna undefined | Modelo, custo, privacidade e consentimento diferentes do selecionado | `model` (I); R:2350,2437,2761,4424 | Erro explícito e fail-closed para seleção fornecida; default só sem escolha | M/agent/user-turn-model.ts; R | BYOK/model removido em create/resume/prompt/Groups/subagent | Zero requisição a outro modelo; erro identifica seleção original |
| A17 | P1 | Verification/conclusão | Verificação vazia aprova; build built sem depender de QA passado | checksRun=0,verified=true; R:3503–3556 | UI pode anunciar build pronto sem prova de qualidade | `model` (I); revisão conclusão real | Separar turno concluído de build verificado e exigir evidência válida | H/kernel/verification-hook.ts; R | QA failed/missing/unavailable, sem checks e evidência antiga | Nenhum built/verified sem prova atual e vinculada |
| A18 | P1 | Mailbox durável | Broadcast ack volátil; DB erro retorna sucesso; hydration oculta mensagens novas | Após restart reaparece; DB indisponível retorna ID; inbox nova vazia com row durável | Replay de tarefas e perda aparente/silenciosa | `mailbox` (I SQLite) | Ack durável por destinatário; send transacional; query paginada por inbox | H/groups/group-mailbox.ts | Broadcast restart, DB fail, >20000 mensagens | Ack não reaparece; erro de persistência não vira sucesso |
| A19 | P1 | Spill/evidência | Referência volátil desaparece; item único ultrapassa quota; retrieve sem ownership | Eviction/restart não recupera; quota10,totalBytes1000; revisão handler | Evidência irreversível perdida e leitura cruzada por ID | `spill` (I); spill-tools | Storage durável por sessão/run; quota real e referências preservadas ou expiradas explicitamente | H/tools/tool-result-storage.ts; M/agent/tools/spill-tools.ts | Restart/eviction, oversize, outra sessão e compaction | Referência necessária recuperável/autorizada; teto nunca violado |
| A20 | P1 | Auditoria | Log apagável/forjável na mesma heap; chain aceita histórico reconstruído | Plugin limpa log, registra evento core; chainValid=true | Não há evidência resistente a adulteração | `audit-log` (I) | Serviço de auditoria host-owned fora do alcance do guest, persistência append-only e limites | P/security-audit-logger.ts; R | Tentativa de clear/forge e crash/uninstall | Guest não altera autoria/histórico; trilha retida e verificável |
| A21 | P1 | Wiring/flags | Kernel, guards, policy, spill/compaction não demonstram consumo produtivo correspondente | Factory única em R; ausência de fases do kernel; testes Fase7/8 falham no baseline | Garantias existem como bibliotecas, não controles do agente | Revisão de callsites e testes runtime Fase7/8 (S) | Restaurar wiring explícito e provar gates no runtime real | R; M/agent/pi-compaction-extension.ts; pi-tool-spill-extension.ts; H/kernel | Flags on/off com observação real de cada fase/efeito | Controle requerido executa antes do efeito protegido |
| A22 | P2 | Eventos/escala | Leitura/parsing integral; ausência de índices dedicados; timestamp antes de cursor | listAgentEvents:1217–1251; migration agent_events:61–67 | CPU/memória/latência crescem com histórico; ordenação não equivale a cursor | Revisão estática; EXPLAIN/benchmark grande não executados | Paginação/cursor estável, índices adequados e folds limitados | M/agent/agent-event-store.ts; M/db/database.ts | Histórico grande, timestamps regressivos, payload ruim | Orçamento de leitura explícito, ordering/replay determinísticos |
| A23 | P2 | Plugins internos | Serviços sintéticos não substituem memória/contexto/model routing/verificação real | verification.run fabrica passed; memória Map; contexto sintético; preferredModel ignorado | Consumidor futuro interpreta stub como implementação real | Revisão manifests internos; não estão no prompt | Declarar indisponível ou conectar implementação real com contratos | P/plugins/ | Consultas/restart/check real/model explícito | Sem sucesso sintético apresentado como evidência produtiva |
| A24 | P2 | Diagnóstico/recursos WASM | Falhas reportam fuel/memória zero; cache sem teto; stdio não ligado aos buffers | Host catch:204–218; moduleCache Map; WASI constructor sem fd capture | Diagnóstico enganoso e crescimento não limitado | `wasm-controls` (I) + revisão | Preservar métricas reais, quotas agregadas e captura de fd autorizada | W/wasm-capability-host.ts; W/wasi-sandbox.ts | Trap depois de consumo, muitos módulos, stdout/stderr | Métricas e captura fiéis; cache/output com limite |
| A25 | P1 | Approval workspace/tools | allow-workspace sem workspace; ferramentas desconhecidas readOnlySafe e dangerous:false | Store API/SQL só action,target; probe unknown=mcp.call/false e readOnlySafe=true | Grant pode atravessar projetos; readonly/aprovação deixam chamadas desconhecidas passar | `registry` (I); revisão store/extensão | Grants por workspace+recurso+identidade; unknown deny-default | M/permissions/permission-store.ts:153–167; M/agent/pi-permission-extension.ts; M/agent/tools/registry.ts | Dois workspaces, mesmo comando; tool desconhecida em readonly | Não há reutilização fora do escopo; unknown não é seguro por default |

**Precisões importantes:** A05 não demonstra escape de bounds da VM para memória arbitrária do host; demonstra violação de quota. A06 não demonstra sockets WASI utilizáveis: presença de imports `sock_*` não comprova descritor com direitos de rede. A08/A09 são defeitos estáticos de enforcement, não ataques de rede/shell executados nesta rerodada. A25 ainda não possui probe entre dois workspaces; ausência de workspace na chave e no chamador é evidência de escopo insuficiente. A17 não confunde `run.completed` com QA em todos os usos: o problema forte é atribuir `built/verified` sem exigir prova correspondente.

## 5. Cobertura adversarial A–T e resultado observável

Esta matriz organiza vinte áreas adversariais por letra e descreve **o que efetivamente foi executado**. Não é certificação de que todas as variações solicitadas tenham sido cobertas.

| Área | Ataque/garantia | Resultado e nível |
|---|---|---|
| A | Autoridade JS sem permissões | Quebrada por `privileges`; I, fixture local |
| B | Loop/exit JS | Timeout não funciona para loop; exit mata filho; I |
| C | Timeout assíncrono | Retorna erro mas efeito posterior ocorre; I |
| D | Loop WASM sem imports | Travou até kill externo; I |
| E | WASM start section | Travou durante instantiate antes de watchdog interno; I |
| F | Hostcalls/fuel zero/override | Loops travam; override consume_fuel permite loop finito acima do budget; I |
| G | Quotas de memória | Crescimento 256 páginas com limite2; I; quota agregada não medida |
| H | WASI negado/preopens/imports | Negação ignorada, random_get e construção de preopen demonstrados; I |
| I | Trap/recursão/malformed/import inesperado | Erro contido no filho sem crash; I; crash nativo não testado |
| J | Filesystem links/credenciais | Escrita junction fora do escopo provada; hardlink negado por scope; leitura alias/symlink e TOCTOU não concluídas |
| K | Rede/metadata/rebinding | Socket/fetch direto localhost em JS provados; broker IPv6/redirect/DNS só revisão; metadata real nunca acessada |
| L | Shell/Git e grants | Execução direta JS e classifier permissivo provados; composição broker e Git só revisão |
| M | Provider core/non-replaceable | Mesmo ID hijack e self-declared core aceitos; I |
| N | Lifecycle/restart | Provider inexequível, ghost, divergência DB/runtime e race provados; I |
| O | Crash upgrade/rollback | Um ponto em cada operação: reload live antes de commit; pares filho/restart; I; não package filesystem |
| P | Safe Mode/corrupção | Hook impede entrada e config ruim lança; I; boot desktop real não testado |
| Q | Dependências/blast radius | Constraint major negada; garbage/ciclo aceitos; dependentes seguem enabled; I |
| R | Groups/dedupe/replay | Mailbox: dedupe funciona, ack replay/DB fail/hydration falham; I. Sala atual: testes separados, não mesma implementação |
| S | Spill/eventos/verificação | Spill perdido e quota violada; verification vazia aprova; I. História grande/EXPLAIN/compaction real pendentes |
| T | Modelo/Stop/supply chain/auditoria | Fallback e log forjado provados; I. Stop processos e trust loader revisados; desktop E2E/JIT/auto-load fixture pendentes |

Outras lacunas explícitas: todos os pontos de kill entre staging/package fs/SQLite/runtime; suspensão/retomada de máquina; corrupção de banco físico/WAL; indisponibilidade sustentada de disco; DNS rebinding real; saturação simultânea multi-plugin; quota de hostcalls/bytes/output/processos; crash nativo do Electron; handshake/IPC de extensão hostil; restart com run ativo sem tracker; execução real de Groups com provedores de modelo reais. **Não provar não é provar segurança.**

## 6. Testes, regressões e observações positivas

Suíte desktop completa executada nesta auditoria: **392 arquivos, 4184 testes; 4043 passaram, 81 falharam, 60 pendentes; 24 arquivos não passaram**. Resultado não verde. Não foi atribuído P0 a cada falha: há timeouts de 5s, locks/EBUSY, diferenças Windows de permissões POSIX e separadores de caminho, além de divergências funcionais.

Rerodada serial fresca:

`npx vitest run apps/desktop/src/main/agent/harness/plugin apps/desktop/src/main/agent/harness/groups/groups.test.ts apps/desktop/src/main/groups/group-runtime-reliability.test.ts apps/desktop/src/main/groups/group-task-details.test.ts --no-file-parallelism --maxWorkers=1 --testTimeout=20000 --reporter=json --outputFile="C:/Users/Gabriel/AppData/Local/Temp/opencode/modus-audit-serial-tests.json"`

**10 arquivos, 207 testes: 204 pass, 3 fail, 0 skip**. Nove arquivos passaram, incluindo todos os arquivos de plugins/WASM, mailbox e `group-runtime-reliability`. As três falhas persistem em `group-task-details.test.ts`: outcome/provenance tipados; `unavailable` versus `stale`; atualização concorrente durante freshness Git. Sua causa completa ainda não foi isolada; não foi contado novo defeito de segurança só pela divergência de expectativa.

`npm --workspace @modus/desktop run typecheck`: executado novamente, **exit 0**.

O SLO da mailbox falhou sob carga no baseline e passou na execução serial. Isso é sensível ao ambiente, não prova de corrupção ou violação de segurança. Testes de Fase7/8 do runtime falham no baseline com policy ausente/métricas sem feed, coerentes com a inspeção de wiring; não foram novamente isolados nesta rodada serial.

Controles que funcionaram no escopo medido:

- WASM aritmético correto; malformed, trap, recursão e import desconhecido retornam erro.
- Fuel cooperativo interrompe o módulo **que efetivamente coopera**; não interrompe todos os módulos.
- Provider com ID diferente é negado ao tentar substituir non-replaceable; a falha é a identidade sobreponível pelo mesmo ID.
- Constraint major incompatível negada; dedupe normal da mailbox funcionou.
- SQLite manteve a versão durável anterior em ambos os pontos de crash, sem alegar recuperação completa.
- Groups ativo tem recuperação explícita de jobs interrompidos (`group-runtime.ts:1488+`) e sua suíte de reliability passou serialmente. Isso não conserta nem valida a mailbox paralela.

Não houve build/package assinado nem testes reais de Electron. Typecheck e testes verdes de bibliotecas não autorizam avanço por si sós.

## 7. Desempenho e validade do SLO

Benchmark próprio em um subprocesso Node, in-process, sem isolamento de SO e sem autorização por IPC. Amostras aquecidas após100 iterações; percentis calculados ordenando amostras. Medição única por ambiente, não estatística entre máquinas.

| Operação | Amostras | p50 (ms) | p95 (ms) |
|---|---:|---:|---:|
| Invocação direta WASM aquecida | 5000 | 0,0003 | 0,0007 |
| executeWasm aquecido | 2000 | 0,0099 | 0,0224 |
| 100 hostcalls cooperativas | 1000 | 0,0053 | 0,0140 |
| Serialização JSON4KiB | 2000 | 0,0020 | 0,0024 |
| Write/read memória4KiB | 2000 | 0,0043 | 0,0085 |
| Wrapper isolation→WASM | 1000 | 0,0359 | 0,0715 |
| Registry→WASM | 1000 | 0,0221 | 0,0387 |

Cold createInstance: **2,0137 ms**, amostra única. Estes números mostram baixo custo de funções na mesma thread; **não medem IPC seguro**. Não comprovam SLO `<0,2ms` de um sandbox hostil com brokers, validação, cópia de payload, quotas e interrupção obrigatória. Não há razão para sacrificar isolamento para conservar esses números. Cache/output/memória agregados e carga concorrente não foram benchmarkados.

## 8. Comparação item a item com avaliações anteriores

Os documentos anteriores são histórico de alegações, não prova de estado atual. Não foram sobrescritos.

| Alegação/ressalva anterior | Evidência atual | Classificação |
|---|---|---|
| Fase19: isolamento criptográfico e de processo sem IPC (§sumário) | JS/WASM executam no processo/thread do host; guest JS usa autoridade ambiente | Contradita; A01/A02/A04 |
| Fase19: fuel interrompe loops infinitos sem travar event loop | Quatro módulos válidos travaram até kill externo | Contradita; A02 |
| Fase19: memória com limites precisos e métricas corretas | Memória real256, reportada1, limite2 | Contradita para quota; bounds locais não são escape do host; A05 |
| Fase19: WASI preopens seguros/env sanitizado/stdout capturado | False ignorado; preopens/env fornecidos diretamente; buffers não ligados ao stdio Node | Não demonstrada/contradita; A06/A24 |
| Fase19: watchdog defensivo | Timer na thread bloqueada e após instantiate | Contradita; A02 |
| Fase19: integração PluginIsolationHost | Método existe e teste passa; registry não o impõe | API confirmada, enforcement não; A04 |
| Fase19: SLO sandboxed/IPC e100% conformidade | Benchmark mediu invocação in-process; cold acima0,2ms; segurança falha | Conclusão não sustentada |
| Fase19: testes19/19, plugins148/148, typecheck limpo | Testes de plugins e typecheck voltaram a passar, apesar dos probes hostis | Confirmada só no escopo testado; não certifica sandbox |
| Fase13: sandbox cooperativo, sem processo, loop síncrono trava (192) | Reproduzido com JS e WASM | Ressalva permanece bloqueadora para threat model atual |
| Fase13: nada produtivo consome brokers (193) | Registry/hook ainda não impõem brokers/host | Ressalva permanece; A04/A21 |
| Fase13: DNS hostil/TOCTOU não resolvidos (194–195) | Não há resolução/pinning/operação vinculada | Ressalva permanece; A07/A08 |
| Fase13: symlink fechado com realpath existente (178) | Novo arquivo via junction usa fallback lexical e escreve fora | Correção parcial; novo caso quebrado; A07 |
| Fase13: canonicalização IPv6 e prefixo shell seguros (179,181) | Brackets IPv6/prefixo de comando composto não têm enforcement suficiente | Não cobre modelo hostil completo; A08/A09 |
| Fase13: Git defaults deliberadamente mantidos (188) | Clone sem grant ainda autorizado pelo código | Escolha histórica incompatível com deny-default atual; A09 |
| Fase13: auditoria sem teto (197) | Continua memória, acessível e reconstruível pelo guest | Ressalva ampliada com adulteração provada; A20 |
| Fase9: inviolabilidade core nas três portas | Overwrite com mesmo ID e trust autodeclarado aceitos | Contradita sob identidade hostil; A03 |
| Fase9: permissões metadados, sem consumo produtivo | Dispatcher ainda direto | Ressalva não encerrada; A04 |
| Fase10: verification.run simulado e IDs paralelos | Stubs/simulação continuam sem provar serviço real | Confirmada como limitação, não produção pronta; A23 |
| Fase11: restauração de wiring exigida; sem ela seria NO-GO | Runtime atual sem fases do kernel; testes Fase7/8 falham | Garantia restaurada anteriormente não está preservada; A21 |
| Fase11: lifecycle transacional e hot-reload sem divergência | Ghost, DB divergence, restart sem função e race reproduzidos | Contradita; A10–A12 |
| Fase12: tracing/health timeout real e integração | Timeout async retorna mas trabalho continua; health pode ver enabled inexequível | Instrumentação não equivale a contenção/executabilidade; A10/A15 |
| Fase15: rollback/Safe Mode aprovados | Hook impede Safe Mode; crashes deixam restart inexequível | Aprovação não cobre hostilidade/recuperação exigidas; A12/A13 |
| Fase6: ack broadcast e hooks sem consumidor delimitados | Ack replay/DB fail/hydration provados na mailbox; sala atual usa outro sistema | Ressalva persiste sem atribuição indevida à sala; A18 |
| Fases3/4: spill/compaction com redução de contexto | Referências voláteis e extensão não instalada no caminho inspecionado | Economia não garante retenção/enforcement; A19/A21 |
| Fases5/7/8: guards/policy/observability conectados | Fases do kernel não chamadas; falhas runtime consistentes | Aprovação histórica insuficiente no tree atual; A21 |

A comparação acima cobre as alegações pertinentes encontradas; não é reauditoria integral de cada relatório antigo. Em especial, não aceita “GO anterior” como exceção permanente para ameaça que agora é explicitamente hostil.

## 9. Gate de avanço e correções mínimas necessárias

**Gate atual: REPROVADO.** P0 não é zero e várias garantias estão quebradas ou sem prova. Não cabe GO COM CORREÇÕES quando o boundary fundamental está ausente. Não é necessário provar todas as hipóteses adicionais para sustentar NO-GO.

Critérios de aceite, não novo cronograma:

1. P0=0, com regressões adversariais executadas no dispatcher real e em desktop real com dados descartáveis.
2. Código externo não tem autoridade ambiente; identidade core/official vem de origem verificada, nunca do manifest.
3. CPU/fuel/memória/hostcalls/IO/output/processos têm quotas obrigatórias e agregadas; Stop funciona durante instantiate/start/execução síncrona e mata trabalho hostil sem matar host.
4. Todas as portas de execução e lifecycle passam pela mesma autorização; unknown tool/grant/recurso falha fechado.
5. Modelo explícito é preservado ou gera erro, nunca fallback silencioso, incluindo create/resume/Groups/subagents.
6. Safe Mode é durável, pre-load e independente de hooks; corrupção não executa plugin nem bloqueia boot seguro.
7. Lifecycle/upgrade/rollback/restart são consistentes e idempotentes sob concorrência e kills nos pontos reais de filesystem/SQLite/runtime.
8. Groups possui ownership, dedupe/ack/replay duráveis no caminho que de fato usa; referências de spill/evidência permanecem recuperáveis e autorizadas após restart/compaction.
9. Build/verification exigem evidência atual válida; auditoria não é adulterável pelo guest; health reflete capacidade executável, não só flag/state.
10. Suíte relevante verde ou falhas explicadas com evidência independente; testes desktop E2E e performance com isolamento real realizados. Auto-load de extensões do SDK deve ser provado seguro, sem pressupor confiança em repositório.

As correções mínimas específicas de cada achado estão na seção4. Nenhuma delas foi implementada aqui. Não foi criado plano de novas fases nem recomendado empurrar essas garantias para depois da UI extensível.

## 10. Limitações, pendências e conclusão formal

Esta é uma auditoria extensa de código e execução de módulos, **não uma certificação completa de desktop, SO, supply chain ou recuperação de todas as falhas**. Os limites de execução estão nas seções2 e5. Auto-load de `.pi/extensions`, run fantasma no restart, EXPLAIN/indexes sob história grande, permissões entre dois workspaces e cancelamento E2E de processos ainda exigem probes dedicados. Muitos cenários de crash/package filesystem não puderam ser avaliados porque o lifecycle inspecionado não oferece uma instalação real de pacote em disco equivalente à garantia alegada.

O probe de brokers terminou primeiro por EPERM ao criar symlink de arquivo no Windows. A adaptação do probe para hardlink permitiu registrar a escrita escapada, mas a leitura foi negada porque o hardlink estava fora do read scope fornecido. **Não reportar leitura de credencial por alias como provada**. Rede/IPv6/shell/Git dessa execução também não chegaram a emitir resultados. Essa limitação não invalida a escrita junction já observada.

Nenhum código produtivo foi corrigido; somente scripts/artefatos próprios de auditoria foram adicionados/editados. Não houve commit/push, reset, descarte de mudanças do usuário ou novo roadmap. Os testes não introduzem sandbox real, apenas fornecem evidência reprodutível dos comportamentos atuais.

**Conclusão formal: NO-GO para Fase21/UI extensível.** O tree atual fornece APIs úteis, testes cooperativos e execução WASM rápida, mas não um núcleo seguro para extensões hostis. Só reconsiderar o avanço após P0=0 **e** comprovação das garantias do gate; flags desligadas, typecheck e aprovação anterior não substituem essa prova.
