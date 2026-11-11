import { describe, expect, test } from "bun:test";
import { attestationFromTx, measurementsFromAttestation, PHALA_PPIDS } from "../lib/agent-approval";

// The attestation the S3 agent sent from a Phala CVM (dstack 0.5.12).
const S3 = await Bun.file(new URL("../../contracts/vault/tests/fixtures/s3-attestation.json", import.meta.url)).json();

const S3_MEASUREMENTS = {
  rtmrs: {
    mrtd: "7fe60787222bd394cb516abca2435f22f035ab2cc9c0a4b4b3b148e46297f3d931a237b72f359052c6e657d8c1409173",
    rtmr0: "68102e7b524af310f7b7d426ce75481e36c40f5d513a9009c046e9d37e31551f0134d954b496a3357fd61d03f07ffe96",
    rtmr1: "4ae609807c765916a31d724786ed74bcb97e168a9d937b04936aeef2015c907eba5ac352c6bcd749c246fd62ffb659ec",
    rtmr2: "764489f277a8540189761e72b4238ba36d4d647e11bd958d8ab5522af2a4867b0ff63e06b0c4967f1857236244040a5d",
  },
  key_provider_event_digest: "1de9cfa982eab350c1c6719fed6f35f9be554d202c26d354e498b0b9e6ad2e6e1e02df3abfa85bd8113c9ea219c16deb",
  app_compose_hash_payload: "b4e628a4eb5c3fb110c32b15efa4769e7fd58e74665ad2120841233b02a0620f",
};

// What EXPERIMENTAL_tx_status returns for a register_agent call, trimmed.
const txResult = (attestation: unknown, method = "register_agent") => ({
  transaction: {
    actions: [{ FunctionCall: { method_name: method, args: Buffer.from(JSON.stringify({ attestation })).toString("base64") } }],
  },
});

describe("agent approval", () => {
  test("measurements match what the vault approved for the S3 agent", () => {
    expect(measurementsFromAttestation(S3)).toEqual(S3_MEASUREMENTS);
  });

  test("the attestation is read back from a register_agent transaction", () => {
    expect(attestationFromTx(txResult(S3))).toEqual(S3);
  });

  test("a transaction that is not register_agent is refused", () => {
    expect(() => attestationFromTx(txResult(S3, "release_funds"))).toThrow("register_agent");
  });

  test("an event log without a key-provider event is refused", () => {
    const noKp = { ...S3, tcb_info: { ...S3.tcb_info, event_log: S3.tcb_info.event_log.filter((e: { event: string }) => e.event !== "key-provider") } };
    expect(() => measurementsFromAttestation(noKp)).toThrow("key-provider");
  });

  test("Phala PPID list: 16-byte hex only, and includes the S3 machine", () => {
    expect(PHALA_PPIDS.length).toBe(23);
    expect(PHALA_PPIDS.every((p) => /^[0-9a-f]{32}$/.test(p))).toBe(true);
    expect(PHALA_PPIDS).toContain("62d54040cb9dfc08bb13006fa75ece56");
  });
});
