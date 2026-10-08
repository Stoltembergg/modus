import {
  DEFAULT_RESPONSE_LEVEL,
  type ResponsePolicy,
  resolveResponsePolicy,
} from "./response-policy";

export type ResponseMetrics = {
  totalEvaluated: number;
  violationsDetected: number;
  totalFormatted: number;
  charactersSaved: number;
};

export class ResponsePolicyRegistry {
  private static instance: ResponsePolicyRegistry | null = null;

  // Session-specific policy overrides: sessionId -> Partial<ResponsePolicy>
  private sessionOverrides = new Map<string, Partial<ResponsePolicy>>();

  // Aggregated metrics
  private metrics: ResponseMetrics = {
    totalEvaluated: 0,
    violationsDetected: 0,
    totalFormatted: 0,
    charactersSaved: 0,
  };

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

  public setSessionPolicy(
    sessionId: string,
    policy: Partial<ResponsePolicy>,
  ): void {
    this.sessionOverrides.set(sessionId, policy);
  }

  public getSessionPolicy(sessionId: string): ResponsePolicy {
    const override = this.sessionOverrides.get(sessionId);
    return resolveResponsePolicy(override?.level ?? DEFAULT_RESPONSE_LEVEL, override);
  }

  public clearSessionPolicy(sessionId: string): void {
    this.sessionOverrides.delete(sessionId);
  }

  public recordEvaluation(input: {
    violated: boolean;
    formatted: boolean;
    charsBefore: number;
    charsAfter: number;
  }): void {
    this.metrics.totalEvaluated++;
    if (input.violated) {
      this.metrics.violationsDetected++;
    }
    if (input.formatted) {
      this.metrics.totalFormatted++;
      if (input.charsBefore > input.charsAfter) {
        this.metrics.charactersSaved += input.charsBefore - input.charsAfter;
      }
    }
  }

  public getMetrics(): Readonly<ResponseMetrics> {
    return { ...this.metrics };
  }

  public clear(): void {
    this.sessionOverrides.clear();
    this.metrics = {
      totalEvaluated: 0,
      violationsDetected: 0,
      totalFormatted: 0,
      charactersSaved: 0,
    };
  }
}
