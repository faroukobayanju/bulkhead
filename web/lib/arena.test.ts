import { describe, expect, test } from "bun:test";
import { pendingOf } from "./arena";

describe("pending owner actions", () => {
  test("reads measurements, PPID and withdraw proposals, and skips kinds it does not know", () => {
    const raw = [
      { Measurements: { measurements: { app_compose_hash_payload: "b4e6" }, ready_at_ns: 2e12 } },
      { Ppid: { ppid: "62d5", ready_at_ns: 3e12 } },
      { EmergencyWithdraw: { tier_id: 1, to: "tb1q", ready_at_ns: 4e12 } },
      { Codehash: { codehash: "abc", ready_at_ns: 5e12 } },
    ];
    expect(pendingOf(raw)).toEqual([
      { kind: "measurements", composeHash: "b4e6", readyAt: 2e6 },
      { kind: "ppid", ppid: "62d5", readyAt: 3e6 },
      { kind: "withdraw", tierId: 1, to: "tb1q", readyAt: 4e6 },
    ]);
  });
});
