// The module type informs workerd loopback bindings without weakening test types.
declare namespace Cloudflare {
  interface GlobalProps {
    mainModule: typeof import("./index");
  }
}
