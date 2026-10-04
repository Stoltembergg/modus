# Proatividade confiável e ferramentas de Grupo

**Status:** aprovado pelo usuário para planejamento em 2026-10-02
**Data:** 2026-10-02

## Problema

O Group Runtime já persiste tarefas, limita cadeias de execução, controla filas e permite delegação explícita. Ainda assim, a tarefa tem poucos dados para orientar o trabalho e comprovar sua conclusão. `group_agree` pode fechar tarefas sem critérios ou evidência; o handoff com título cria uma tarefa sem atribuí-la ao destinatário; e o fluxo supervisionado e o roteamento dependem parcialmente de regex em texto e nomes de papéis.

O harness adaptativo individual já possui resultados de QA e referências de evidência. Os Grupos ainda não usam essa fonte como gate de conclusão nem expõem uma próxima ação proativa com motivo e origem. Além disso, `docs/natural-groups-n4-proactive.md` descreve retomada após silêncio e revisão automática que o runtime atual não faz; o comportamento atual exige delegação explícita.

## Objetivos

- Tornar tarefa, critérios, dependências, progresso, bloqueios e verificação dados tipados, persistentes e visíveis.
- Ligar a conclusão ao QA e às evidências já produzidas pelo harness, sem copiar transcrições ou saídas brutas.
- Oferecer sugestões proativas por padrão e permitir, por Grupo, automação limitada com opt-in explícito.
- Selecionar agentes por capacidades e disponibilidade estruturadas, mantendo comandos e menções explícitas como prioridade.
- Tornar o fluxo supervisionado independente de regex em texto livre e do idioma do pedido.
- Tornar explícito e auditável o passo de integrar branches, com confirmação do usuário e as proteções Git existentes.
- Corrigir documentação e contratos de ferramentas que divergem do runtime atual.

## Fora do escopo

- Criar outro scheduler, runtime ou loop de polling paralelo ao Group Runtime.
- Disparar trabalho com base em silêncio, mensagens públicas como “Agreed” ou texto livre sem transição tipada.
- Alterar permissões, contornar ToolRegistry ou permitir que o controlador execute ferramentas de escrita.
- Fazer merge, commit de integração ou push automaticamente para a branch de destino.
- Substituir o harness adaptativo, o resolvedor de QA ou os serviços Git existentes.

## Decisões aprovadas

1. **Abordagem:** implementação faseada, começando por tarefa e evidência. O Group Runtime continua responsável por fila, persistência, limites, recuperação e Stop. Uma política pura decide ações a partir de snapshots tipados; o runtime valida e agenda a ação.
2. **Proatividade:** sugestões são o padrão. Automação limitada só é ativada por opt-in em cada Grupo, não amplia permissões e não integra branches automaticamente.
3. **Tarefas:** adicionar critérios, dependências, prioridade, estágio de progresso, motivo de bloqueio, política de verificação e referências de evidência vinculadas aos critérios. O harness existente continua sendo a fonte do resultado de QA.
4. **Ciclo de vida:** incluir `blocked` e aplicar transições explícitas. Tarefas que exigem verificação só concluem com critérios aprovados e revisão aprovada. `group_agree` não contorna esse gate; tarefas sem verificação podem concluir pelo caminho de concordância existente. Cancelamento continua sendo ação do usuário.
5. **Ferramentas e UI:** ampliar criação e consulta de tarefas; adicionar `group_report_progress` e `group_get_work_state`; fazer `group_handoff` criar e atribuir a tarefa na mesma operação; atualizar revisão e concordância para respeitar gates. O painel de tarefas e o IPC mostram estado e transições atuais.
6. **Controlador:** política determinística e pura consome tarefas/dependências, critérios/evidências, estado/capacidade/carga dos membros e orçamento restante da cadeia. Ela retorna no máximo uma ação, com motivo tipado e chave de idempotência. Sugestões são o padrão; opt-in só desperta owner ou reviewer depois de transições tipadas explícitas. Stop, bloqueios, espera pelo usuário, cancelamento, arquivamento, permissões e limites da cadeia prevalecem. Sem evidência, membro disponível ou confiança suficientes, a política sugere e aguarda decisão. Sugestões e wakes apontam para o evento que os originou.
7. **Roteamento:** usar metadados estruturados de capacidades, ferramentas disponíveis, carga e disponibilidade. Comandos e menções explícitos têm prioridade. Sem correspondência confiável, sugerir o Lead e explicar o motivo. O fluxo plan→implement→review→deliver deriva do estado e dos critérios tipados da tarefa, sem classificação por regex em texto livre.
8. **Branches:** após implementação, critérios e revisão aprovados, mostrar branch, commits e resumo do diff. Aplicar à branch de destino requer confirmação explícita. Reusar serviços e permissões Git existentes; detectar conflitos, permitir abortar e registrar resultado. Conflito deixa a tarefa bloqueada para resolução.

## Modelo de tarefa e evidência

Estender `GroupTask` e a persistência SQLite com:

