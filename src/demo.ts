import { AccountUpdate, Field, Mina, PrivateKey, UInt64 } from 'o1js';
import { Allowance, SLOTS_PER_PERIOD, periodOfSlot } from './allowance.js';
import { Mandate } from './mandate.js';
import { SpendLog, SpendLogProof } from './spend-log.js';
import { SpendSession, auditReceipts, ledgerFor } from './session.js';

// End-to-end run with real recursive proofs on a local Mina ledger.

const mina = (n: number) => UInt64.from(BigInt(Math.round(n * 1e9)));
const fmt = (n: bigint | UInt64) => `${Number(typeof n === 'bigint' ? n : n.toBigInt()) / 1e9} MINA`;
const proofBytes = (p: SpendLogProof) => p.toJSON().proof.length;

async function timed<T>(label: string, run: () => Promise<T>): Promise<T> {
  const start = performance.now();
  const result = await run();
  console.log(`   ${label} (${((performance.now() - start) / 1000).toFixed(1)}s)`);
  return result;
}

console.log('Allowance: provable spending mandates for AI agents on Mina\n');

const Local = await Mina.LocalBlockchain({ proofsEnabled: true });
Mina.setActiveInstance(Local);
const [owner, agent, inferenceApi, gpuCloud, anyone] = Local.testAccounts;

console.log('1. Compile');
await timed('SpendLog recursive ZkProgram', () => SpendLog.compile());
await timed('Allowance contract', () => Allowance.compile());
const analysis = await SpendLog.analyzeMethods();
console.log(`   SpendLog.append circuit: ${analysis.append.rows} rows`);

console.log('\n2. Owner deploys a mandate for the agent');
const mandate = new Mandate({
  agent,
  payees: [inferenceApi, gpuCloud],
  perSpendCap: mina(2),
  periodCap: mina(5),
});
const zkAppKey = PrivateKey.random();
const zkApp = new Allowance(zkAppKey.toPublicKey());
await timed('deploy + initialize, proved', async () => {
  const tx = await Mina.transaction(owner, async () => {
    AccountUpdate.fundNewAccount(owner);
    await zkApp.deploy();
    await zkApp.initialize(owner, agent, mandate.hash);
    AccountUpdate.createSigned(owner).send({ to: zkApp.address, amount: mina(20) });
  });
  await tx.prove();
  await tx.sign([owner.key, zkAppKey]).send().wait();
});
console.log('   private policy: 2 allowed payees, max 2 MINA per spend, max 5 MINA per day');
console.log(`   on-chain:       policy hash ${zkApp.policyHash.get().toString().slice(0, 18)}…, budget ${fmt(Mina.getBalance(zkApp.address))}`);

console.log('\n3. Agent spends through the day, folding each spend into one proof');
Local.setGlobalSlot(12 * SLOTS_PER_PERIOD + 30);
const today = periodOfSlot(12 * SLOTS_PER_PERIOD + 30);
const session = await timed(`open log for period ${today}`, () =>
  SpendSession.open(mandate, agent.key, ledgerFor(zkApp, today))
);
const sizes: number[] = [];
for (const [payee, label, amount, memo] of [
  [inferenceApi, 'inference API', 1.5, 1001],
  [gpuCloud, 'GPU cloud', 2, 1002],
  [inferenceApi, 'inference API', 1, 1003],
] as const) {
  await timed(`spend ${fmt(mina(amount))} → ${label}`, () => session.spend(payee, mina(amount), Field(memo)));
  sizes.push(proofBytes(session.proofOfLog));
}
console.log(`   running total ${fmt(session.ledger.spent)}; proof size after 1, 2, 3 spends: ${sizes.join(', ')} chars (constant)`);

console.log('\n4. Agent tries to overspend');
try {
  await session.spend(inferenceApi, mina(1.5));
  console.log('   !!! overspend was proven, which should be impossible');
  process.exitCode = 1;
} catch (e) {
  console.log(`   refused: ${String((e as Error).message).split('\n')[0]}`);
}

console.log('\n5. Anyone settles the day with the single proof');
const before = Mina.getBalance(agent).toBigInt();
await timed('settle, proved and applied', async () => {
  const tx = await Mina.transaction(anyone, async () => {
    await zkApp.settle(session.proofOfLog);
  });
  await tx.prove();
  await tx.sign([anyone.key]).send().wait();
});
console.log(`   agent reimbursed ${fmt(Mina.getBalance(agent).toBigInt() - before)}; budget left ${fmt(Mina.getBalance(zkApp.address))}`);

console.log('\n6. Owner audits the agent\'s spend records against the chain');
const matches = auditReceipts(Field(0), session.spends).equals(zkApp.receipts.get()).toBoolean();
console.log(`   receipts chain over ${session.spends.length} records ${matches ? 'matches on-chain state: complete and untampered' : 'DOES NOT MATCH'}`);
if (!matches) process.exitCode = 1;
