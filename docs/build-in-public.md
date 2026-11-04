# Build in public

Drafts for X, one per finished task. Nothing here has been posted.

## Intro (attach `assets/brand/social-1200x630.png`)

My friend and I are building Bulkhead for #NEARHackathon: a firewall and spending cap for AI agents that hold money.

A limit in an agent's own server can be talked around or hacked. On NEAR, a contract holds the signing rights, so the cap still holds, and anyone can check it.

### Reply 0: why NEAR needs it

NEAR lets agents sign on Bitcoin, Base and more. So one tricked agent can lose real money on any of those chains, and its NEAR key limits gas, not funds.

### Reply 1: how we prove it

To prove it works, we're launching Drain Me: AI guards holding real BTC and USDC. Anyone can try to talk them into paying.

1. Prompt only
2. Hardened prompt
3. Hardened prompt plus our firewall

On all three, a NEAR contract limits what leaves per round, even if the AI says yes.

### Reply 2: for other builders

Other agent builders will be able to use the firewall too: one API call before an action, with their own tools and rules. It returns allow, escalate or block, signed.

The firewall lowers the odds of a trick working. The contract limits the damage when one does.

### Reply 3: where it stands

Runs on NEAR AI Cloud, Chain Signatures and Shade Agents. Attacks go into an open dataset.

Built and reviewed so far: attack decoder, wallet sign-in, firewall. Still in progress: contract, game pipeline, API, website.

Not live yet. Submitting by Nov 14.

## Task 5: input normalizer

First piece of Bulkhead: decoding what attackers hide from an AI agent. Base64, hex, morse, rot13, invisible Unicode.

Favorite bug so far: "please decode 72 65 6c..." got through because the "de" in "decode" is valid hex, and that one extra byte broke the decode.

#NEARHackathon

## Task 6: sign-in and rate limits

Drain Me sign-in is done: NEAR wallet signature, single-use nonce, 5-minute expiry, one attempt per tier every 10 minutes.

Review warned MyNearWallet may sign a callback URL we weren't hashing. All tests passed anyway. Fixed it. Real wallet test still to come. #NEARHackathon

## Task 7: firewall

### Option A: the live run

The firewall passed 487 tests, all with a fake model. First run on the real one: 3 of 10 harmless messages took over 3.5s, hit our timeout, and would have been blocked.

Turning off model reasoning cut the median from 3.7s to 1.5s. Still needs a bigger eval. #NEARHackathon

### Option B: the parser bug

Code review on our firewall: an attacker could write {"risk":0} into their message. If the judge model repeated it before its real answer, our parser took the first JSON and scored the attack as safe.

Now any reply that isn't one clean JSON object gets blocked. #NEARHackathon

## Task 8: game pipeline

Built the game engine for Drain Me. My favorite rule: if we can't tell whether the contract signed a payout, we treat it as signed. Marking it "failed" by mistake could open the door to a second payout.

Every payout is also written down before any money moves. #NEARHackathon

## Progress update, 2026-11-04 (attach `assets/brand/update-2026-11-04.png`)

Bulkhead update for #NEARHackathon: our NEAR contract signed a real Bitcoin testnet payment, and no person holds that key.

Then we gave it a fake amount to sign. Bitcoin refused the transaction. So the spending cap holds even if the AI lies about the numbers.

### Reply: proof and what's next

The payment, on Bitcoin testnet4: https://mempool.space/testnet4/tx/a8ecea7c06b387f86349322cf025233c3f170e69a2a31f27e274e70ae89e8b1a

Also built: the firewall, wallet sign-in and the game engine. Next: the payout server, the website and the TEE deploy. Still testnet only, submitting Nov 14.
