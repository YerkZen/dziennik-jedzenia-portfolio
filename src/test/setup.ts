import "@testing-library/jest-dom/vitest";

// Docker's local HTTP gateway can retain unusable keep-alive connections.
// Keep real requests and the application's deadlines, using fresh connections
// in the Node test runner. Browser and production fetch are unchanged.
const realFetch = globalThis.fetch;
globalThis.fetch = (input, init) => {
  const headers = new Headers(
    init?.headers ?? (input instanceof Request ? input.headers : undefined),
  );
  headers.set("Connection", "close");
  return realFetch(input, { ...init, headers });
};

if (typeof window !== "undefined")
  Object.defineProperty(window, "scrollTo", {
    writable: true,
    value: () => {},
  });

if (typeof window !== "undefined")
  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => {},
    }),
  });
