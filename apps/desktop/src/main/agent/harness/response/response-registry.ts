import {
  DEFAULT_RESPONSE_LEVEL,
  type ResponsePolicy,
  resolveResponsePolicy,
} from "./response-policy";

export class ResponsePolicyRegistry {
  private static instance: ResponsePolicyRegistry | null = null;

  // Session-specific policy overrides: sessionId -> Partial<ResponsePolicy>
  private sessionOverrides = new Map<string, Partial<ResponsePolicy>>();

  public static getInstance(): ResponsePolicyRegistry {
    if (!ResponsePolicyRegistry.instance) {
      ResponsePolicyRegistry.instance = new ResponsePolicyRegistry();
    }
    return ResponsePolicyRegistry.instance;
  }

  public static resetInstance(): void {
    if (ResponsePolicyRegistry.instance) {
      ResponsePolicyRegistry.instance.clear();
      ResponsePolicyRegistry.instance = null;
    }
  }

  public setSessionPolicy(sessionId: string, policy: Partial<ResponsePolicy>): void {
    this.sessionOverrides.set(sessionId, policy);
  }

  public getSessionPolicy(sessionId: string): ResponsePolicy {
    const override = this.sessionOverrides.get(sessionId);
    return resolveResponsePolicy(override?.level ?? DEFAULT_RESPONSE_LEVEL, override);
  }

  public clearSessionPolicy(sessionId: string): void {
    this.sessionOverrides.delete(sessionId);
  }

  public clear(): void {
    this.sessionOverrides.clear();
  }
}
