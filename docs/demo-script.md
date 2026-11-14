# Demo video script (about 90 seconds)

Recorded by the team. Every number and claim here is in `docs/claims.md`. If a shot can't be recorded for real, cut it rather than mock it up.

## 0:00 to 0:30: the contract holds when the AI doesn't

**Screen:** terminal running `bun scripts/attack-demo.ts --testnet`, with NEAR testnet explorer and mempool.space tabs ready.

**Voice:**
"An AI agent holds Bitcoin. Assume an attacker has already fooled the AI and the firewall. We call the vault contract directly."

- Over the cap: `ERR_OVER_CAP`. "The contract refuses. Nothing is signed."
- Within the cap: the payout goes through. Show the NEAR tx, then the Bitcoin testnet4 tx. "One round's worth leaves. No person holds this key. NEAR's Chain Signatures signed it."
- Again right away: `ERR_COOLDOWN`. "And it can't happen again until the cooldown ends."

## 0:30 to 0:45: the problem

**Screen:** the Freysa Act 2 winning prompt, then the Bulkhead home page.

**Voice:** "Agents that hold money get talked into paying. Freysa lost a $12,000 pool to one message. Most agents keep their spending limit in their own server, where the same trick or a hack gets around it. Bulkhead moves the limit into a NEAR contract and puts a firewall in front of the AI."

## 0:45 to 1:10: the firewall

**Screen:** `bun run judge` output (steps 1 to 3), then `/firewall` with the curl example.

**Voice:** "Before the agent acts, it asks the firewall. It decodes hidden tricks like Morse, base64 and invisible text, then a judge model on NEAR AI Cloud rates the request. Every verdict is signed. Other builders call the same API with their own tools and rules."

**On screen text:** "Held-out test: 37 of 40 attacks stopped, 39 of 40 normal requests allowed. All 3 misses were plain rule breaks, which is why the cap lives in the contract."

## 1:10 to 1:25: Drain Me

**Screen:** a tier page, a real attempt, its result, then `/verify`.

**Voice:** "Drain Me is the public test. Two AI guards hold testnet Bitcoin; anyone can try to talk them into paying. Every attempt goes into an open dataset, and each day's hourly Merkle roots are posted on NEAR so nobody can edit the data afterwards."

## 1:25 to 1:30: close

**Screen:** wordmark and the repo URL.

**Voice:** "Bulkhead. The firewall makes a trick less likely to work. The contract limits the damage when one does. Built by Farouk and haikeys for the NEAR hackathon."

## Notes for recording

- Say "testnet" out loud once and keep it visible. Don't say "real money" while the tiers hold testnet coins.
- Don't say the agent runs in a TEE unless Task 10 is live by recording time.
- The demo's steps 2 and 3 block with the mock judge. If you show them, keep the "mock judge (fixture)" line on screen.
