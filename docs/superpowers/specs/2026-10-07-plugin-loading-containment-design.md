# Contenção da carga de plugins externos

**Status:** aprovado pelo usuário; plano de implementação preparado para revisão.
**Escopo:** primeira tranche da remediação dos P0 A01–A04 da auditoria pós-Fase 19.

## Objetivo

Impedir que código de plugin não confiável seja descoberto, importado, registrado ou executado no processo principal do Modus enquanto não existir um executor isolado e validado. Esta tranche reduz a exposição imediata; **não** implementa o sandbox e não autoriza extensões hostis.

Decisões aprovadas para o desenho:

- Bloquear temporariamente `community`, `local` e qualquer origem sem confiança emitida pelo host.
- Manter o bloqueio em Windows, macOS e Linux até haver isolamento equivalente e validação adversarial em cada plataforma.
- Futuras extensões de terceiros usarão uma API sem Node, com capabilities explícitas.
- Priorizar isolamento sobre o SLO in-process de `<0,2 ms`.

## Abordagens consideradas

1. **Conter agora e construir o sandbox em tranche separada (escolhida).** Fecha caminhos de carga imediatos sem alegar que workers, WASM cooperativo ou timeouts são isolamento.
2. **Construir primeiro todo o sandbox multiplataforma.** Evita uma mudança intermediária, mas mantém a exposição atual durante uma implementação ampla e de alto risco.
3. **Reforçar apenas workers/timeouts/fuel no processo atual.** Rejeitada: não preempta loops síncronos de forma confiável nem remove autoridade ambiente.

## Desenho

### 1. Loader de extensões do Pi SDK

O `DefaultResourceLoader` da versão fixada `@earendil-works/pi-coding-agent` 0.80.6 deve operar sem descoberta de extensões de projeto/usuário/pacotes. Configurar `noExtensions: true` e, além disso, garantir que a configuração produtiva não forneça `additionalExtensionPaths` nem extensões externas via CLI. `noExtensions` sozinho não basta: a versão 0.80.6 ainda carrega `additionalExtensionPaths`, `cliEnabledExtensions` e `extensionFactories` explicitamente fornecidos.

Manter somente as factories internas explicitamente aprovadas pelo host, hoje incluindo a extensão interna de permissões. Trust de projeto (`resolveProjectTrust`) não substitui esse bloqueio e não é tratado como sandbox. A configuração precisa falhar fechada se uma fonte não autorizada for adicionada.

### 2. Loader e lifecycle de plugins Modus

- Origem/autorização é emitida pelo host; `trustLevel` no manifesto é dado não confiável e nunca concede `core`, `official` ou `verified`.
- Somente os manifests internos enumerados pelo bootstrap host-owned podem passar pelo loader nesta tranche. Não se importam módulos arbitrários para depois rejeitá-los: qualquer fonte dinâmica de terceiros permanece desabilitada antes da resolução/importação.
- As verificações ocorrem em todas as transições: bootstrap/load, instalação, enable, upgrade e `syncOnStartup`/restauração. Estado persistido não eleva confiança e não pode reativar um plugin externo.
- Hooks e providers de fontes não autorizadas não são registrados nem chamados.
- O registry protege o namespace de providers/capabilities essenciais: manifesto não pode obter autoridade por `providerId` igual, `trustLevel` autodeclarado ou substituição de provider `replaceable:false`. Uma substituição só pode ocorrer com autorização host-owned explícita.
- Falhas de autorização mantêm o plugin inativo, registram diagnóstico sem executar código do plugin e não impedem o boot seguro do host.

### 3. Limite explícito

Plugins internos empacotados continuam sendo código confiável do produto e executam no processo atual. A contenção não prova sandbox, quotas obrigatórias, cancelamento de JS/WASM, segurança dos brokers nem isolamento de sistema operacional. **A01–A04 permanecem abertos para fins do gate da auditoria**; esta mitigação não os fecha nem muda o estado **NO-GO** para extensões hostis.

Nenhuma permissão de filesystem, rede ou shell é concedida a terceiros nesta tranche. O orçamento de latência não pode enfraquecer o gate.

## Fluxo e tratamento de falhas

1. O runtime configura explicitamente o resource loader do Pi para carregar apenas as factories aprovadas, sem paths de extensão externos.
2. O bootstrap Modus fornece manifests internos por uma origem host-owned; o loader ignora alegações de confiança do manifesto.
3. Antes de qualquer provider ser registrado ou hook chamado, loader/lifecycle verificam a origem para a operação atual.
4. O registry rejeita registradores sem autoridade host-owned e bloqueia colisões/sobrescritas não autorizadas.
5. No startup, plugins persistidos são revalidados com a política atual; não se restaura confiança apenas porque o estado anterior dizia `enabled`.
6. Qualquer tentativa de origem não autorizada falha fechada, não importa nem executa o módulo e deixa um diagnóstico observável.

## Critérios de aceite e regressões

- Com `cwd` e `agentDir` de fixture contendo extensões sentinela em `.pi/extensions` e `extensions/`, `reload()` não importa nem executa os sentinelas. As factories internas explícitas continuam funcionando.
- A configuração produtiva não passa `additionalExtensionPaths` nem extensões externas via CLI; um teste do wiring falha se uma dessas fontes for introduzida.
- Um manifesto que declare `core`/`official`, um plugin `community`/`local`, uma instalação e uma restauração persistida não podem registrar provider nem executar hooks. Verificar também efeito observável de módulo na fronteira de descoberta/import, não apenas retorno de `PluginLoader.load()`.
- Um provider hostil com o mesmo ID não consegue substituir provider protegido; troca não autorizada de capability `replaceable:false` é negada.
- Os plugins internos do bootstrap e a extensão interna de permissões continuam carregando e funcionando.
- Testes relevantes de loader, registry, lifecycle, runtime e fixture Pi passam no CI de Windows, macOS e Linux. No ambiente local Windows, rodar a suíte focal e typecheck; não declarar paridade multiplataforma com base apenas nessa execução.
- Durante todo o período, as interfaces de instalação/ativação de terceiros permanecem desabilitadas; nenhuma flag reabre execução não confiável.

## Fora de escopo

- Executor hostil em subprocesso/AppContainer/token restrito, Job Object ou sandbox equivalente em macOS/Linux.
- API final de capabilities, IPC validado, quotas agregadas de CPU/memória/hostcalls/IO/output/processos e encerramento de árvore.
- Correções completas de brokers A07–A09, de toda a atomicidade de lifecycle A10–A14, de cancelamento A15 ou dos demais achados P1/P2.
- Reabertura de extensões externas ou alegação de P0=0.

## Validação técnica a preservar

O SDK 0.80.6 documenta que extensões executam com as permissões do processo Pi e não fornece sandbox. `noExtensions` desliga a resolução normal de extensões, mas não `additionalExtensionPaths`, `cliEnabledExtensions` nem `extensionFactories`. Portanto, o teste precisa validar tanto o comportamento do loader em fixtures reais quanto as opções efetivamente passadas pelo runtime; confiança de projeto, uma flag isolada ou teste unitário do loader Modus não são prova suficiente.
