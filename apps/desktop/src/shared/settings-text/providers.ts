/** Settings → Model & Provider (list, default model, unofficial-provider notice). */
export const PROVIDERS_TEXT_EN = {
  "settings.providers.title": "Model & Provider",
  "settings.providers.refreshProviders": "Refresh providers",
  "settings.providers.connectCustomProvider": "Connect custom provider",
  "settings.providers.catalogTitle": "Providers",
  "settings.providers.catalogDescription":
    "Connected, available, and custom providers in one place.",
  "settings.providers.countShown_one": "{count} shown",
  "settings.providers.countShown_other": "{count} shown",
  "settings.providers.searchProviders": "Search providers",
  "settings.providers.searchProvidersPlaceholder": "Search providers...",
  "settings.providers.groupConnected": "Connected",
  "settings.providers.groupAvailable": "Available",
  "settings.providers.noProvidersFoundHint": "No providers found",
  "settings.providers.noProvidersFoundDescription":
    "Try another provider name, model count, or source.",
  "settings.providers.backFrom": "Back from {title}",
  "settings.providers.configureProviderNamed": "Configure {name}",
  "settings.providers.configureProvider": "Configure provider",
  "settings.providers.closeProviderConfiguration": "Close provider configuration",
  "settings.providers.providerDetailDescription":
    "Connect provider credentials and choose which models Modus should expose.",
  "settings.providers.providerUnavailableHint": "Provider unavailable",
  "settings.providers.providerUnavailableDescription":
    "The selected provider is not available anymore. Close this panel and choose another provider.",
  "settings.providers.closeConnectionMethodSelection": "Close connection method selection",
  "settings.providers.connectionDialogDescription":
    "Choose how Modus should connect this provider.",
  "settings.providers.connectProviderNamed": "Connect {name}",
  "settings.providers.chooseSignInMethod": "Choose a sign-in method.",
  "settings.providers.cancelProviderSignIn": "Cancel provider sign-in",
  "settings.providers.authDialogDescription":
    "Complete the provider sign-in in the requested browser or device flow.",
  "settings.providers.completeSignIn": "Complete sign-in",
  "settings.providers.waitingForSignIn": "Waiting for sign-in…",
  "settings.providers.verificationCode": "Verification code",
  "settings.providers.copyLink": "Copy link",
  "settings.providers.continue": "Continue",
  "settings.providers.waitingForProvider": "Waiting for provider…",
  "settings.providers.editProviderNamed": "Edit {name}",
  "settings.providers.closeCustomProviderDialog": "Close custom provider dialog",
  "settings.providers.customProviderDescription":
    "Connect an OpenAI, Anthropic or Gemini compatible endpoint and choose the models Modus should expose.",
  "settings.providers.cancelAntigravitySignIn": "Cancel Antigravity sign-in",
  "settings.providers.acknowledgeRiskDescription":
    "Acknowledge the unofficial-endpoints risk before Antigravity OAuth begins.",
  "settings.providers.acknowledgeRiskTitle": "Acknowledge {name} risk",
  "settings.providers.unofficialProviderRequiredBeforeOAuth":
    "Unofficial provider — acknowledgement required before OAuth.",
  "settings.providers.unofficialProviderWarningAria": "Unofficial provider warning",
  "settings.providers.unofficialProvider": "Unofficial provider",
  "settings.providers.unofficialEndpointsNotice":
    "Antigravity reaches Google through unofficial internal Cloud Code Assist endpoints, including undocumented methods that can change without notice.",
  "settings.providers.upstreamWarningNotice":
    "The upstream README warns that use may violate Google’s terms and that Google may warn, restrict, or suspend the linked account. Modus cannot guarantee an outcome or make this integration supported, legal, or safe to use.",
  "settings.providers.antigravityRiskAcknowledgement": "Antigravity risk acknowledgement",
  "settings.providers.antigravityRiskReview":
    "Review what Antigravity does and what it does not promise before starting sign-in.",
  "settings.providers.antigravityEndpointsReverseEngineer":
    "Antigravity reaches Google through unofficial internal Cloud Code Assist endpoints, including undocumented methods that the upstream plugin has to reverse engineer.",
  "settings.providers.upstreamWarningTerms":
    "The upstream README warns that use may violate Google’s terms of service and that Google may warn, restrict, or suspend the linked account. Endpoint behaviour and quotas can change without notice.",
  "settings.providers.modusGuaranteeDisclaimer":
    "Modus cannot guarantee an outcome or make this integration supported, legal, or safe to use.",
  "settings.providers.acknowledgeAntigravityRiskAria": "Acknowledge Antigravity risk",
  "settings.providers.acknowledgeTermsLabel":
    "I understand this is unofficial and may violate Google’s terms.",
  "settings.providers.modusGuaranteeAccountWarning":
    "Modus cannot guarantee that Google will not warn, restrict, or suspend the linked account.",
  "settings.providers.cancel": "Cancel",
  "settings.providers.startAntigravityOAuthAria": "Start Antigravity OAuth with acknowledgement",
  "settings.providers.continueToSignIn": "Continue to sign-in",
  "settings.providers.unofficialEndpointsTooltip":
    "Uses unofficial Google internal endpoints. See the risk notice in Configure.",
  "settings.providers.unofficial": "Unofficial",
  "settings.providers.defaultModel": "Default model",
  "settings.providers.noModelConfigured": "No model configured",
  "settings.providers.chooseModel": "Choose a model",
  "settings.providers.defaultModelDescription": "Every new message runs on this model.",
  "settings.providers.groupEnabled": "Enabled",
  "settings.providers.groupEnabledDescription": "Available in the composer.",
  "settings.providers.groupThinking": "Thinking",
  "settings.providers.groupThinkingDescription": "Supports reasoning controls.",
  "settings.providers.groupStandard": "Standard",
  "settings.providers.groupStandardDescription": "Regular completion models.",
  "settings.providers.modelResultLabel_one": "{count} model shown",
  "settings.providers.modelResultLabel_other": "{count} models shown",
  "settings.providers.invalidNumber": "Invalid number: {value}",
  "settings.providers.protocolOpenAiHint":
    "Chat Completions protocol — OpenAI, most relays, vLLM, Ollama, LM Studio.",
  "settings.providers.protocolOpenAiUrlHint":
    "OpenAI-compatible endpoint, including the version path when required.",
  "settings.providers.protocolBearerKeyHint": "Sent as Authorization: Bearer.",
  "settings.providers.protocolResponsesHint":
    "OpenAI Responses protocol — newer relays and gateways exposing /responses.",
  "settings.providers.protocolResponsesUrlHint":
    "Responses-compatible endpoint, including the version path when required.",
  "settings.providers.protocolAnthropicHint":
    "Messages protocol — Claude relays and coding-plan endpoints.",
  "settings.providers.protocolAnthropicUrlHint":
    "Messages-compatible endpoint; Modus appends /v1/messages.",
  "settings.providers.protocolAnthropicKeyHint":
    "Sent as x-api-key. Enable the bearer header below if your relay expects Authorization.",
  "settings.providers.protocolGeminiHint":
    "Google Generative Language protocol — Gemini-compatible endpoints.",
  "settings.providers.protocolGeminiUrlHint":
    "Gemini-compatible endpoint, including the version path when required.",
  "settings.providers.protocolGeminiKeyHint": "Sent as the Google API key header.",
  "settings.providers.modelApiProviderProtocol": "Provider protocol",
  "settings.providers.modelApiOpenAiChatCompletions": "OpenAI chat completions",
  "settings.providers.modelApiOpenAiResponses": "OpenAI responses",
  "settings.providers.modelApiAnthropicMessages": "Anthropic messages",
  "settings.providers.modelApiGoogleGemini": "Google Gemini",
  "settings.providers.thinkingPresetDefault": "Provider default",
  "settings.providers.thinkingPresetClaude": "Claude effort (low – max)",
  "settings.providers.thinkingPresetOpenAi": "OpenAI effort (low – xhigh)",
  "settings.providers.thinkingPresetCustom": "Custom mapping",
  "settings.providers.thinkingFormatOpenAi": "OpenAI reasoning effort",
  "settings.providers.thinkingFormatOpenRouter": "OpenRouter reasoning",
  "settings.providers.thinkingFormatDeepSeek": "DeepSeek thinking",
  "settings.providers.thinkingFormatTogether": "Together reasoning",
  "settings.providers.thinkingFormatZai": "zAI enable thinking",
  "settings.providers.thinkingFormatQwen": "Qwen enable thinking",
  "settings.providers.thinkingFormatQwenChatTemplate": "Qwen chat template",
  "settings.providers.thinkingFormatStringThinking": "String thinking",
  "settings.providers.modelIdRequired": "Every model needs a model id.",
} as const;

