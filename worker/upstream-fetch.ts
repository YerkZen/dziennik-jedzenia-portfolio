/** Suppress raw SDK network exceptions: return a generic transient response instead. */
export const safeUpstreamFetch: typeof fetch = async (input, init) => {
  const existing = init?.signal ?? (input instanceof Request ? input.signal : undefined);
  const timeout = AbortSignal.timeout(5000);
  try {
    return await fetch(input, {
      ...init,
      signal: existing ? AbortSignal.any([existing, timeout]) : timeout,
    });
  } catch {
    return Response.json(
      { message: "Upstream service unavailable" },
      { status: 503, headers: { "Cache-Control": "no-store" } },
    );
  }
};
