# Allowance

**Provable spending mandates for AI agents on Mina.** An owner gives an agent a budget under a private policy. The agent folds every payment it makes into one recursive zk proof. Anyone can settle that proof on-chain, and the contract reimburses the agent only if every spend followed the policy.

Built with [o1js](https://github.com/o1-labs/o1js) 3.1. Tested on a local Mina ledger with real recursive proofs.

```
owner ── initialize(owner, agent, hash(policy)) ──►  Allowance contract (holds the budget)
          policy stays private:                        on-chain: policyHash, period,
          agent key, allowlist root,                             spent, receipts
          per-spend cap, daily cap, salt                          ▲
                                                                  │ settle(proof)
agent pays inference API ──┐                                      │ checks the proof continues
agent pays GPU cloud ──────┼─► SpendLog.append (recursive) ───────┘ on-chain state, then pays
agent pays inference API ──┘   one constant-size proof per day      the agent what it covers
```

## Why

Agents now pay for things themselves: API calls, x402 invoices, compute. An owner wants hard limits. Checking every payment on-chain is slow and expensive, and it publishes the policy: who the agent may pay and how much. Allowance keeps the policy private and checks the whole day at once:

- **Hidden policy.** Only `Poseidon(policy)` is on-chain. The random salt stops anyone brute-forcing the caps.
- **One proof per day, any number of spends.** `SpendLog` is a recursive ZkProgram. Each `append` verifies the previous proof plus one new spend, and the proof stays the same size however long the log gets.
- **Settlement is permissionless.** Anyone can submit the proof and pay the fee, but the payout always goes to the agent address the owner set.
- **The owner can audit.** The contract stores a hash chain over every settled spend. Given the agent's records, the owner recomputes it to show nothing is missing, added or reordered.

## What a settled proof guarantees

For every spend in the log, the circuit checks that:

1. the policy hashes to the mandate committed on-chain,
2. the payee is on the allowlist (Merkle membership, up to 128 payees),
3. the amount is within the per-spend cap,
4. the running total for the period stays within the period cap,
5. the mandated agent signed this spend at this exact position in the log.

When it settles, the contract checks that the proof:

- continues exactly from the last settled `receipts`, so a log can't be replayed or forked,
- is for the current policy, so rotating the mandate kills in-flight proofs,
- either continues the current period's total or opens a later period at zero, and never reopens a closed one,
- is for a period that has started (a `currentSlot` precondition), so the agent can't draw tomorrow's budget today.

## Run it

Requires Node.js 22.19.5 or newer.

```sh
npm install
npm test             # 13 logic tests, about 6s (no proofs; circuit assertions and ledger rules still run)
npm run test:proofs  # the same 13 tests with real recursive proofs, about 3.5 min
npm run demo         # end-to-end run with real proofs
```

Demo output on an Apple-silicon laptop:

```
1. Compile
   SpendLog recursive ZkProgram (9.8s)
   Allowance contract (5.2s)
   SpendLog.append circuit: 596 rows
2. Owner deploys a mandate for the agent
   deploy + initialize, proved (3.8s)
   private policy: 2 allowed payees, max 2 MINA per spend, max 5 MINA per day
   on-chain:       policy hash 234185858050546931…, budget 20 MINA
3. Agent spends through the day, folding each spend into one proof
   open log for period 12 (3.0s)
   spend 1.5 MINA → inference API (5.2s)
   spend 2 MINA → GPU cloud (5.2s)
   spend 1 MINA → inference API (5.5s)
   running total 4.5 MINA; proof size after 1, 2, 3 spends: 34588, 34588, 34588 chars (constant)
4. Agent tries to overspend
   refused: spend would exceed the period cap
5. Anyone settles the day with the single proof
   settle, proved and applied (5.4s)
   agent reimbursed 4.5 MINA; budget left 15.5 MINA
6. Owner audits the agent's spend records against the chain
   receipts chain over 3 records matches on-chain state: complete and untampered
```

## Deploy to a live network

[`src/deploy.ts`](src/deploy.ts) deploys the contract, opens the agent's account, proves a real spend log against the live global slot, settles it, and records the transaction hashes in `deployments/<network>.json`. Keys and the private policy salt are written to `keys/` (gitignored), so re-runs reuse the same contract.

```sh
npx zkapp-cli lightnet start --mina-branch mesa   # local Mina network in Docker
NETWORK=lightnet npm run deploy

NETWORK=devnet npm run deploy   # first run prints a faucet link for the owner account
```

Lightnet run (Mesa branch, single node):

```
compile: 18.4s
deploying: deploy + initialize + fund budget + open agent account
  included
slot 12, period 0: proving a spend log
  prove spend 0.6 MINA: 5.7s
  prove spend 0.4 MINA: 5.6s
settling 5Juxuw5eD5bgxUKafikvqQxnintdnZXbcDeqMCba1crskzJ7iYkP
  included: agent reimbursed 1 MINA
  on-chain spent 1 MINA in period 0
  receipts match the agent's records
```

## Tests

[`test/allowance.test.ts`](test/allowance.test.ts) covers the happy path and every way to cheat that the design rules out. Each rejection is pinned to its specific error, not just "it threw":

| Attack | Stopped by |
| --- | --- |
| pay someone off the allowlist (with a forged witness) | circuit: `payee is not on the allowlist` |
| one spend over the per-spend cap | circuit: `per-spend cap` |
| a day's total over the period cap | circuit: `period cap` |
| spends signed by a key other than the agent's | circuit: `not signed by the mandated agent` |
| agent proves under a looser policy it made up | circuit: `policy does not match the mandate` |
| settle the same log twice | contract: `does not continue the settled log` |
| settle an empty log | contract: `no spends` |
| settle a log proven before the owner rotated the policy | contract: `different mandate` |
| reopen yesterday after today settled | contract: `period is already closed` |
| settle tomorrow's budget today | `currentSlot` precondition (and the same proof settles once tomorrow starts) |
| a stranger rotates the mandate or withdraws | missing owner signature |

## Layout

| File | What it holds |
| --- | --- |
| [`src/mandate.ts`](src/mandate.ts) | `Policy`, `Spend`, `Ledger` structs; hashing; the owner-side `Mandate` builder |
| [`src/spend-log.ts`](src/spend-log.ts) | `SpendLog`, the recursive ZkProgram (`open`, `append`) |
| [`src/allowance.ts`](src/allowance.ts) | `Allowance`, the contract (`initialize`, `setMandate`, `withdraw`, `settle`) |
| [`src/session.ts`](src/session.ts) | Agent-side `SpendSession`, `ledgerFor`, and the owner's `auditReceipts` |
| [`src/demo.ts`](src/demo.ts) | The end-to-end run above |
| [`src/deploy.ts`](src/deploy.ts) | Deploy, prove and settle on Lightnet or devnet |

## Design notes

- **The signature covers the running `receipts` hash**, not a counter. That pins each signed spend to one position in one log under one policy, so it can't be replayed, and the contract needs no separate nonce.
- **State fits in 8 fields** (`owner`, `agent`, `policyHash`, `period`, `spent`, `receipts`): the pre-Mesa limit. Mesa's 32 leaves room for per-payee caps or a second agent.
- **Code and permissions are locked at deploy** (`setVerificationKey: impossibleDuringCurrentVersion`, `setPermissions: impossible`). An agent fronting its own money for reimbursement needs to know these rules can't change under it.
- **`initialize` must be in the deploy transaction.** It is guarded by `provedState` as the o1js docs recommend, and it requires the owner's signature.
- **Periods are 960 slots** (24 hours at Mesa's 90 s slots) and are derived from the global slot, not from the agent's clock.

## Limits and next steps

- Runs end to end on Lightnet (a real Mina node). The devnet deployment is next; the devnet endpoints were down while this was written.
- Proving takes about 5 s per spend on a laptop. That's fine for logging spends in the background, but too slow to sit on every HTTP request.
- The day's total and the agent's address are public. Payees, amounts and the policy are not.
- Spends are proven sequentially. A tree of merged sub-logs (two-proof `merge`) would allow proving in parallel.
- Not audited. Don't use it with real funds.

## License

MIT
