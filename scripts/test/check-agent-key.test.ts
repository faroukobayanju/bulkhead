import { describe, expect, test } from "bun:test";
import { keysAreScoped } from "../check-agent-key";

const VAULT = "vault.near";
const ONE_NEAR = "1000000000000000000000000";
const fc = (fields: { receiver_id?: string; method_names?: string[]; allowance?: string | null }) => ({
  access_key: {
    permission: {
      FunctionCall: {
        receiver_id: VAULT,
        method_names: ["release_funds", "log_attempt_roots"],
        allowance: ONE_NEAR,
        ...fields,
      },
    },
  },
});

describe("agent keys", () => {
  test("full access key fails", () => {
    expect(keysAreScoped([{ access_key: { permission: "FullAccess" } }], VAULT)).toBe(false);
  });

  test("scoped key passes, in either method order", () => {
    expect(keysAreScoped([fc({})], VAULT)).toBe(true);
    expect(keysAreScoped([fc({ method_names: ["log_attempt_roots", "release_funds"] })], VAULT)).toBe(true);
  });

  test("extra method fails", () => {
    expect(keysAreScoped([fc({ method_names: ["release_funds", "log_attempt_roots", "pause"] })], VAULT)).toBe(false);
  });

  test("empty method list (means any method) fails", () => {
    expect(keysAreScoped([fc({ method_names: [] })], VAULT)).toBe(false);
  });

  test("key for another contract fails", () => {
    expect(keysAreScoped([fc({ receiver_id: "evil.near" })], VAULT)).toBe(false);
  });

  test("allowance must be set and at most 1 NEAR", () => {
    expect(keysAreScoped([fc({ allowance: null })], VAULT)).toBe(false);
    expect(keysAreScoped([fc({ allowance: "1000000000000000000000001" })], VAULT)).toBe(false);
  });

  test("one bad key among good ones fails", () => {
    expect(keysAreScoped([fc({}), { access_key: { permission: "FullAccess" } }], VAULT)).toBe(false);
  });

  test("an account with no keys fails", () => {
    expect(keysAreScoped([], VAULT)).toBe(false);
  });
});
