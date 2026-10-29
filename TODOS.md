# TODOS

Deferred during the /autoplan review on 2026-10-29. None of these are built during Nov 1–14.

## P2: Intents payout to any chain (Task 14)
- **What:** pay winners on a chain of their choice through the NEAR Intents 1Click API.
- **Why:** the "money moves across chains" story; adds the Intents primitive.
- **Context:** there is no Intents testnet, so it needs mainnet canaries. The reference design is in plan Task 14.
- **Depends on:** a stable mainnet release path (E6).

## P2: Shade Agent firewall middleware package
- **What:** an npm package that wraps a Shade agent's tool calls with `/v1/check`.
- **Why:** turns the firewall into infrastructure other agents adopt (CEO 10x).
- **Depends on:** a stable `/v1/check` contract and signed verdicts (E5).

## P3: Contract-verifiable signed verdicts
- **What:** contracts verify the firewall's ed25519 verdict signature before executing an agent action.
- **Why:** an on-chain firewall that no agent can bypass.

## P3: Multi-turn arena and `approve` attack surface
- **Why:** real attacks are multi-turn; the current claims say "single-turn".

## P3: TTHW instrumentation and a contributing guide (DX scores 4 and 5)

## P3: Fee-funded pots (Freysa model)
- **Blocked by:** legal review of paid entries.

## P3: Visual design system
- **What:** run `/design-consultation` and `/design-shotgun` for mockups. Required before Task 12, as noted in the plan.
