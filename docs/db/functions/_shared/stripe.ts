import Stripe from "npm:stripe@23.0.0";

/**
 * The slice of the Stripe SDK the Functions use (kept narrow so tests can use
 * fakes for API calls and the real SDK for webhook signatures). No API version
 * is pinned: the account default applies (Checkout Studio parameters, plan).
 */
export interface StripeApi {
  customers: {
    create(
      params: { email?: string; metadata: Record<string, string> },
      options: { idempotencyKey: string },
    ): Promise<{ id: string; livemode: boolean }>;
  };
  checkout: {
    sessions: {
      create(
        params: Stripe.Checkout.SessionCreateParams,
      ): Promise<{ id: string; url: string | null; livemode: boolean }>;
    };
  };
  billingPortal: {
    sessions: {
      create(params: {
        customer: string;
        return_url: string;
      }): Promise<{ url: string; livemode: boolean }>;
    };
  };
  subscriptions: {
    retrieve(id: string): Promise<{ id: string; object: string; livemode: boolean }>;
  };
  invoices: {
    retrieve(id: string): Promise<{ id?: string; object: string; livemode: boolean }>;
  };
  webhooks: {
    constructEventAsync(
      payload: string,
      header: string,
      secret: string,
      tolerance?: number,
      cryptoProvider?: Stripe.CryptoProvider,
    ): Promise<Stripe.Event>;
  };
}

export function createStripeClient(secretKey: string): Stripe {
  return new Stripe(secretKey, { httpClient: Stripe.createFetchHttpClient() });
}

export const subtleCryptoProvider: Stripe.CryptoProvider = Stripe.createSubtleCryptoProvider();
