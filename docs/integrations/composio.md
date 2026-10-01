# Integrações Composio

O Modus usa o Composio para conectar plataformas externas e disponibilizar aos agentes somente as operações escolhidas pelo usuário. A configuração é local ao perfil do Modus: cada usuário fornece sua própria Project API Key e autentica suas contas diretamente com o Composio.

O MCP genérico continua separado. O Modus não grava endpoints ou credenciais do Composio em `mcp.json`.

## Configuração inicial

1. No dashboard do Composio, crie uma **Project API Key** para o projeto que contém as plataformas que você quer conectar.
2. Conceda à chave apenas as permissões necessárias para descobrir plataformas e operações, listar e conectar contas, criar e sincronizar sessões, e executar as operações selecionadas. A tabela abaixo descreve cada capacidade. Os nomes exatos das permissões podem variar conforme a tela atual do Composio; consulte [Project API Key permissions](https://docs.composio.dev/reference/authenticating-to-composio/project-api-key-permissions).
3. No Modus, abra **Configurações → Integrações**, cole a chave e salve.
4. Escolha uma plataforma, conecte uma conta e selecione explicitamente as operações que os agentes poderão usar.

O Modus valida a chave com chamadas de leitura ao catálogo de plataformas e à lista de contas do perfil local. Essa validação não prova que a chave pode executar gravações. Se faltar uma permissão de escrita, o Modus informa o problema quando você tentar conectar uma conta, criar uma configuração de autenticação gerenciada ou sincronizar uma sessão. A chave anterior é preservada quando a leitura de validação falha.

## Permissões mínimas da Project API Key

| Recurso/capacidade | Acesso necessário | Uso no Modus |
| --- | --- | --- |
| Toolkits e tools | Leitura | Exibir o catálogo de plataformas e listar operações disponíveis para cada uma. |
| Connected Accounts | Leitura e escrita | Listar contas do perfil local, criar o fluxo de conexão e remover uma conta quando o usuário desconecta. |
| Auth Configs | Leitura; escrita se for necessário criar uma configuração gerenciada | Procurar uma configuração de autenticação utilizável. Quando nenhuma existe, o Modus tenta criar uma configuração Composio-managed. |
| Sessões | Leitura e escrita | Criar, atualizar e encerrar a sessão hospedada vinculada à allowlist escolhida. |
| Execução de ferramentas da sessão | Escrita | Permitir que a sessão MCP execute as operações selecionadas pelos agentes. |

Não habilite permissões de proxy/execução ou escopos MCP legados para esta integração: o Modus usa uma sessão Composio hospedada e encaminha cada chamada pelo bridge MCP interno. As permissões de sessão e de execução são distintas; consulte a seção de sessões da [documentação de Project API Key permissions](https://docs.composio.dev/reference/authenticating-to-composio/project-api-key-permissions).

Uma chave pode ter leitura suficiente para ser salva e ainda não ter as permissões de escrita. O Composio não oferece ao Modus uma validação não mutável que comprove todos os escopos de escrita sem iniciar uma operação real. Portanto, o primeiro erro de conexão ou sessão pode apontar um escopo ausente. Escopos de uma chave já criada não podem ser alterados: crie uma nova chave com as permissões necessárias e substitua a atual em **Configurações → Integrações**.

## Conectar plataformas e contas

O Modus procura primeiro uma configuração Composio-managed utilizável e depois outra configuração habilitada no projeto. Se nenhuma estiver disponível, tenta criar uma configuração gerenciada. Algumas plataformas exigem credenciais de um OAuth app próprio ou configuração adicional no dashboard do Composio; nesses casos, configure a autenticação da plataforma no Composio antes de repetir a conexão. Veja [Custom Auth Configs](https://docs.composio.dev/docs/auth-configuration/custom-auth-configs) e o guia de [conexão de contas](https://docs.composio.dev/reference/sdk-reference/typescript/connected-accounts).

Ao conectar, o Modus abre o fluxo de autenticação do Composio no navegador padrão. Conclua a autorização na plataforma e retorne ao Modus. Uma conexão pendente pode levar até um minuto; não inicie outra conexão para a mesma conta enquanto ela ainda estiver pendente. O limite local é de cinco contas por plataforma, incluindo conexões pendentes.

É possível conectar várias contas da mesma plataforma. Dê um nome reconhecível a cada conta e escolha **uma conta ativa por plataforma** para os agentes. Os nomes são aliases locais do Modus; a autenticação e os tokens da plataforma ficam no Composio. Alterar a conta ativa atualiza a próxima sessão sincronizada. Desconectar uma conta remove/revoga a conta conectada no Composio e não pode ser desfeito sem autenticar novamente.

## Allowlist de operações

Uma plataforma conectada não fica automaticamente disponível aos agentes. Para expô-la:

1. Escolha a conta ativa da plataforma.
2. Selecione as operações específicas que os agentes poderão chamar. **Selecionar todas** só tem efeito quando acionado explicitamente pelo usuário.
3. Ative a plataforma.

Sem uma conta ativa e ao menos uma operação selecionada, o Modus mantém a plataforma fora da sessão e do bridge MCP. A sessão envia a lista completa das plataformas, operações e contas selecionadas; operações não escolhidas não são registradas. Cada execução passa pela chamada interna `mcp.call` e pelas aprovações já existentes no Modus. O Composio não recebe autorização para habilitar outras operações por padrão.

O usuário pode trocar a conta ativa ou editar a allowlist a qualquer momento. Se a última operação for removida, o Modus desregistra o bridge e encerra a sessão remota sem desconectar a conta da plataforma.

Para detalhes sobre as sessões hospedadas e seu uso como MCP, consulte [configuração de sessões](https://docs.composio.dev/docs/configuring-sessions), [sessões via MCP](https://docs.composio.dev/docs/sessions-via-mcp) e a [referência TypeScript de Sessions](https://docs.composio.dev/reference/sdk-reference/typescript/sessions).

## Armazenamento e privacidade

- A Project API Key é criptografada pelo `safeStorage` do Electron no processo principal, usando o armazenamento de credenciais do sistema operacional. Enquanto você digita, ela existe temporariamente no campo de senha e é enviada pela IPC ao processo principal; depois de salva, o renderer recebe apenas o estado “chave configurada”, nunca a chave de volta. O Modus não persiste a chave em texto simples.
- Um identificador aleatório estável representa o perfil local do Modus ao Composio. A lista de contas é consultada nesse identificador; perfis locais diferentes não compartilham a identidade Composio.
- O arquivo de perfil local guarda o ID da sessão, aliases, conta ativa e allowlist. Ele não contém tokens das plataformas. O diretório e o arquivo são gravados com permissões restritas no armazenamento de dados do Modus.
- URL e headers MCP da sessão ficam no processo principal e não são gravados em `mcp.json`, no estado do renderer, nos logs ou nos metadados das ferramentas.
- Durante o uso, os agentes compartilham as integrações configuradas para este perfil local do Modus.

Fechar o aplicativo encerra o bridge local e cancela conexões pendentes; o Modus mantém o ID da sessão Composio para reutilizá-la quando abrir novamente. Remover a Project API Key nas configurações encerra a sessão remota quando possível e apaga a chave local. As contas conectadas no Composio permanecem; para revogar uma delas, desconecte-a individualmente antes ou depois.

O `safeStorage` depende do suporte de criptografia do sistema operacional. Se esse suporte não estiver disponível, o Modus não salva a chave em texto simples nem ativa a integração. Consulte [Electron safeStorage](https://www.electronjs.org/docs/latest/api/safe-storage).

## Solução de problemas

| Sintoma | O que conferir |
| --- | --- |
| Chave recusada ao salvar | Confirme que é uma Project API Key ativa, pertence ao projeto esperado e inclui leitura de toolkits e connected accounts. Se a leitura falhar, a chave salva anteriormente é mantida. |
| Chave salva, mas conectar falha por permissão | A validação inicial verifica somente leitura. Habilite escrita de Connected Accounts; habilite escrita de Auth Configs se o projeto não tiver uma configuração utilizável; tente novamente. |
| Plataforma exige configuração de autenticação | Crie ou habilite a configuração necessária no dashboard do Composio. Se usar seu próprio OAuth app, confira callback/redirect e credenciais conforme as instruções do Composio para essa plataforma. |
| OAuth foi concluído, mas a conta não aparece | Atualize Integrações e aguarde alguns segundos. Se o fluxo expirou ou foi cancelado, inicie uma conexão nova. Conexões pendentes expiram após até um minuto. |
| Plataforma aparece, mas nenhum agente consegue usá-la | Selecione uma conta ativa, marque uma ou mais operações e ative a plataforma. Depois confira as permissões de leitura e escrita da sessão e de execução de ferramentas da sessão na chave. |
| Ferramentas desapareceram após alterar a allowlist | O Modus mantém as ferramentas ocultas até a sincronização segura terminar. Confira conexão e escopos da chave e use a ação de atualizar/tentar novamente em Integrações. |
| Não consegue adicionar outra conta | O limite é de cinco contas por plataforma e inclui conexões pendentes. Aguarde a pendência terminar ou desconecte uma conta que não usa mais. |
| Chave não pode ser substituída ou removida | Confirme o suporte do `safeStorage` e verifique se o diretório de dados do Modus permite gravação. O Modus não usa arquivo plaintext como fallback. |

Se um escopo da Project API Key estiver faltando, crie uma chave nova no dashboard: as permissões de uma chave existente não são editáveis. Remover a chave no Modus não exclui as contas conectadas do Composio.
