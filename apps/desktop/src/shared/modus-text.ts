/**
 * Modus provider copy (B4b): router errors shown in the chat, the model picker
 * states and the session-expired notice, in en / pt / zh. Same convention as
 * `files-search-text.ts` (C6 / C6.2): keys are `area.name`, `{name}`
 * placeholders, the en table defines the key set, pt / zh are type-checked to
 * the same keys and covered by the parity test. No tag means en (C6.2).
 * Error copy must NOT match pi's retryable-error patterns (isRetryableAssistantError):
 * the agent would replay the turn on its own, and the only automatic Modus retry is the
 * single one after a 401 (tested in modus-text.test.ts).
 */
import { type GroupRoomLocale, resolveGroupRoomLocale } from "./group-room-locale";

export const MODUS_TEXT_EN = {
  "modus.sessionExpired": "Your session expired. Please sign in again.",
  "modus.signInRequired": "Sign in to your Modus account to use Modus models.",
  "modus.insufficientCredits":
    "You're out of credits. Add credits or upgrade your plan in Settings › Account.",
  "modus.modelNotInPlan": "This model isn't included in your plan. Upgrade to use it.",
  "modus.modelNotFound": "This model is no longer available.",
  "modus.alreadyProcessed": "This request was already processed.",
  "modus.rateLimited": "You're sending requests too quickly. Wait a moment and try again.",
  "modus.unavailable": "Modus models are temporarily unavailable. Try again shortly.",
  "modus.timeout": "The model took too long to respond. Some credits may have been used.",
  "modus.upstreamError": "The model couldn't complete this response. Try again.",
  "modus.network": "Couldn't reach Modus. Check your connection and try again.",
  "modus.requestTooLarge": "This request is too large for Modus models.",
  "modus.badRequest": "Modus couldn't process this request.",
  "modus.cancelled": "The request was cancelled.",
  "modus.picker.unavailable": "Modus is unavailable right now.",
  "modus.picker.upgrade": "Upgrade",
  "modus.picker.upgradeLabel": "Upgrade your plan to use {model}",
} as const;

export type ModusTextKey = keyof typeof MODUS_TEXT_EN;

export const MODUS_TEXT_PT: Record<ModusTextKey, string> = {
  "modus.sessionExpired": "Sua sessão expirou, entre de novo.",
  "modus.signInRequired": "Entre na sua conta Modus para usar os modelos Modus.",
  "modus.insufficientCredits":
    "Seus créditos acabaram. Adicione créditos ou faça upgrade do plano em Configurações › Conta.",
  "modus.modelNotInPlan": "Este modelo não está incluído no seu plano. Faça upgrade para usá-lo.",
  "modus.modelNotFound": "Este modelo não está mais disponível.",
  "modus.alreadyProcessed": "Esta solicitação já foi processada.",
  "modus.rateLimited":
    "Você está enviando solicitações rápido demais. Aguarde um pouco e tente de novo.",
  "modus.unavailable": "Os modelos Modus estão indisponíveis no momento. Tente de novo em breve.",
  "modus.timeout": "O modelo demorou demais para responder. Alguns créditos podem ter sido usados.",
  "modus.upstreamError": "O modelo não conseguiu concluir esta resposta. Tente de novo.",
  "modus.network": "Não foi possível conectar ao Modus. Verifique sua conexão e tente de novo.",
  "modus.requestTooLarge": "Esta solicitação é grande demais para os modelos Modus.",
  "modus.badRequest": "O Modus não conseguiu processar esta solicitação.",
  "modus.cancelled": "A solicitação foi cancelada.",
  "modus.picker.unavailable": "Modus indisponível no momento.",
  "modus.picker.upgrade": "Fazer upgrade",
  "modus.picker.upgradeLabel": "Faça upgrade do plano para usar {model}",
};

export const MODUS_TEXT_ZH: Record<ModusTextKey, string> = {
  "modus.sessionExpired": "你的登录已过期，请重新登录。",
  "modus.signInRequired": "登录你的 Modus 账号以使用 Modus 模型。",
  "modus.insufficientCredits": "你的额度已用完。请在“设置 › 账号”中添加额度或升级套餐。",
  "modus.modelNotInPlan": "你的套餐不包含此模型。升级后即可使用。",
  "modus.modelNotFound": "此模型已不可用。",
  "modus.alreadyProcessed": "此请求已处理。",
  "modus.rateLimited": "发送过于频繁。请稍候再试。",
  "modus.unavailable": "Modus 模型暂时不可用。请稍后再试。",
  "modus.timeout": "模型响应超时。可能已消耗部分额度。",
  "modus.upstreamError": "模型未能完成此回复。请重试。",
  "modus.network": "无法连接 Modus。请检查网络后重试。",
  "modus.requestTooLarge": "此请求对 Modus 模型来说过大。",
  "modus.badRequest": "Modus 无法处理此请求。",
  "modus.cancelled": "请求已取消。",
  "modus.picker.unavailable": "Modus 暂时不可用。",
  "modus.picker.upgrade": "升级",
  "modus.picker.upgradeLabel": "升级套餐以使用 {model}",
};

export const MODUS_TEXT: Record<GroupRoomLocale, Record<ModusTextKey, string>> = {
  en: MODUS_TEXT_EN,
  pt: MODUS_TEXT_PT,
  zh: MODUS_TEXT_ZH,
};

/** Modus copy for `key`; pt* → pt, zh* → zh, anything else (or no tag) → en. */
export function modusText(
  key: ModusTextKey,
  locale?: string | null,
  vars?: Readonly<Record<string, string | number>>,
): string {
  const template = MODUS_TEXT[resolveGroupRoomLocale(locale)][key];
  if (!vars) return template;
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    name in vars ? String(vars[name]) : match,
  );
}
