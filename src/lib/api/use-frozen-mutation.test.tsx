import { act, renderHook } from "@testing-library/react";
import { afterEach, expect, it, vi } from "vitest";
import { clearPrivateDrafts, hasPrivateDrafts } from "@/lib/auth/private-drafts";
import { ApiRequestError } from "./client";
import { useFrozenMutation } from "./use-frozen-mutation";
vi.mock("@/lib/auth/context", () => ({
  useAuth: () => ({ snapshot: { session: { owner_id: "owner-fixture" } } }),
}));
const ack = {
  resource_id: "fixture",
  current_revision: 2,
  applied_revision: 2,
  replayed: true,
  deleted: false,
};
afterEach(() => clearPrivateDrafts());
it("retains the original command across remount and releases it only after acknowledgement", async () => {
  const first = renderHook(() => useFrozenMutation<{ quantity: string }>("fixture"));
  const lost = vi.fn().mockRejectedValue(new ApiRequestError("unconfirmed", 0, "NETWORK_ERROR"));
  await act(async () => {
    await expect(first.result.current.run({ quantity: "150" }, lost)).rejects.toThrow(
      "unconfirmed",
    );
  });
  expect(first.result.current.frozen).toBe(true);
  first.unmount();
  const second = renderHook(() => useFrozenMutation<{ quantity: string }>("fixture"));
  const send = vi.fn().mockResolvedValue(ack);
  await act(async () => {
    await second.result.current.run({ quantity: "200" }, send);
  });
  expect(send.mock.calls[0]).toEqual(lost.mock.calls[0]);
  expect(hasPrivateDrafts()).toBe(false);
  await act(async () => {
    await second.result.current.run({ quantity: "200" }, send);
  });
  expect(send.mock.calls[1]![0]).toEqual({ quantity: "200" });
  expect(send.mock.calls[1]![1]).not.toBe(send.mock.calls[0]![1]);
});
it("settles a definitive conflict and clears pending RAM commands on logout", async () => {
  const hook = renderHook(() => useFrozenMutation<{ quantity: string }>("fixture"));
  await act(async () => {
    await expect(
      hook.result.current.run({ quantity: "150" }, async () => {
        throw new ApiRequestError("conflict", 409, "REVISION_CONFLICT");
      }),
    ).rejects.toThrow("conflict");
  });
  expect(hasPrivateDrafts()).toBe(false);
  await act(async () => {
    await expect(
      hook.result.current.run({ quantity: "150" }, async () => {
        throw new ApiRequestError("unconfirmed", 0, "NETWORK_ERROR");
      }),
    ).rejects.toThrow("unconfirmed");
  });
  clearPrivateDrafts();
  hook.rerender();
  expect(hook.result.current.frozen).toBe(false);
});
