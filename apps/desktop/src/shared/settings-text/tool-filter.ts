/** Settings → General → Local tool filter (RERANK-03). */
export const TOOL_FILTER_TEXT_EN = {
  "settings.toolFilter.title": "Local tool filter",
  "settings.toolFilter.desc":
    "Sends only the tools a request likely needs, computed on this device.",
  "settings.toolFilter.unavailableIntelMac":
    "Not available on Intel Macs: the on-device model runtime has no Intel build.",
  "settings.toolFilter.unavailableVcRuntimeMissing":
    "Needs the Microsoft Visual C++ Redistributable (2015–2022). Install it, then restart Modus.",
  "settings.toolFilter.unavailableRuntimeLoadFailed":
    "The on-device model runtime could not start on this computer.",
  "settings.toolFilter.unavailableUnsupportedPlatform": "Not available on this platform.",
  "settings.toolFilter.downloadProgress": "{received} of {total} MB ({percent}%)",
  "settings.toolFilter.cancelDownloadButton": "Cancel download",
  "settings.toolFilter.verifying": "Verifying files…",
  "settings.toolFilter.failedHashMismatch":
    "The downloaded files did not pass verification and were removed.",
  "settings.toolFilter.failedDownloadFailed":
    "Download failed. It will retry automatically; check your connection.",
  "settings.toolFilter.retryButton": "Retry now",
  "settings.toolFilter.modelStarting": "Starting the on-device model…",
  "settings.toolFilter.modelReady": "On. Requests send only the relevant tools.",
  "settings.toolFilter.modelFailed":
    "The on-device model stopped; requests send all tools until it restarts.",
  "settings.toolFilter.modelStopped": "On. The model starts with the next request.",
} as const;

export const TOOL_FILTER_TEXT_PT: Record<keyof typeof TOOL_FILTER_TEXT_EN, string> = {
  "settings.toolFilter.title": "Filtro local de ferramentas",
  "settings.toolFilter.desc":
    "Envia só as ferramentas de que cada solicitação provavelmente precisa, escolhidas neste dispositivo.",
  "settings.toolFilter.unavailableIntelMac":
    "Indisponível em Macs com Intel: o ambiente de execução do modelo local não possui versão para Intel.",
  "settings.toolFilter.unavailableVcRuntimeMissing":
    "Requer o Microsoft Visual C++ Redistributable (2015–2022). Instale-o e reinicie o Modus.",
  "settings.toolFilter.unavailableRuntimeLoadFailed":
    "O ambiente de execução do modelo local não pôde ser iniciado neste computador.",
  "settings.toolFilter.unavailableUnsupportedPlatform": "Não disponível nesta plataforma.",
  "settings.toolFilter.downloadProgress": "{received} de {total} MB ({percent}%)",
  "settings.toolFilter.cancelDownloadButton": "Cancelar download",
  "settings.toolFilter.verifying": "Verificando arquivos…",
  "settings.toolFilter.failedHashMismatch":
    "Os arquivos baixados não passaram na verificação e foram removidos.",
  "settings.toolFilter.failedDownloadFailed":
    "Falha no download. Haverá nova tentativa automática; verifique sua conexão.",
  "settings.toolFilter.retryButton": "Tentar novamente",
  "settings.toolFilter.modelStarting": "Iniciando o modelo no dispositivo…",
  "settings.toolFilter.modelReady":
    "Ativado. As solicitações enviam apenas as ferramentas relevantes.",
  "settings.toolFilter.modelFailed":
    "O modelo no dispositivo parou; as solicitações enviarão todas as ferramentas até ele reiniciar.",
  "settings.toolFilter.modelStopped": "Ativado. O modelo será iniciado na próxima solicitação.",
};
