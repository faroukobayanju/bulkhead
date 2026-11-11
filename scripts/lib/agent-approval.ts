// Pure parts of scripts/approve-agent.ts: read a TEE agent's measurements from
// the attestation it sent in register_agent. No network access here.

export type Measurements = {
  rtmrs: { mrtd: string; rtmr0: string; rtmr1: string; rtmr2: string };
  key_provider_event_digest: string;
  app_compose_hash_payload: string;
};

type Attestation = {
  tcb_info: {
    mrtd: string;
    rtmr0: string;
    rtmr1: string;
    rtmr2: string;
    compose_hash: string;
    event_log: { event: string; digest: string }[];
  };
};

/** Phala TDX machines (16-byte PPIDs) as the Shade CLI listed them on 2026-11-11. Its
 * list also had "" and three 64-byte entries, which the contract cannot store. */
export const PHALA_PPIDS = [
  "25d230545a3e572bb25a69240d2319d2", "3235086ca6743dfc60122d9662c6adaf", "330defc989651469feae69a4a2fc2deb",
  "3e306e133b7fdaa7bb79f67634cb520c", "4065414cf7057d456a6ea7e01ec89f3a", "4feaf7607bbb8699de5df347974ba4f5",
  "58813387e6767e03cc2ed191aed34df9", "5ab0c7d7d087758efa30a4b802dcfce2", "62d54040cb9dfc08bb13006fa75ece56",
  "6d29fd8d39de97bd27127c2747d41f79", "75a2e7811a06c71a2430313cf6cd20fc", "789e24484ea860fd2658896b8a535721",
  "789e53db7374a8d22cb8b326aa254f23", "897d3eb76ea887b783f9ad3d0771034b", "a900c5d1de0b847f88ce7f32a69ddb5b",
  "adee94b34274339c33b6f9a43a89ed2c", "d5a036543e001ebe821a231306bece64", "dc1e11aa6a4e37981776d7628eb3c0ed",
  "de3c592b079106991b91654de5387395", "e4ffa50fecdb05482bc4876586f77dd3", "eafec44909bde673eae8ca96caf17c9d",
  "f37d9549776d97f732b306ca10222e35", "fbfc1e852c2c0d462212efe4ce34d8c4",
];

/** The fields the vault compares in register_agent (see contracts/vault, verify_any_measurements). */
export function measurementsFromAttestation(a: Attestation): Measurements {
  const t = a.tcb_info;
  const keyProvider = t.event_log.find((e) => e.event === "key-provider");
  if (!keyProvider) throw new Error("attestation event log has no key-provider event");
  return {
    rtmrs: { mrtd: t.mrtd, rtmr0: t.rtmr0, rtmr1: t.rtmr1, rtmr2: t.rtmr2 },
    key_provider_event_digest: keyProvider.digest,
    app_compose_hash_payload: t.compose_hash,
  };
}

type TxResult = { transaction: { actions: ({ FunctionCall?: { method_name: string; args: string } } | string)[] } };

/** The attestation argument of a register_agent transaction (EXPERIMENTAL_tx_status result). */
export function attestationFromTx(tx: TxResult): Attestation {
  const call = tx.transaction.actions.map((a) => (typeof a === "string" ? undefined : a.FunctionCall)).find(Boolean);
  if (!call || call.method_name !== "register_agent") throw new Error("transaction is not a register_agent call");
  return JSON.parse(Buffer.from(call.args, "base64").toString()).attestation;
}