export const PROVIDERS_TEXT_PT: Record<keyof typeof PROVIDERS_TEXT_EN, string> = {
  "settings.providers.title": "Modelo e provedor",
  "settings.providers.refreshProviders": "Atualizar provedores",
  "settings.providers.connectCustomProvider": "Conectar provedor personalizado",
  "settings.providers.catalogTitle": "Provedores",
  "settings.providers.catalogDescription":
    "Provedores conectados, disponíveis e personalizados em um só lugar.",
  "settings.providers.countShown_one": "{count} exibido",
  "settings.providers.countShown_other": "{count} exibidos",
  "settings.providers.searchProviders": "Buscar provedores",
  "settings.providers.searchProvidersPlaceholder": "Buscar provedores...",
  "settings.providers.groupConnected": "Conectados",
  "settings.providers.groupAvailable": "Disponíveis",
  "settings.providers.noProvidersFoundHint": "Nenhum provedor encontrado",
  "settings.providers.noProvidersFoundDescription":
    "Tente outro nome de provedor, quantidade de modelos ou origem.",
  "settings.providers.backFrom": "Voltar de {title}",
  "settings.providers.configureProviderNamed": "Configurar {name}",
  "settings.providers.configureProvider": "Configurar provedor",
  "settings.providers.closeProviderConfiguration": "Fechar configuração do provedor",
  "settings.providers.providerDetailDescription":
    "Conecte as credenciais do provedor e escolha quais modelos o Modus deve disponibilizar.",
  "settings.providers.providerUnavailableHint": "Provedor indisponível",
  "settings.providers.providerUnavailableDescription":
    "O provedor selecionado não está mais disponível. Feche este painel e escolha outro provedor.",
  "settings.providers.closeConnectionMethodSelection": "Fechar seleção de método de conexão",
  "settings.providers.connectionDialogDescription":
    "Escolha como o Modus deve conectar este provedor.",
  "settings.providers.connectProviderNamed": "Conectar {name}",
  "settings.providers.chooseSignInMethod": "Escolha um método de login.",
  "settings.providers.cancelProviderSignIn": "Cancelar login do provedor",
  "settings.providers.authDialogDescription":
    "Conclua o login do provedor no navegador ou fluxo de dispositivo solicitado.",
  "settings.providers.completeSignIn": "Concluir login",
  "settings.providers.waitingForSignIn": "Aguardando login…",
  "settings.providers.verificationCode": "Código de verificação",
  "settings.providers.copyLink": "Copiar link",
  "settings.providers.continue": "Continuar",
  "settings.providers.waitingForProvider": "Aguardando o provedor…",
  "settings.providers.editProviderNamed": "Editar {name}",
  "settings.providers.closeCustomProviderDialog": "Fechar diálogo de provedor personalizado",
  "settings.providers.customProviderDescription":
    "Conecte um endpoint compatível com OpenAI, Anthropic ou Gemini e escolha os modelos que o Modus deve disponibilizar.",
  "settings.providers.cancelAntigravitySignIn": "Cancelar login do Antigravity",
  "settings.providers.acknowledgeRiskDescription":
    "Confirme a ciência dos riscos de endpoints não oficiais antes de iniciar o OAuth do Antigravity.",
  "settings.providers.acknowledgeRiskTitle": "Confirmar ciência dos riscos de {name}",
  "settings.providers.unofficialProviderRequiredBeforeOAuth":
    "Provedor não oficial — confirmação necessária antes do OAuth.",
  "settings.providers.unofficialProviderWarningAria": "Aviso de provedor não oficial",
  "settings.providers.unofficialProvider": "Provedor não oficial",
  "settings.providers.unofficialEndpointsNotice":
    "O Antigravity acessa o Google por endpoints internos não oficiais do Cloud Code Assist, incluindo métodos não documentados que podem mudar sem aviso prévio.",
  "settings.providers.upstreamWarningNotice":
    "O README original alerta que o uso pode violar os termos do Google e que o Google pode alertar, restringir ou suspender a conta vinculada. O Modus não pode garantir resultados nem tornar esta integração suportada, legal ou segura para uso.",
  "settings.providers.antigravityRiskAcknowledgement": "Reconhecimento de riscos do Antigravity",
  "settings.providers.antigravityRiskReview":
    "Revise o que o Antigravity faz e o que ele não promete antes de iniciar o login.",
  "settings.providers.antigravityEndpointsReverseEngineer":
    "O Antigravity acessa o Google por endpoints internos não oficiais do Cloud Code Assist, incluindo métodos não documentados que o plugin original precisa fazer engenharia reversa.",
  "settings.providers.upstreamWarningTerms":
    "O README original alerta que o uso pode violar os termos de serviço do Google e que o Google pode advertir, restringir ou suspender a conta vinculada. O comportamento dos endpoints e as cotas podem mudar sem aviso prévio.",
  "settings.providers.modusGuaranteeDisclaimer":
    "O Modus não pode garantir resultados nem tornar esta integração suportada, legal ou segura para uso.",
  "settings.providers.acknowledgeAntigravityRiskAria":
    "Confirmar ciência dos riscos do Antigravity",
  "settings.providers.acknowledgeTermsLabel":
    "Entendo que isto não é oficial e pode violar os termos do Google.",
  "settings.providers.modusGuaranteeAccountWarning":
    "O Modus não pode garantir que o Google não vai advertir, restringir ou suspender a conta vinculada.",
  "settings.providers.cancel": "Cancelar",
  "settings.providers.startAntigravityOAuthAria": "Iniciar OAuth do Antigravity com confirmação",
  "settings.providers.continueToSignIn": "Continuar para o login",
  "settings.providers.unofficialEndpointsTooltip":
    "Usa endpoints internos não oficiais do Google. Veja o aviso de risco em Configurar.",
  "settings.providers.unofficial": "Não oficial",
  "settings.providers.defaultModel": "Modelo padrão",
  "settings.providers.noModelConfigured": "Nenhum modelo configurado",
  "settings.providers.chooseModel": "Escolha um modelo",
  "settings.providers.defaultModelDescription": "Toda nova mensagem é executada com este modelo.",
  "settings.providers.groupEnabled": "Ativados",
  "settings.providers.groupEnabledDescription": "Disponíveis no campo de mensagem.",
  "settings.providers.groupThinking": "Pensamento",
  "settings.providers.groupThinkingDescription": "Suporta controles de raciocínio.",
  "settings.providers.groupStandard": "Padrão",
  "settings.providers.groupStandardDescription": "Modelos de completion comuns.",
  "settings.providers.modelResultLabel_one": "{count} modelo exibido",
  "settings.providers.modelResultLabel_other": "{count} modelos exibidos",
  "settings.providers.invalidNumber": "Número inválido: {value}",
  "settings.providers.protocolOpenAiHint":
    "Protocolo Chat Completions — OpenAI, maioria dos relays, vLLM, Ollama, LM Studio.",
  "settings.providers.protocolOpenAiUrlHint":
    "Endpoint compatível com OpenAI, incluindo o caminho de versão quando necessário.",
  "settings.providers.protocolBearerKeyHint": "Enviada como Authorization: Bearer.",
  "settings.providers.protocolResponsesHint":
    "Protocolo OpenAI Responses — relays e gateways mais novos que expõem /responses.",
  "settings.providers.protocolResponsesUrlHint":
    "Endpoint compatível com Responses, incluindo o caminho de versão quando necessário.",
  "settings.providers.protocolAnthropicHint":
    "Protocolo Messages — relays do Claude e endpoints de coding-plan.",
  "settings.providers.protocolAnthropicUrlHint":
    "Endpoint compatível com Messages; o Modus anexa /v1/messages.",
  "settings.providers.protocolAnthropicKeyHint":
    "Enviada como x-api-key. Ative o cabeçalho Bearer abaixo se o seu relay exigir Authorization.",
  "settings.providers.protocolGeminiHint":
    "Protocolo Google Generative Language — endpoints compatíveis com Gemini.",
  "settings.providers.protocolGeminiUrlHint":
    "Endpoint compatível com Gemini, incluindo o caminho de versão quando necessário.",
  "settings.providers.protocolGeminiKeyHint": "Enviada como o cabeçalho de chave de API do Google.",
  "settings.providers.modelApiProviderProtocol": "Protocolo do provedor",
  "settings.providers.modelApiOpenAiChatCompletions": "Chat completions da OpenAI",
  "settings.providers.modelApiOpenAiResponses": "Responses da OpenAI",
  "settings.providers.modelApiAnthropicMessages": "Messages da Anthropic",
  "settings.providers.modelApiGoogleGemini": "Google Gemini",
  "settings.providers.thinkingPresetDefault": "Padrão do provedor",
  "settings.providers.thinkingPresetClaude": "Esforço do Claude (low – max)",
  "settings.providers.thinkingPresetOpenAi": "Esforço da OpenAI (low – xhigh)",
  "settings.providers.thinkingPresetCustom": "Mapeamento personalizado",
  "settings.providers.thinkingFormatOpenAi": "Esforço de raciocínio da OpenAI",
  "settings.providers.thinkingFormatOpenRouter": "Raciocínio do OpenRouter",
  "settings.providers.thinkingFormatDeepSeek": "Pensamento do DeepSeek",
  "settings.providers.thinkingFormatTogether": "Raciocínio da Together",
  "settings.providers.thinkingFormatZai": "Ativar pensamento da zAI",
  "settings.providers.thinkingFormatQwen": "Ativar pensamento do Qwen",
  "settings.providers.thinkingFormatQwenChatTemplate": "Template de chat do Qwen",
  "settings.providers.thinkingFormatStringThinking": "Pensamento como string",
  "settings.providers.modelIdRequired": "Todo modelo precisa de um id de modelo.",
};