- tipo de tarefa e prioridade;
- critérios de aceitação com IDs estáveis;
- dependências em outras tarefas do mesmo Grupo;
- estágio (`plan`, `implement`, `verify`, `review` ou `deliver`);
- motivo tipado ou textual curto para bloqueio;
- política explícita indicando critérios que exigem verificação e se revisão é obrigatória;
- referências de evidência por critério, apontando para sessão, execução, resultado QA ou revisão e revisão Git pertinente.

As referências identificam dados já mantidos pelo harness e pelo Git. Não duplicam transcrições, raciocínio, logs ou saídas de ferramentas. Uma referência só satisfaz um critério quando o resolvedor do harness confirma resultado aprovado para a revisão pertinente; evidência de uma revisão anterior deixa de satisfazer o gate depois que a implementação muda.

Usar persistência versionada e transacional. Critérios, dependências, evidências e transições devem manter integridade com a tarefa e o Grupo. O registro de transições inclui autor/ator, estado anterior e novo, evento de origem e horário. Chaves de idempotência únicas impedem duplicação de wake ou transição após retry ou recuperação. Nenhuma migração reabre tarefas ou dispara wakes.

Novos estados: `open`, `in_progress`, `blocked`, `in_review`, `done` e `cancelled`. `blocked` volta a `in_progress` quando o bloqueio é resolvido. Pedido de mudanças na revisão retorna para `in_progress`; aprovação só conclui quando os gates da política forem satisfeitos. `cancelled` permanece terminal e só pode ser aplicado pelo usuário. Dependências pendentes impedem o início automático e são mostradas como motivo para sugestão/bloqueio.

Tarefas legadas mantêm estado, conteúdo e comportamento após migração e recebem política de verificação sem requisitos implícitos. Tarefas novas declaram a política de verificação; tarefas com critérios obrigatórios não podem ser fechadas por `group_agree` nem por revisão que não tenha evidência aprovada. `group_agree` continua registrando a decisão do Grupo.

## Ferramentas e transições

- **`group_create_task`:** aceita tipo, critérios, dependências, prioridade, reviewer e política de verificação; valida IDs, pertencimento ao Grupo e ciclos de dependência.
- **`group_list_tasks`:** retorna estado compacto com owner, reviewer, estágio, bloqueio, dependências pendentes e resumo de evidência.
- **`group_report_progress`:** registra avanço tipado, muda estágio e pode bloquear/desbloquear tarefa com motivo; não conclui tarefa ignorando gates.
- **`group_get_work_state`:** leitura compacta do estado do Grupo para decidir próxima ação, incluindo tarefas, critérios pendentes, disponibilidade/carga dos membros, capacidades e orçamento de cadeia.
- **`group_handoff`:** ao receber título de tarefa, cria e atribui ao destinatário atomicamente. Só publica/wakeia o destinatário depois de persistir a atribuição.
- **`group_request_review`, `group_review_task` e `group_agree`:** persistem transições e observações; aprovação e conclusão respeitam política e evidências.

Todas as ferramentas continuam sob ToolRegistry e as permissões existentes. Estados da tarefa são autoritativos no store; mensagens da sala e sugestões são notificações referenciadas, não uma segunda fonte de estado.

## Controlador de proatividade

Criar uma função de política determinística sem efeitos colaterais. Seu snapshot contém estado do Grupo, tarefas e dependências, critérios e referências verificáveis, capacidades e presença dos membros, carga/filas, orçamento restante, estado de Stop e preferência de proatividade. A saída contém zero ou uma ação (`suggest`, `wake_owner` ou `wake_reviewer`), código de motivo, IDs da tarefa e do evento de origem e chave de idempotência.

O adaptador do Group Runtime valida novamente membro, Grupo, estado da tarefa, Stop, limites e permissões antes de enfileirar wake. O modo padrão cria sugestão visível na Atividade, que o usuário pode aceitar, editar ou descartar. O modo opt-in só automatiza wakes decorrentes de eventos tipados, como atribuição, desbloqueio ou pedido de revisão. Não há retomada por silêncio, repetição de texto, polling nem execução direta de ferramentas pelo controlador. A mesma transição, inclusive após reinício, não produz duas ações.

Persistir a preferência `suggest` ou `opt_in_auto` no Grupo, com `suggest` como default para Grupos existentes e novos. Ações e sugestões registram motivo e origem sem persistir conteúdo bruto da conversa.

## Capacidades e fluxo supervisionado

Adicionar metadados estruturados aos perfis/membros: IDs de capacidades e tipos de tarefa suportados. A lista de ferramentas realmente utilizáveis vem do ToolRegistry; presença, fila e carga vêm do runtime. Títulos e descrições continuam informativos, mas não são a fonte de roteamento. IDs de capacidade independem de idioma e capacidades sem declaração explícita não são inferidas.

Menção ou comando explícito do usuário preserva o destinatário pedido, sujeito a disponibilidade e permissões; o runtime explica quando não pode atendê-lo. Caso contrário, o roteador pontua apenas dados estruturados. Se não houver candidato suficiente, cria sugestão endereçada ao Lead com os motivos e dados ausentes.

