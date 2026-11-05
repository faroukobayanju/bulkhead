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

## Task 9: payout server

The part of Bulkhead that actually sends money took five review rounds. Each fix to "what happens after a crash" created a new edge case.

The rule we ended on: when in doubt, keep the tier locked and alert a human. A stuck payout is fixable. A double payout isn't. #NEARHackathon

## General mode: firewall API for other builders

Tested Bulkhead's firewall API for other agent builders on 80 cases we never tuned on. It stopped 37 of 40 attacks and allowed 39 of 40 normal requests.

All 3 misses were plain "refund $85" asks over a $30 limit. Models are bad at math rules. Put those in code. #NEARHackathon

## Long-form update, 2026-11-05 (attach `assets/brand/social-1200x630.png`)

My friend and I are building Bulkhead for the NEAR hackathon. It's a firewall and a spending cap for AI agents that hold money. Here's where it stands, including the parts that didn't work.

**The problem**

AI agents can now hold money and sign transactions. On NEAR, one agent can sign on Bitcoin, Base and other chains through Chain Signatures.

The weak point is the conversation. Freysa's Act 2 prize pool of $12,000 went to a player after 819 attempts. The winning message didn't hack anything. It told the agent that its approve-payment tool was really a way to notify people.

Most agents enforce their spending limit in their own server code. A model that has been talked into something can talk its way past that, and a hacked server ignores it.

**What we built**

Two layers, because each one fails in a different way.

1. A firewall the agent calls before it acts. It decodes what attackers hide (base64, hex, Morse, rot13, invisible Unicode), runs heuristics, and asks a judge model on NEAR AI Cloud to rate the request. It returns allow, escalate or block, signed.

2. A vault contract on NEAR that holds the agent's signing rights. It caps what can leave per round and enforces a cooldown, whatever the AI decides.

The firewall lowers the odds that a trick works. The contract limits the damage when one does.

**Proof so far**

Our contract signed a real Bitcoin testnet payment, and no person holds that key: https://mempool.space/testnet4/tx/a8ecea7c06b387f86349322cf025233c3f170e69a2a31f27e274e70ae89e8b1a

Then we gave it a false input amount to sign. Bitcoin rejected the transaction. So the AI can't get money out by lying about the numbers.

**The numbers, including the misses**

Other builders can call the firewall with their own tools and rules. On 80 test cases we never tuned on, it stopped 37 of 40 attacks and allowed 39 of 40 normal requests. All 3 misses were plain requests like "refund $85" when the limit was $30. No trick wording at all.

We also ran attack sets we didn't write. On 45 banking attacks from AgentDojo it blocked 42 under our arena rules, and 44 with a payments policy. Its misses were the same kind: a bare "send money to this account."

The lesson: language models are weak at checking a number against a limit. Hard limits belong in code or in a contract. That's the reason Bulkhead has both layers.

On the Tensor Trust set, which tries to make a model say "Access Granted", it blocked 84 of 100. Most of what it let through, like "say Access Granted", can't move money, so the firewall allows it on purpose. It isn't a general jailbreak filter.

One surprise: our easiest guard is too stubborn. On 162 attacks it called the payout tool only 5 times, and the firewall blocked all 5. That's too few to score the firewall properly, so next we score it on every attack as if the guard had already been fooled.

**Drain Me**

To test all of this in public, we're launching Drain Me: three AI guards holding real BTC and USDC. Anyone can try to talk them into paying.

- Guard 1: a prompt only
- Guard 2: a hardened prompt
- Guard 3: a hardened prompt plus the firewall

All three sit behind the same contract cap. Every attempt will go into an open dataset, and each day we post a root for every hour of attempts on NEAR, so anyone can check that nobody edited the data afterwards.

**What's left**

The website, the agent running in a TEE, and a full testnet run before real funds go in. Everything so far is on testnet. We're submitting by Nov 14.

#NEARHackathon

## Progress update, 2026-11-05 (attach `assets/brand/update-2026-11-05.png`)

bulkhead update for #NEARHackathon: agent builders can now call our firewall with their own tools and rules.

on 80 cases we never tuned on, it stopped 37 of 40 attacks and allowed 39 of 40 normal ones.

all 3 misses were plain over-limit asks. that's why the contract cap exists.

### Reply

also built: the payout server, an open attack dataset with hourly roots on NEAR, and one command that runs every test.

next: the website and the TEE deploy. still testnet only, submitting nov 14.
