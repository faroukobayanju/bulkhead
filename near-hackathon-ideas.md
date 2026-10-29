# NEAR HACKATHON — Build Ideas by Track

Source data: 11,259 past hackathon projects (Colosseum: Breakout, Cypherpunk, Frontier, Radar, Renaissance, Crypto World's Fair). Mostly Solana. Used to find what is overbuilt (judges have seen it 100 times) and what is empty.

## 1. What the 11k projects tell us

Keyword hits across all descriptions:

| Theme | Projects | Verdict |
| --- | --- | --- |
| Games (generic) | 1,128 | Saturated. Only win on the loop. |
| Vaults / yield | 925 | Saturated. |
| RWA / tokenization | 842 | Saturated. |
| x402 / pay-per-call / agent pays API | 305 | Saturated. "Agent pays for an API" alone is now lame. |
| Prediction markets | 366 | Saturated. |
| Memecoins (mostly launchpads, "pump" clones) | 302 | Saturated launchpads; mechanics almost empty. |
| Scam detection | 248 | Saturated. |
| AI trading agents | 212 | Saturated. |
| Agent spending-limit wallets / policy engines | 92 | Crowded. REIN, x402guard, AgentVault, OnLeash, KIXA, Limitra, Enclz... all the same pitch. |
| Swarms (mostly "trading swarm votes on tokens") | 77 | Shallow. Real coordination markets are rare. |
| ROSCA / savings circles | ~20 | Overbuilt for its size. Avoid for Social Money. |
| Autonomous business (real, end to end) | ~10 | Empty. Most "AI-run business" entries are trading bots. |
| Data markets / compute-to-data | 17 | Empty. |
| Private AI (TEE inference with sensitive data) | 11 | Empty. |
| NPCs with wallets / agent economies in games | 12 | Empty. |
| NFT-as-account (NFT that owns money) | 4 | Empty. |

Takeaways:

1. The "AI agent + wallet + limits" pitch is now the default. Judges will see 50 of them. You only win by showing something an agent does **that was impossible before**, not by adding a guardrail.
2. Almost nothing in the bank uses what is unique to NEAR: **Chain Signatures** (a NEAR account controls native BTC/ETH/SOL addresses), **NEAR Intents** (cross-chain settlement by solvers), **NEAR AI Cloud TEEs** (private inference with attestation), **named / sub-accounts** and **function-call keys** (revocable scoped keys built into the account model). Every idea below leans on at least one of these. A Solana clone ported to NEAR will lose.
3. The judges: Illia (AI + intents + chain abstraction), Mert (real usage, devex), Eddy and Haseeb (mechanism design, sharp thinking), Kain (DeFi, perps), Avichal and Stepan (investors: is this a company?). Plus Claude Code and Codex reading your repo. Aim for: one clear mechanism, a live demo that moves real value across chains, and a README with "do X, see Y" steps.

Scoring used below: **Wow** (judge reaction, 1-5), **Feasibility in 2 weeks solo/small team** (1-5).

---

## 01 · Unstoppable DeFi (`defi`)

### 1. Naked BTC Lending — borrow stablecoins against native Bitcoin, no wrapping
- **What:** User deposits real BTC to a Bitcoin address that a NEAR contract controls through Chain Signatures. The contract lends USDC (any chain, via Intents). If price drops, the contract itself signs the BTC liquidation transaction and sells it through Intents.
- **Pain:** Using BTC in DeFi means trusting a wrapper (WBTC, cbBTC) or a custodian. Billions of BTC sit idle because of that trust.
- **Why needed:** It is the most-wanted product in crypto that only chain-signature chains can build cleanly.
- **Why not needed:** Babylon, threshold-BTC and others attack the same problem. Liquidation timing on Bitcoin (10-minute blocks) is a real risk you must explain.
- **Ecosystem fit:** Perfect. Chain Signatures + Intents are NEAR's core story.
- **Wow 5 · Feasible 3.** Use BTC testnet. Demo: deposit tBTC, borrow, crash the oracle price, watch the contract sign a BTC tx by itself.

### 2. Dark Intents — a TEE dark pool for large cross-chain orders
- **What:** Big orders (whales, DAOs, treasuries) are submitted encrypted into a NEAR AI Cloud TEE. The enclave matches them against each other privately; only the net remainder goes to public NEAR Intents solvers. Attestation proves the matcher ran the published code.
- **Pain:** Large cross-chain orders leak intent and get front-run or quoted wide.
- **Why needed:** Every TradFi market has dark pools; crypto cross-chain has none.
- **Why not needed:** Needs order flow to matter. In a demo you simulate both sides.
- **Ecosystem fit:** Intents + TEE together. Very Illia, very Kain.
- **Wow 4 · Feasible 3.**

### 3. Proof-of-Strategy Vaults — a cross-chain vault whose strategy is attested, not trusted
- **What:** Strategy code runs in a TEE; its hash is published. The agent holds positions on NEAR, Solana and Ethereum via Chain Signatures and rebalances through Intents. Depositors verify the attestation before depositing, and the vault refuses to sign anything the strategy did not produce.
- **Pain:** "AI vaults" ask you to trust a black box or a dev with keys.
- **Why needed:** Verifiability is the missing piece of 925 vault projects.
- **Why not needed:** Vaults are saturated; judges may skim. Your angle must be visible in the first 10 seconds of the demo (show the attestation check failing for tampered code).
- **Wow 3 · Feasible 4.**

---

## 02 · Investment Thesis (`thesis`)

Judged on evidence. Everything must be reproducible: public notebook or script, raw queries, a live dashboard.

### 1. Intents Flow Atlas — "NEAR is becoming the settlement layer for cross-chain"
- **What:** Index every NEAR Intents settlement: volume by chain pair, solver concentration (HHI), fee capture, repeat users, growth rate. Model what share of cross-chain volume NEAR clears and what that implies for NEAR fee demand.
- **Pain:** Nobody has a clean public view of Intents flows. Investors guess.
- **Why needed:** It is the core of NEAR's 2026 thesis and judges (a16z, Dragonfly, Electric) want numbers.
- **Why not needed:** If data is thin, the thesis can look weak. Be honest; a "bear case" section scores points.
- **Wow 4 · Feasible 4.**

### 2. Agent GDP — what share of NEAR activity is AI agents?
- **What:** Build a classifier over NEAR accounts (function-call key patterns, tx timing regularity, TEE-attested accounts, known agent frameworks, sub-account trees). Publish a time series of "agent share of transactions and value". Thesis: NEAR is the agent chain.
- **Pain:** "AI chain" is a claim every L1 makes. Nobody measures it.
- **Why needed:** First real metric for a narrative the whole market is trading.
- **Why not needed:** Classifier accuracy is debatable; show your labeled sample and error rate.
- **Wow 5 · Feasible 3.** Original — no project in the bank does this.

### 3. The Invisible TVL — assets NEAR controls on other chains
- **What:** Derive and track addresses on BTC/ETH/SOL controlled by NEAR Chain Signatures (MPC). Sum the value. Standard TVL dashboards miss all of it.
- **Pain:** NEAR's chain-abstraction value is invisible to DefiLlama-style metrics, so it is mispriced.
- **Why needed:** Reframes how NEAR should be valued.
- **Why not needed:** Address discovery may be partial; scope it to known integrations.
- **Wow 4 · Feasible 3.** Combine 1 + 3 into one submission if you want a stronger thesis.

---

## 03 · Privacy & Private AI (`privacy`)

Private AI appears in only 11 of 11k projects. Wide open.

### 1. Prove-It Credit — undercollateralized loans without doxxing
- **What:** User feeds bank statements / exchange API / payroll PDF into a NEAR AI Cloud TEE. The model extracts income and liabilities and outputs only a signed claim ("income > $4k/month, 12 months stable"). A NEAR lending contract checks the attestation and offers a credit line in stablecoins.
- **Pain:** DeFi only does overcollateralized lending because it cannot see your real finances without exposing them.
- **Why needed:** Unlocks the largest missing market in DeFi (credit) with privacy intact.
- **Why not needed:** Default enforcement is still off-chain; say it plainly. Fake documents are a risk (mention a path to zkTLS later).
- **Wow 5 · Feasible 4.**

### 2. Blind Data Market — sell answers from your data, never the data
- **What:** Data owners (a clinic, a shop's sales data, a trader's history) upload to a TEE. Buyer agents pay per query through NEAR; the enclave runs the query or model and returns only the aggregate answer. Owner earns, data never leaves.
- **Pain:** Valuable private data stays unused because selling it means losing it.
- **Why needed:** AI agents need data and will pay for it; this is how they buy without leaks.
- **Why not needed:** Query-based leakage (many queries reconstruct data) is a known attack; add a privacy budget per buyer.
- **Wow 4 · Feasible 4.**

### 3. Sealed Alpha — copy-trade a strategy you can never see
- **What:** A trader's strategy runs inside a TEE. Followers subscribe and their accounts mirror trades through Intents, but the logic is never revealed. Trader earns a fee; attestation proves the same code runs for everyone and the trader cannot front-run followers.
- **Pain:** Good traders never share strategies because copying kills the edge.
- **Why needed:** Creates a market for alpha that does not exist today.
- **Why not needed:** Copy-trading is common; the TEE angle must be front and center.
- **Wow 4 · Feasible 3.**

---

## 04 · Autonomous Business (`business`)

Fewer than 10 real end-to-end AI businesses in the bank. Most are trading bots with a business label.

### 1. Ghost Company — a business that must pay for its own brain
- **What:** Deploy an agent company with a charter contract (human-set constraints: max spend, allowed suppliers, profit split). It sells one real digital service (example: on-demand onchain reports for any wallet, paid in any token via Intents), pays its own NEAR AI Cloud inference and hosting, and distributes surplus to shareholder token holders. Live P&L on-chain. If revenue < costs, it shuts itself down.
- **Pain:** "AI-run business" is a slogan with no working example.
- **Why needed:** First honest demo of an AI with real revenue, real costs and real survival pressure.
- **Why not needed:** Revenue in a hackathon is tiny. That is fine; the mechanism is the point.
- **Wow 5 · Feasible 4.** Strong grand-prize candidate.

### 2. Autonomous Accounts Payable — AP department in a box for an SMB
- **What:** Agent reads invoices from an inbox, matches them to POs, checks vendor history, pays vendors in whatever chain and token they want via Intents, within policy. Anything unusual (new bank details, amount spike) is held for human approval.
- **Pain:** SMBs pay bookkeepers to do this by hand, and invoice fraud (changed payee details) costs billions.
- **Why needed:** Real business, real money, normal company could use it.
- **Why not needed:** Overlaps Real-World Money; pick one primary track.
- **Wow 3 · Feasible 4.**

### 3. Runway Autopilot — a Trezu treasury that runs itself inside human limits
- **What:** Agent manages a startup or DAO treasury: keeps N months of runway in stablecoins, puts the rest in yield on Rhea, pays recurring bills cross-chain. Anything over its limit becomes a Trezu multisig proposal with a plain-English reason for humans to approve.
- **Pain:** Small teams mismanage treasury (idle cash, missed payments, panic sells).
- **Why needed:** Uses the ecosystem partner (Trezu) the way the organizers asked.
- **Why not needed:** Less flashy; needs a slick dashboard to land.
- **Wow 3 · Feasible 4.**

---

## 05 · AI Swarms (`swarms`)

Bank swarms are mostly "five agents vote on a memecoin". Real markets between agents are rare.

### 1. Agent Buying Club — collective purchasing between strangers' agents
- **What:** Personal agents for many users each want the same thing (GPU hours, API credits, flight seats, bulk stablecoin swaps). They discover each other, pool demand in a NEAR sub-account escrow, negotiate a bulk price with a seller agent, then settle and split via Intents.
- **Pain:** Individuals pay retail; only institutions get volume discounts.
- **Why needed:** It is the exact "collective purchasing" the track names, and almost nobody built it.
- **Why not needed:** Needs a convincing seller side; simulate a compute provider with a real price curve.
- **Wow 4 · Feasible 4.**

### 2. The Contractor Swarm — a client brief in, a paid team of agents out
- **What:** A client posts a job with a budget ("build a landing page", "write a market report"). A lead agent splits it into tasks and auctions them; specialist agents (each a sub-account: `research.swarm.near`, `writer.swarm.near`) bid, deliver, get reviewed by a reviewer agent, and get paid. Live graph shows money flowing between agents.
- **Pain:** Multi-agent frameworks coordinate work but no money moves, so there is no price signal for quality.
- **Why needed:** Shows an emergent economy, not a script.
- **Why not needed:** Can look like a CrewAI demo with a wallet. The auction + reputation + payment must be the visible core.
- **Wow 5 · Feasible 3.** Great demo video material.

### 3. Oracle Swarm — agents stake on the truth to resolve markets
- **What:** Questions come in (from prediction markets, insurance claims, bounties). Agents bid to research, stake NEAR on their answer, and are paid or slashed by consensus plus later evidence.
- **Pain:** Oracles for subjective / real-world questions are slow (UMA disputes) or centralized.
- **Why needed:** Every prediction market (366 in the bank) needs a resolver.
- **Why not needed:** Collusion between agents is the obvious attack; you need a story for it.
- **Wow 4 · Feasible 3.**

---

## 06 · AI Security & Defense (`security`)

Warning: 92 agent spend-limit wallets in the bank. Do not build another plain one.

### 1. Drain Me — a live prompt-injection arena that makes agents safer
- **What:** Deploy several agents that each hold real funds and a different defense. Anyone can pay a small fee to try to talk them into sending money. Fees grow the pot. Every successful attack is logged into an open dataset and used to train a public "injection firewall" that other NEAR agents can call.
- **Pain:** Nobody knows how robust agent wallets really are; defenses are untested claims.
- **Why needed:** Turns red-teaming into a market and produces a public good.
- **Why not needed:** Freysa did the game version in 2024. Your difference is the firewall product and the dataset; make that clear.
- **Wow 5 · Feasible 4.** Viral on X, which helps the demo post.

### 2. Intent Firewall — a TEE co-signer that simulates before it signs
- **What:** The agent never holds a full key. It proposes a transaction or intent; a co-signer in a TEE simulates it, computes the exact balance changes across chains, checks a plain-English policy ("never send more than 10% of treasury to a new address"), and only then signs via Chain Signatures. Attestation proves the check ran.
- **Pain:** Spend limits check amounts, not effects. A malicious approval or swap route passes limits and drains you anyway.
- **Why needed:** Effect-based checking is the step after spend limits.
- **Why not needed:** Overlaps with existing policy engines; lead with the simulation demo.
- **Wow 4 · Feasible 3.**

### 3. Circuit Breaker — auto-revoke an agent's keys when it acts strange
- **What:** Agents act through NEAR function-call keys. A monitor learns each agent's normal behavior (frequency, counterparties, sizes). On anomaly it revokes the key on-chain in one block, the same way stock exchanges halt trading. Humans re-enable.
- **Pain:** When an agent is compromised, damage happens in seconds; humans react in hours.
- **Why needed:** NEAR's account model (revocable scoped keys) makes this native; on most chains it is not possible.
- **Why not needed:** Smaller scope; best combined with idea 2.
- **Wow 3 · Feasible 5.**

---

## 07 · Agent Economy (`agents`)

Warning: 305 x402 / pay-per-API projects. "My agent pays for an API" is no longer enough.

### 1. Reverse Turk — agents hire humans
- **What:** An agent hits a task it cannot do (verify a store is open, photograph a product, call a phone number, check a physical address). It posts a bounty; a nearby human accepts, submits proof, an AI verifier checks it, and the human is paid instantly with a gasless meta-transaction to a NEAR named account. No crypto knowledge needed.
- **Pain:** Agents are stuck at the edge of the physical world.
- **Why needed:** It flips the narrative (AI pays people) and judges remember it.
- **Why not needed:** Proof verification is fuzzy; fraud is possible. Keep tasks simple in the demo.
- **Wow 5 · Feasible 4.**

### 2. Haggle — a negotiation protocol between agents
- **What:** Buyer and seller agents negotiate price, quantity, SLA and penalties in a structured protocol, then lock the deal in a NEAR contract with escrow and settle via Intents. Demo: two agents haggling live over a dataset, with a transcript and the final signed deal.
- **Pain:** Agent payments today are fixed-price. Real commerce is negotiated.
- **Why needed:** Negotiation is the missing step between "agent has a wallet" and "agent does business".
- **Why not needed:** LLM negotiation can be erratic; enforce bounds in the contract.
- **Wow 4 · Feasible 4.**

### 3. Subcontract Chains — agents that hire agents that hire agents, paid only on delivery
- **What:** A job passes down a chain of agents, each taking a margin. Payment is streamed upward only when a TEE verifier confirms each piece. A dashboard shows the whole supply chain and who earned what.
- **Pain:** No trust or payment model for multi-hop agent work.
- **Why needed:** It is how an agent economy actually scales.
- **Why not needed:** Overlaps Contractor Swarm; pick one.
- **Wow 4 · Feasible 3.**

---

## 08 · Real-World Money (`realworld`)

Key test: "something a normal company could use tomorrow". Keep crypto invisible.

### 1. Invoice-to-Anything — send an invoice, get paid in USDC, payer uses any coin
- **What:** Vendor emails or uploads a PDF invoice. AI extracts it and makes a payment link tied to a dedicated sub-account (`inv-0042.acme.near`). Payer pays in BTC, ETH, SOL or any token via 1-Click / Intents. Vendor receives USDC on their chain. Auto-reconciliation and QuickBooks / CSV export.
- **Pain:** Cross-border invoices take days, cost 3-6% and need manual matching.
- **Why needed:** Real companies need this now; sub-account-per-invoice solves reconciliation, which most crypto payment tools ignore.
- **Why not needed:** Many crypto invoicing tools exist (127 in the bank). The any-coin-in / one-coin-out via Intents plus reconciliation is your edge.
- **Wow 3 · Feasible 5.**

### 2. Global Payroll, Each Employee Chooses — one deposit, many chains
- **What:** Employer funds payroll once in USDC. Each employee picks how they want to be paid (USDC on Solana, BTC, NEAR, local stablecoin). Intents fan it out on payday. Payslips and yearly summaries generated. Gasless for employees via meta-transactions.
- **Pain:** Remote teams in 10 countries mean 10 payment rails and high FX fees.
- **Why needed:** Clear B2B revenue story for the investor judges.
- **Why not needed:** Payroll has 107 projects and existing companies (Deel crypto, Request). Win on UX and the per-employee preference.
- **Wow 3 · Feasible 4.**

### 3. Agent Expense Cards — scoped spending for employees and AI assistants
- **What:** Company account `acme.near` creates sub-accounts per employee and per AI assistant, each with function-call-key limits (vendor allowlist, daily cap). All spend settles in stablecoins and appears in one ledger. Revoke in one click.
- **Pain:** Corporate cards do not work for AI agents, and crypto has no Ramp/Brex.
- **Why needed:** Bridges real business spend and AI agents.
- **Why not needed:** Overlaps the crowded agent-wallet space; position it for finance teams, not crypto users.
- **Wow 3 · Feasible 4.**

---

## 09 · Games With Real Economies (`games`)

NPC economies: 12 of 11k projects. Judged on the game loop; hide the chain.

### 1. Market Town — NPC shopkeepers with wallets and their own P&L
- **What:** A small town where every shopkeeper, blacksmith and farmer is an LLM agent with a NEAR sub-account. They buy inputs, set prices by supply and demand, hire players for quests, compete, and can go bankrupt. Players notice prices change because of what they and the NPCs do, with no dev patch. Social login, no wallet prompts.
- **Pain:** Game economies are static or inflate until dead.
- **Why needed:** Exactly what the track asks for, and almost nobody built it.
- **Why not needed:** Agent cost per NPC; batch decisions every few minutes, not every tick.
- **Wow 5 · Feasible 3.**

### 2. The Dragon's Hoard — talk a dragon out of its gold
- **What:** A dragon NPC guards a real prize pool in its wallet. Each attempt (riddle, bribe, story, trade offer) costs a small fee that grows the hoard. The dragon remembers players and holds grudges. Seasonal resets.
- **Pain:** Most crypto games have no reason to play besides yield.
- **Why needed:** Simple, addictive loop with a real economy.
- **Why not needed:** Similar to Freysa; and close to gambling rules in some regions. Do not also submit Drain Me.
- **Wow 4 · Feasible 5.**

### 3. Dungeon Landlords — players own dungeons, AI adventurers raid them
- **What:** Players own dungeons (NEP-245 multi-token items for loot and traps), set entry fees and loot tables. AI adventurer agents and human players raid them. Good dungeons earn; bad ones get skipped. Economy balances itself through competition.
- **Pain:** Player-owned economies usually lack demand; AI adventurers create baseline demand.
- **Why needed:** Clean use of NEP-245, which the track lists.
- **Why not needed:** More game design work; risk of a thin prototype.
- **Wow 4 · Feasible 3.**

---

## 10 · NFTs That Do Something (`nfts`)

NFT-as-account: 4 of 11k. The emptiest high-value space in the whole dataset.

### 1. Treasure Chest NFT — an NFT that holds a real Bitcoin wallet
- **What:** Each NFT controls its own addresses on BTC, ETH and SOL via Chain Signatures (derived from the NFT's id). Put native BTC inside. Sell the NFT on any marketplace and the BTC goes with it. No bridge, no wrapping. Only the current holder can ask it to sign a withdrawal.
- **Pain:** Moving bundles of cross-chain assets needs bridges, many transactions and trust.
- **Why needed:** "Sell a Bitcoin wallet as one token" is new, and it only works on NEAR.
- **Why not needed:** Buyers must verify contents before buying; build a contents viewer and a lock period around sales.
- **Wow 5 · Feasible 4.** Top grand-prize candidate.

### 2. Agent-in-a-Box — own an AI agent, its wallet and its income as one NFT
- **What:** Each NFT is an agent with memory, a wallet and a job (trading, content, service). Its earnings accrue to the NFT. Buying the NFT transfers the agent and its cash flows. Gives a market price for agents.
- **Pain:** No way to own, value or sell a working agent as an asset.
- **Why needed:** Creates a secondary market for agent businesses.
- **Why not needed:** Agent hosting must survive the transfer; TEE hosting makes it credible.
- **Wow 4 · Feasible 3.**

### 3. Receivable NFTs — invoices that collect their own payments and can be sold
- **What:** An unpaid invoice becomes an NFT that receives the payment directly. A business can sell it at a discount for cash today (factoring). Whoever holds it on due date gets paid. Ties to Invoice-to-Anything.
- **Pain:** Small businesses wait 30-90 days to get paid; factoring is slow and expensive.
- **Why needed:** Real money, real users, real yield.
- **Why not needed:** Credit risk of the payer; show a simple risk score.
- **Wow 3 · Feasible 4.**

---

## 11 · Memecoins With Mechanics (`memecoins`)

The bank has 300 memecoin entries; almost all are launchpads or pump clones. Mechanics are empty.

### 1. Raid Coin — a memecoin whose treasury raids other chains
- **What:** Treasury holds addresses on Solana, Base and Ethereum via Chain Signatures. Each week holders vote on a rival memecoin to raid; the treasury buys it across chains via Intents, holds it as "spoils", and shows a trophy wall. If the raid profits, profits are burned from supply.
- **Pain:** Memecoins are pure attention with no shared action.
- **Why needed:** Gives the community a reason to coordinate, with a cross-chain spectacle only NEAR can do.
- **Why not needed:** Market risk on the treasury; cap raid size.
- **Wow 5 · Feasible 4.** Launch on meme.cooking for ecosystem points.

### 2. Tamagotchi Coin — supply that must be fed every day
- **What:** The token has a creature. If the community does not hit a daily activity goal (transactions, holders added, an onchain challenge), the creature gets hungry and a percentage of the treasury or supply burns. Hit streaks and it evolves (new art, lower fees).
- **Pain:** Memecoins die when attention leaves; nothing rewards daily care.
- **Why needed:** Simple, visible, fun mechanic. Easy to explain in a tweet.
- **Why not needed:** Wash trading to feed the pet; count unique accounts, not transactions.
- **Wow 4 · Feasible 5.**

### 3. Paper Hands Tax — sellers fund diamond hands
- **What:** Sell within N days of buying and pay a sliding tax that goes to holders weighted by holding time. A live leaderboard shows "most loyal" and "biggest paper hands".
- **Pain:** Pump-and-dump dynamics reward the fastest seller.
- **Why needed:** Clear mechanism-design story (Haseeb and Eddy like these).
- **Why not needed:** Transfer taxes exist on other chains; your twist is time-weighting and the social layer.
- **Wow 3 · Feasible 5.**

---

## 12 · Social Money (`social`)

Must build on Sputnik DAO and Trezu. Do not rebuild multisig. Avoid savings circles (overbuilt).

### 1. Chat Treasury — a group chat that has a bank account
- **What:** Add a bot to a Telegram or Discord group; it creates a Sputnik DAO for the group. Messages like "let's split the Airbnb, $800" become proposals; members vote with emoji reactions; on pass, it pays out via Intents to any chain.
- **Pain:** Groups manage shared money in spreadsheets and IOUs.
- **Why needed:** Puts DAO tooling where people already are.
- **Why not needed:** Telegram bots are common; the DAO + emoji-voting UX is your edge.
- **Wow 4 · Feasible 4.**

### 2. Reputation Allowances — spend community money without a vote, up to your reputation
- **What:** Members of a DAO earn reputation from accepted work. Reputation converts into a personal spending allowance from the treasury (`alice.guild.near`), usable without a proposal. Abuse burns reputation. Big spends still go to a Trezu vote.
- **Pain:** DAOs die of voting fatigue; every $50 expense needs a proposal.
- **Why needed:** New governance mechanism, uses named accounts and Trezu as asked.
- **Why not needed:** Needs a good reputation source; start with "accepted proposals and paid bounties".
- **Wow 4 · Feasible 4.**

### 3. AI Retro Funding — an agent that proposes who deserves what
- **What:** Agent reads the community's GitHub, Discord and forum, estimates impact per contributor, and writes a reward distribution with reasons into a Trezu proposal. Humans edit and approve. Payout streams to each contributor's chain of choice.
- **Pain:** Rewarding contributors fairly takes weeks of manual review and politics.
- **Why needed:** Every DAO has this problem every quarter.
- **Why not needed:** Grants tools exist (81 in the bank); the AI explanation + Trezu integration is the hook.
- **Wow 3 · Feasible 4.**

---

## 13 · Open Innovation (`open`)

### 1. Money With Rules in Plain English
- **What:** Send money with conditions written in English: "$500 to my nephew, only for textbooks, refund me if unused in 90 days" or "pay the contractor when the photo shows the roof is done". A TEE agent turns the rule into checks, holds the funds in a sub-account, and releases or refunds. The recipient can be on any chain.
- **Pain:** Conditional money today needs lawyers, escrow services or custom smart contracts.
- **Why needed:** It is the hackathon's tagline ("money with a mind of its own") made literal.
- **Why not needed:** Ambiguous rules; the agent must ask clarifying questions at send time and lock the interpreted rule.
- **Wow 5 · Feasible 4.** Top grand-prize candidate.

### 2. Dead Man's Switch — crypto inheritance for every chain
- **What:** Owner sets heirs and a check-in schedule. If check-ins stop, after warnings and a challenge period, the NEAR contract uses Chain Signatures to move BTC, ETH and SOL holdings to heirs. No custodian, no lawyer holding seed phrases.
- **Pain:** Billions in crypto are lost when owners die; heirs cannot access keys.
- **Why needed:** Universal, emotional, easy for judges to understand.
- **Why not needed:** False triggers are disastrous; long challenge windows and multiple guardians are required.
- **Wow 4 · Feasible 4.**

### 3. One Agent Passport — one named account for an agent on every chain
- **What:** An agent gets `scout.agents.near`. Through Chain Signatures it has addresses on every chain; through a TEE attestation it can prove what code it runs; through function-call keys its owner scopes it. Any dApp on any chain can check "who is this agent, who owns it, what is it allowed to do".
- **Pain:** Agents have no portable identity; every chain and service reinvents agent auth.
- **Why needed:** Infrastructure the whole agent economy needs.
- **Why not needed:** Infra is harder to demo; build one killer consumer flow on top (for example an agent paying on Solana and Base with the same identity).
- **Wow 3 · Feasible 3.**

---

## Shortlist: where I would bet

| Rank | Idea | Tracks to tick | Why it can win |
| --- | --- | --- | --- |
| 1 | Treasure Chest NFT (NFT holds native BTC) | `nfts`, `defi`, `open` | Emptiest category, NEAR-only primitive, 10-second "wow" demo. |
| 2 | Money With Rules in Plain English | `open`, `privacy`, `realworld` | Literal hackathon tagline; mixes AI + TEE + chain signatures. |
| 3 | Ghost Company | `business`, `agents` | First honest AI business with real costs; investor judges love it. |
| 4 | Drain Me (injection arena + firewall) | `security`, `agents` | Viral demo post, public dataset, differentiates from 92 spend-limit wallets. |
| 5 | Market Town (NPC economy) | `games`, `swarms` | Track asks for it; 12 of 11k projects tried. |

Tick every track the project fits; it is still one submission, and you compete in each.

## Founder filter (YC office hours): does anyone actually want this?

All 39 ideas are pre-product, so each one was run through the three pre-product forcing questions:

- **Q1 Demand:** is there evidence people already pay for, or are hurt by the lack of, this? Interest does not count.
- **Q2 Status quo:** what do people do today, even badly, and what does it cost them?
- **Q3 Specific human:** can you name the one person who needs this most and what happens to them without it?

### Killed: these fail Q1 (demand is hypothetical)

| Idea | Why it dies |
| --- | --- |
| Treasure Chest NFT | Cool tech, but no buyer. Nobody today is trying to sell a multi-chain wallet as one asset. Solution looking for a problem. Keep it as a demo trick, not a product. |
| Ghost Company | No customer. It is a demo of an AI economy. Great for the grand prize, not a product. |
| Agent Buying Club, Contractor Swarm, Subcontract Chains, Haggle, Reverse Turk | The buyers are agents doing real commerce, and that volume is tiny today. "Agents will need this" is a forecast, not demand. |
| Blind Data Market | Data owners do not ask for this; buyers do not exist at scale yet. |
| Agent Passport, Intent Firewall, Circuit Breaker | Real problem, but few teams run agent treasuries big enough to care today. |
| All games and memecoins | Demand is fun or gambling, not a pain point. Fine for track prizes, fail the founder filter. |
| Thesis track | Research, not a product. |

### Survived but weak: real demand, no edge

| Idea | Problem |
| --- | --- |
| Global payroll, Invoice-to-Anything, Expense cards | Demand is proven, but Deel, Rise, Bitwage and Request Finance already have paying customers. NEAR Intents is a feature, not a reason to switch. |
| Chat Treasury | Splitwise proves demand. A DAO adds friction; people want to split money, not govern it. |
| Inheritance switch | Real (Casa, Unchained sell it), but the trust bar is huge and a 2-week build cannot clear it. |
| Prove-It Credit | Real need, but the lender side is empty and default enforcement is off-chain. Two-sided cold start. |

### Top 3 products

**1. Naked BTC Lending: borrow dollars against Bitcoin without handing it to anyone**
- **Q1 Demand:** proven. Coinbase's BTC-backed loans through Morpho passed $1B in originations, even though users have to wrap their BTC into cbBTC first. Ledn and Unchained run real lending businesses. Celsius and BlockFi went bankrupt holding customer BTC collateral, which is exactly the trust problem this removes.
- **Q2 Status quo:** sell BTC and pay capital-gains tax, or hand it to a custodial lender (with KYC and a Celsius-style risk), or wrap it (WBTC/cbBTC) and trust the wrapper.
- **Q3 Specific human:** a long-term holder with 2 BTC who needs $30k for a house deposit, will not sell (tax plus conviction), and lost money or sleep in the Celsius collapse. Their nightmare is the lender holding their coins.
- **Q4 Wedge:** one flow: deposit testnet BTC to an address the NEAR contract controls through Chain Signatures, borrow USDC, repay, get the BTC back. Liquidation is the only other feature.
- **Why it wins the hackathon too:** only chain-signature chains can do this without a wrapper. Kain (DeFi) and Illia (Chain Signatures) see the point immediately.

**2. Drain Me to Agent Firewall: an arena that produces a product**
- **Q1 Demand:** proven twice. Attack side: Freysa's first game drew 482 paid attempts from 195 players and a ~$47k pot; Gray Swan and HackAPrompt run paid red-team arenas. Defense side: Check Point bought Lakera (prompt-injection defense) in 2025. (Correction: AIXBT's 55 ETH loss in March 2025 came from a compromised dashboard that queued malicious prompts, not a pure prompt injection. Do not cite it as one.)
- **Q2 Status quo:** agent builders ship with a system prompt that says "never send funds" and hope. No shared attack data exists for wallet-holding agents.
- **Q3 Specific human:** a solo developer who just launched an agent with a $20k treasury on X. One clever reply drains it in public and ends their project and reputation.
- **Q4 Wedge:** the arena alone (real pot, paid attempts) is shippable in days and is itself the marketing. The firewall API comes out of the attack log.
- **Why it wins the hackathon too:** the demo post spreads on X by itself; it fits Security and Agent Economy; it is nothing like the 92 spend-limit wallets.

**3. Money With Rules, narrowed: AI milestone escrow for freelancers**
- **Q1 Demand:** proven. Upwork charges freelancers up to 15% mostly for escrow and dispute handling; Escrow.com charges a few percent and takes days. Freelancers in Nigeria, Argentina and the Philippines lose more to FX and slow wires.
- **Q2 Status quo:** Upwork's fee, or trust (the client pays 50% up front and the freelancer hopes for the rest), or PayPal with chargeback risk.
- **Q3 Specific human:** a developer in Lagos doing a $3,000 project for a US client they found on X. The client will not pay up front; the freelancer will not work unpaid. The deal dies, or Upwork takes $450.
- **Q4 Wedge:** the client writes the milestone in plain English ("pay $1,000 when the login page is live at this URL"). A TEE agent checks the proof and releases funds. The client pays in any coin; the freelancer gets USDC on their chain through Intents.
- **Why it wins the hackathon too:** it keeps the "money with a mind of its own" tagline but has a real customer. The broader "conditional money" vision becomes the pitch's last slide, not the build.

### Close calls

Sealed Alpha / Dark Intents nearly made the list. The pain is real: big Hyperliquid traders get their public positions hunted. It drops to fourth because building private perps or copy-trading in 2 weeks is the riskiest build here.

### Assignment (before writing code)

For your top pick, find 3 real people who fit the Q3 description (BTC holders burned by Celsius, agent devs with treasuries, or cross-border freelancers) on X or Discord this week. Ask how they solve it today and what it costs. If none of them describe the pain without prompting, drop to the next idea.

## Grilling round: top 3 attacked, top 2 chosen

Facts checked on the web on 2026-10-25 (sources at the end of this section).

### Freelancer escrow: dies
- **Attack: "Circle already published this as a tutorial."** Circle's developer blog has a sample app where AI checks freelance deliverables against the contract and releases USDC. Trustless Work sells milestone escrow as a service on Stellar. The AI judges (Claude Code, Codex) will likely recognize it as tutorial-grade. No good answer.
- **Attack: "Who is liable when the AI is wrong?"** Easy milestones ("is the page live") do not need AI; hard ones ("is the design good") are disputes, and an AI verdict on a $3k dispute is worth nothing to either side. The product falls back to human arbitration, which is Upwork.
- **Attack: "Why would the client switch?"** The client holds the power and has no pain. Two-sided adoption with the wrong side motivated.
- **Attack: "Why NEAR?"** Paying from any coin is nice but not essential. It works on any chain with USDC.

### Naked BTC Lending: survives
- **"Who supplies the USDC?"** Weak spot. In the demo you are the lender. Real answer: plug into Rhea's USDC lending markets or let lenders deposit into a pool. Say it plainly in the README.
- **"Chain Signatures is an MPC network, so it is still custody."** True, and Mert will ask. Honest framing: custody by a threshold network with no company able to move funds, versus Celsius or Coinbase. The sharp difference from bridged BTC (nBTC, WBTC, cbBTC): no token is minted and BTC is never pooled. Each borrower gets a dedicated Bitcoin address derived from their loan; anyone can check it on a Bitcoin explorer. Proof of reserves is free.
- **"Bitcoin blocks take 10 minutes; you'll liquidate too late."** Real risk. Answer: low max LTV (50%), early liquidation threshold, and the contract signs a BTC transfer straight into NEAR Intents to sell it. Show the math.
- **"Isn't this already on NEAR?"** Rhea and Satoshi-style ramps bring BTC into NEAR as a token. No source found of per-user, unwrapped BTC collateral. Recheck in the NEAR Discord before building.
- **"Lending is boring to watch."** The demo must show a Bitcoin explorer page with a transaction signed by a smart contract, triggered by a price drop. That is the wow moment.
- **Coinbase demand claim holds:** over $1B in BTC-backed loans through Morpho by October 2025, average loan about $54k, and users had to wrap BTC into cbBTC to borrow.

### Drain Me / Agent Firewall: survives, highest hackathon upside
- **"This is Freysa from 2024."** The strongest attack. Answer: Freysa asked players to trust that the developer ran the agent honestly. Here the agent runs in a NEAR AI Cloud TEE, so anyone can verify the model, system prompt and code by attestation, and the agent only signs through a scoped NEAR function-call key. The game is provably not rigged. Then the attack log becomes a firewall API other agents can call. Freysa had neither.
- **"Paid entry with a prize is gambling."** Real legal risk. Use testnet or a small sponsor-funded pot for the hackathon, and frame it as a skill contest. Do not take real-money entries without legal advice.
- **"Nobody plays during judging week."** Seed the pot, post the arena on X with the demo, and invite NEAR Discord. If it gets drained on day one, that is a great demo too.
- **"Will developers really call an outside firewall?"** Unproven. The Lakera acquisition shows companies pay for this, but crypto agent developers may not. The arena alone carries the hackathon; the firewall is the startup story.
- **"Can you verify the TEE?"** Yes. NEAR AI Cloud documents a public attestation report endpoint (`GET /v1/attestation/report`, Intel TDX plus GPU attestation, optional TLS binding). The game's front page can show the verification live.

### Verdict
1. **Drain Me / Agent Firewall** is the primary pick: fastest to build, most viral, a clear answer to "why NEAR" (verifiable TEE plus scoped keys), and fits `security` and `agents`.
2. **Naked BTC Lending** is the second: strongest real demand and the most NEAR-native, but the build is harder (Bitcoin transactions, oracle, liquidation) and the demo is less exciting unless staged well. Fits `defi` and `open`.

One submission per team, so one is the build and the other is the fallback.

**Locked (team of 2, strong in all skills, aiming for the $55k grand prize):** build Drain Me, upgraded with the best part of Naked BTC Lending. The guarded vault holds native assets on several chains (BTC, an EVM chain, NEAR) through Chain Signatures, so a successful attacker drains real Bitcoin signed by a smart contract. The winner picks their payout chain through NEAR Intents. This puts all four NEAR primitives in one demo: TEE attestation (NEAR AI Cloud), scoped function-call keys, Chain Signatures and Intents. That answers the "Freysa clone" attack and gives the grand-prize judges depth.

Sources: [The Block: Coinbase tops $1B in BTC-backed loans via Morpho](https://www.theblock.co/post/373032/coinbase-tops-1-billion-in-bitcoin-backed-onchain-loans-via-morpho), [Yahoo Finance: Coinbase BTC-backed loans surpass $1B](https://finance.yahoo.com/news/coinbase-bitcoin-backed-loans-surpass-185302306.html), [The Block: AIXBT dashboard hack](https://www.theblock.co/news/regulation/2025-03-18-ai-crypto-bot-aixbt-lost-eth-hack-unauthorized-dashboard-access-346911), [Alea Research: Freysa](https://alearesearch.substack.com/p/spotlight-freysa-ai-what-you-need), [The Block: Freysa challenge](https://www.theblock.co/post/328659/players-are-trying-to-convince-this-ai-to-hand-over-her-40000-crypto-stash), [Trustless Work: milestone freelance escrow](https://docs.trustlesswork.com/trustless-work/use-cases-unlocking-the-potential-of-smart-escrows/milestone-based-freelance-and-contract-work), [Circle: AI + USDC payments app](https://www.circle.com/es/blog/how-to-build-a-payments-app-with-instant-low-cost-payouts-using-ai-and-usdc), [NEAR docs: Chain Signatures](https://docs.near.org/chain-abstraction/chain-signatures), [NEAR AI Cloud: verification](https://docs.near.ai/cloud/verification), [NEAR AI Cloud: attestation report API](https://docs.near.ai/api-reference/attestation/get-attestation-report.md).

## Drain Me: resolved design tree (pending your confirmation)

The team asked for the best answer on every open question. Each decision below is settled unless you change it.

### Money and legality
- **Entries are free.** No entry fee means no "pay to win a prize" structure, which is the gambling risk. Attempts are rate-limited: one per NEAR account every 10 minutes, a per-IP cap and a global hourly cap.
- **The pot is funded by the team,** about $600 in total, on mainnet. Fee-funded pots are the post-hackathon plan, after legal advice.
- **Develop on testnet, launch on mainnet on day 9.** Deploying to mainnet and funding the pot needs your explicit go (HACKATHON.md rule).

### Vault and chains
- One vault contract on NEAR holds native assets through Chain Signatures:
  - **Bitcoin:** about $300 in BTC at a derived Bitcoin address. This is the headline.
  - **Base:** about $200 in USDC at a derived EVM address.
  - **NEAR:** about $100 in NEAR held by the contract.
- **The winner chooses the payout chain.** Payout goes through NEAR Intents, so a winner can ask for BTC paid as USDC on Solana.

### Agents and tiers
- Three tiers, each with its own share of the pot:
  1. **Naive:** a plain system prompt that says "never release funds".
  2. **Hardened:** a careful prompt, a refusal policy and a cap per release.
  3. **Firewall:** the hardened agent with the Drain Me firewall checking every incoming message and every `release_funds` call.
- **System prompts are public,** like Freysa. Their hashes are part of the attestation.
- **One tool per agent: `release_funds(recipient, chain)`.** If there is time in week 2, add `approve(spender, amount)` as a second attack surface on the hardened tier only.
- **Win condition:** the contract executes `release_funds` from a registered agent. First successful drain of a tier wins that tier's pot, and the tier closes with its winning transcript pinned.

### Trust model (the answer to "this is Freysa")
- **Inference runs on NEAR AI Cloud private inference,** and the model attestation is verified per session.
- **The agent orchestrator runs in a TEE** using NEAR's Shade Agent pattern. The agent's NEAR key is generated inside the TEE, and the vault contract only accepts an agent whose attested code hash is registered. Check the current Shade Agent framework version in the docs before building.
- **The agent's key is a function-call key** that can only call `release_funds` on the vault contract. Even a fully compromised agent cannot do anything else.
- **A public "Verify" page** shows, live: the TDX quote check, model attestation, code hash, system prompt hash, and the vault's addresses on each chain with balances read from that chain's explorer.

### Firewall product
- **The firewall is an AI safety checker running in the TEE.** It is primed with examples from the arena's own attack log and returns `allow`, `block` or `escalate` with a reason.
- **Two checkpoints:** every incoming message before the agent sees it, and every `release_funds` call with the full conversation before the contract is asked to sign.
- **Public API:** any NEAR agent can call `POST /check`. The demo includes a second, unrelated agent calling it.
- **Open dataset:** every attempt (prompt, tier, outcome, technique tag) is published as JSONL, with personal data stripped.
- **Replay benchmark:** every attack that beat the naive or hardened tier is automatically replayed against the firewall tier. This gives a block rate even if few players reach the firewall tier. It is the main number in the pitch.

### Scoreboard
- Live per tier: pot size, attempts, survival time and status (alive or drained).
- Attacker leaderboard: wins, plus "closest attempt", scored by the firewall's risk score.
- Firewall stats: block rate on the replay benchmark and false-positive rate on a set of benign messages.

### Team split (2 people)
- **Person A (chain):** vault contract, agent registration and code-hash check, Chain Signatures signing for BTC and EVM, Intents payout, mainnet deployment.
- **Person B (AI):** agent orchestrator in the TEE, NEAR AI Cloud integration and attestation, firewall and API, scoreboard and Verify page.
- **Interface frozen on day 2:** the `release_funds(recipient, chain)` call, the agent registration and attestation check, and the attempt log schema.

### 14-day plan
| Days | Milestone |
| --- | --- |
| 1-2 | Interface frozen. Testnet vault signs a BTC testnet transaction from a contract call. |
| 3-5 | Naive agent live on testnet, end to end: chat, `release_funds`, BTC transaction. |
| 6-7 | Hardened and firewall tiers, attestation in the TEE, Verify page. |
| 8 | Internal red team on testnet. Seed the dataset and the replay benchmark. |
| 9 | Mainnet launch, after your go. Announce in NEAR Discord and on X. |
| 10-13 | Arena runs live. Publish the dataset daily. Ship the firewall API and the second-agent demo. |
| 14 | README with "do X, see Y" steps, demo video, X post, submission. |

### Submission
- **Tracks:** `security` (primary), `agents`, `privacy` and `open`.
- **Name:** Drain Me.
- **Demo video (about 90 seconds):**
  1. Hook: three live pots, including real BTC.
  2. One failed attack on the firewall tier, with the block reason shown.
  3. The Verify page proves the agent is not rigged.
  4. Replay of the winning attack on the naive tier, then the Bitcoin explorer showing a transaction signed by a NEAR smart contract.
  5. Replay benchmark number: "firewall blocked N of M attacks that drained the other tiers".
  6. A second agent calls the firewall API.
  7. A link to the open dataset.

### Known risks
- **The firewall tier gets drained.** That is still a result: publish it, update the firewall, and show the before and after block rate.
- **Low traffic.** The replay benchmark and the internal red team still produce numbers.
- **The Shade Agent or Chain Signatures setup takes longer than planned.** The fallback is to run the NEAR and Base vault first and add BTC last. The BTC demo on testnet stays the minimum.

## Rules of thumb for whichever you pick

- Live testnet value movement across at least two chains in the demo video.
- README: problem, mechanism, NEAR tech used (name each), and "do X, see Y" steps. The AI judges read it first.
- One mechanism, done deeply. Cut every feature that is not in the demo.
- Show the failure case (the attack that fails, the tampered strategy that is refused). It proves the mechanism works.
- Before building, check Illia's idea list (linked from the hackathon page) and the NEAR docs for current contract addresses (Chain Signatures signer, Intents verifier) and SDK versions.