O fluxo supervisionado é calculado a partir do tipo, critérios, dependências e política de verificação da tarefa: planejamento opcional, implementação pelo owner, QA conforme os critérios, revisão pelo reviewer e entrega. O prompt do Lead apenas resume o plano tipado e as ferramentas válidas. Não classifica o pedido cru por regex nem usa idioma, cargo ou título como substituto de capacidade. Pedidos que ainda não viraram tarefa tipada recebem sugestão para criar uma tarefa adequada.

## Painel e integração de branches

O painel Atividade apresenta status, prioridade, owner/reviewer, estágio, dependências, bloqueio, critérios, estado de verificação e referências navegáveis para QA/revisão. Cada sugestão explica o próximo passo, motivo e evento de origem; ações do usuário deixam claro quando um wake será enviado. O painel recebe atualizações por eventos/IPC tipados e recarrega a partir do store.

Para integração, a UI apresenta branch de origem e destino, commits e resumo de arquivos/diff, depois pede confirmação explícita. A confirmação chama o fluxo Git existente com a permissão `git.write` já aplicada; o controlador nunca o chama. Persistir os estados da integração e SHAs usados na prévia. Se o destino mudou desde a prévia, recalcular e pedir nova confirmação. Se houver conflito, mostrar arquivos, oferecer abortar pelo serviço existente e manter a tarefa `blocked` até a resolução. Não fazer merge commit ou push automaticamente.

## Migração e documentação

A migração preserva as colunas e linhas atuais de `group_tasks`, relacionamentos e timestamps; não modifica mensagens. Tarefas atuais continuam sem gate retroativo, e preferências novas recebem modo `suggest`. Metadados de capacidade ausentes levam a fallback explicável, nunca a permissão presumida.

Atualizar `docs/natural-groups-n4-proactive.md` para remover as alegações antigas de retomada por silêncio e revisão provocada por “Agreed”/“Proposed”; documentar o contrato atual de transições tipadas, sugestão padrão e opt-in limitado. Preservar e ampliar o teste que assegura que silêncio, sozinho, não retoma uma tarefa.

## Critérios de aceitação

1. Migração preserva tarefas legadas e não gera transições/wakes; a nova política de verificação é aplicada apenas às tarefas novas que a declaram.
2. Dependências inválidas ou cíclicas são rejeitadas; dependências não concluídas não iniciam tarefa por automação.
3. Tarefa verificada não chega a `done` sem todos os critérios aprovados na revisão atual e revisão obrigatória aprovada. Tarefa sem política de verificação mantém o caminho de concordância existente.
4. Referências de QA apontam para os registros do harness; logs e transcrições não são duplicados. Mudança de revisão invalida evidência obsoleta.
5. `group_handoff` com título persiste owner antes de acordar o membro; retry não duplica tarefa ou wake.
6. Modo `suggest` não acorda membros automaticamente. Opt-in só acorda owner/reviewer em evento tipado; Stop, membro arquivado/indisponível e orçamento excedido bloqueiam a ação e produzem motivo visível.
7. Roteamento obedece menções explícitas, usa apenas capacidades e disponibilidade estruturadas no restante, tem fallback explicável para Lead e funciona da mesma forma para critérios em qualquer idioma.
8. Fluxo supervisionado não depende de regex em texto livre; estágio, owner, reviewer e gates refletem a tarefa persistida.
9. Integração sempre exibe uma prévia da branch/diff e pede confirmação; usa `git.write`, lida com branch de destino alterada, conflito e abortar, e nunca faz push ou merge commit automático.
10. UI, IPC e ferramentas exibem o mesmo estado persistido; eventos, sugestões e wakes incluem referências de origem e não podem ser duplicados após restart.
11. Stop, limites da cadeia, isolamento por worktree e fluxo de permissão existente continuam efetivos.

## Ordem de implementação aprovada

1. Corrigir a documentação N4 e expandir contrato, persistência e gates de tarefa/evidência.
2. Atualizar ferramentas e transições de tarefas; refletir o estado no painel/IPC.
3. Implementar controlador puro, modo por Grupo, sugestões e wake opt-in com idempotência.
4. Implementar metadados de capacidade, roteamento e fluxo supervisionado tipados.
5. Integrar branches pelo fluxo Git existente, com prévia e aprovação explícita.

## Referências de implementação existentes

- `apps/desktop/src/main/groups/group-runtime.ts` e `group-runtime-lib.ts` — agendamento, limites e composição de prompts.
- `apps/desktop/src/main/groups/group-store.ts` e `apps/desktop/src/main/db/database.ts` — tarefas e SQLite.
- `apps/desktop/src/main/agent/tools/group-tools.ts` — ferramentas de Grupo.
- `apps/desktop/src/shared/contracts-parts/contracts-part-08.ts` e `group-supervised-flow.ts` — contratos atuais.
- `apps/desktop/src/main/agent/harness/qa-evidence.ts` e `meta-controller.ts` — QA e decisões do harness individual.
- `apps/desktop/src/main/git/git-service.ts` — finish/apply/abort para worktrees e detecção de conflito.
- `apps/desktop/src/renderer/src/features/groups/GroupTaskPanel.tsx` — painel de tarefas/Atividade.
