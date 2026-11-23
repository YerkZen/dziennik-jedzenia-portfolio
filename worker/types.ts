import type { SupabaseClient } from "@supabase/supabase-js";
export interface WorkerBindings {
  APP_ORIGIN?: string;
  DEV_ORIGIN_FORWARDING?: string;
  SUPABASE_URL?: string;
  SUPABASE_PUBLISHABLE_KEY?: string;
  AI?: WorkersAiBinding;
  REQUIRE_RATE_LIMITS?: string;
  LOG_REQUESTS?: string;
  LOGIN_RATE_LIMITER?: RateLimitBinding;
  REFRESH_RATE_LIMITER?: RateLimitBinding;
  API_RATE_LIMITER?: RateLimitBinding;
  OCR_RATE_LIMITER?: RateLimitBinding;
}

export interface WorkersAiBinding {
  run(
    model: string,
    input: Record<string, unknown>,
    options?: { signal?: AbortSignal },
  ): Promise<unknown>;
}

export interface WorkerVariables {
  requestId: string;
  requestStartedAt?: number;
  authenticatedSupabase?: { token: string; client: SupabaseClient };
  ownerVerified?: boolean;
}

export type WorkerEnv = {
  Bindings: WorkerBindings;
  Variables: WorkerVariables;
};

export interface RateLimitBinding {
  limit(options: { key: string }): Promise<{ success: boolean }>;
}
