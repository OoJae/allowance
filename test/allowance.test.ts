import { before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { AccountUpdate, Field, Mina, PrivateKey, UInt32, UInt64 } from 'o1js';
import { Allowance, SLOTS_PER_PERIOD, periodOfSlot } from '../src/allowance.js';
import { Mandate, Spend, signSpend } from '../src/mandate.js';
import { SpendLog, SpendLogProof } from '../src/spend-log.js';
import { SpendSession, auditReceipts, ledgerFor } from '../src/session.js';

// Logic tests run without proofs (circuit assertions and ledger rules still
// apply). REAL_PROOFS=1 runs the same suite with real recursive proofs.
const REAL = process.env.REAL_PROOFS === '1';
const mina = (n: number) => UInt64.from(BigInt(Math.round(n * 1e9)));

type Local = Awaited<ReturnType<typeof Mina.LocalBlockchain>>;
type Account = Local['testAccounts'][number];

let Local: Local;
let owner: Account, agent: Account, shop: Account, cloud: Account, stranger: Account, intruder: Account;

before(async () => {
  Local = await Mina.LocalBlockchain({ proofsEnabled: REAL });
  Mina.setActiveInstance(Local);
  [owner, agent, shop, cloud, stranger, intruder] = Local.testAccounts;
  SpendLog.setProofsEnabled(REAL);
  if (REAL) {
    await SpendLog.compile();
    await Allowance.compile();
  }
});

function newMandate() {
  return new Mandate({
    agent,
    payees: [shop, cloud],
    perSpendCap: mina(2),
    periodCap: mina(5),
  });
}

async function deploy(mandate: Mandate, budget = 20) {
  const zkAppKey = PrivateKey.random();
  const zkApp = new Allowance(zkAppKey.toPublicKey());
  const tx = await Mina.transaction(owner, async () => {
    AccountUpdate.fundNewAccount(owner);
    await zkApp.deploy();
    await zkApp.initialize(owner, agent, mandate.hash);
  });
  await tx.prove();
  await tx.sign([owner.key, zkAppKey]).send().wait();

  const fund = await Mina.transaction(owner, async () => {
    AccountUpdate.createSigned(owner).send({ to: zkApp.address, amount: mina(budget) });
  });
  await fund.sign([owner.key]).send().wait();
  return zkApp;
}

async function settle(zkApp: Allowance, proof: SpendLogProof, by: Account = stranger) {
  const tx = await Mina.transaction(by, async () => {
    await zkApp.settle(proof);
  });
  await tx.prove();
  await tx.sign([by.key]).send().wait();
}

const balance = (who: Account) => Mina.getBalance(who).toBigInt();

function atPeriod(p: number) {
  Local.setGlobalSlot(p * SLOTS_PER_PERIOD + 7);
  return UInt32.from(p);
}

describe('Allowance', () => {
  it('settles a day of spends in one proof and reimburses the agent', async () => {
    const mandate = newMandate();
    const zkApp = await deploy(mandate);
    const period = atPeriod(3);

    const session = await SpendSession.open(mandate, agent.key, ledgerFor(zkApp, period));
    await session.spend(shop, mina(1.5), Field(101));
    await session.spend(cloud, mina(2), Field(102));
    await session.spend(shop, mina(1), Field(103));

    const before = balance(agent);
    await settle(zkApp, session.proofOfLog); // a stranger pays the fee: settlement is permissionless
    assert.equal(balance(agent) - before, mina(4.5).toBigInt());

    assert.equal(zkApp.spent.get().toBigInt(), mina(4.5).toBigInt());
    assert.equal(zkApp.period.get().toBigint(), 3n);
    assert.equal(zkApp.receipts.get().toBigInt(), auditReceipts(Field(0), session.spends).toBigInt());
  });

  it('rejects a payee that is not on the allowlist', async () => {
    const mandate = newMandate();
    const zkApp = await deploy(mandate);
    const session = await SpendSession.open(mandate, agent.key, ledgerFor(zkApp, atPeriod(3)));

    assert.throws(() => mandate.witness(stranger), /not on the allowlist/);
    // Forge it anyway, reusing a real payee's witness: the circuit catches it.
    const spend = new Spend({ payee: stranger, amount: mina(1), memo: Field(0) });
    await assert.rejects(
      session.append(spend, signSpend(agent.key, session.ledger, spend), mandate.witnessAt(0)),
      /payee is not on the allowlist/
    );
  });

  it('rejects a spend over the per-spend cap', async () => {
    const mandate = newMandate();
    const zkApp = await deploy(mandate);
    const session = await SpendSession.open(mandate, agent.key, ledgerFor(zkApp, atPeriod(3)));
    await assert.rejects(session.spend(shop, mina(2.01)), /per-spend cap/);
  });

  it('rejects the spend that would break the period cap', async () => {
    const mandate = newMandate();
    const zkApp = await deploy(mandate);
    const session = await SpendSession.open(mandate, agent.key, ledgerFor(zkApp, atPeriod(3)));
    await session.spend(shop, mina(2));
    await session.spend(cloud, mina(2));
    await assert.rejects(session.spend(shop, mina(1.5)), /period cap/);
    await session.spend(shop, mina(1)); // exactly at the cap is fine
    assert.equal(session.ledger.spent.toBigInt(), mina(5).toBigInt());
  });

  it('rejects a spend not signed by the mandated agent', async () => {
    const mandate = newMandate();
    const zkApp = await deploy(mandate);
    const session = await SpendSession.open(mandate, agent.key, ledgerFor(zkApp, atPeriod(3)));
    const spend = new Spend({ payee: shop, amount: mina(1), memo: Field(0) });
    await assert.rejects(
      session.append(spend, signSpend(intruder.key, session.ledger, spend), mandate.witness(shop)),
      /not signed by the mandated agent/
    );
  });

  it('rejects a policy the owner never committed to', async () => {
    const mandate = newMandate();
    const zkApp = await deploy(mandate);
    // The agent invents a looser policy with a bigger cap.
    const looser = new Mandate({ agent, payees: [shop, cloud], perSpendCap: mina(50), periodCap: mina(500) });
    const session = await SpendSession.open(looser, agent.key, ledgerFor(zkApp, atPeriod(3)));
    await assert.rejects(session.spend(shop, mina(40)), /policy does not match/);
  });

  it('refuses to settle the same log twice', async () => {
    const mandate = newMandate();
    const zkApp = await deploy(mandate);
    const session = await SpendSession.open(mandate, agent.key, ledgerFor(zkApp, atPeriod(3)));
    await session.spend(shop, mina(1));
    await settle(zkApp, session.proofOfLog);
    await assert.rejects(settle(zkApp, session.proofOfLog), /continue the settled log/);
  });

  it('refuses an empty log', async () => {
    const mandate = newMandate();
    const zkApp = await deploy(mandate);
    const session = await SpendSession.open(mandate, agent.key, ledgerFor(zkApp, atPeriod(3)));
    await assert.rejects(settle(zkApp, session.proofOfLog), /no spends/);
  });

  it('stops settling logs proven under a rotated policy', async () => {
    const mandate = newMandate();
    const zkApp = await deploy(mandate);
    const session = await SpendSession.open(mandate, agent.key, ledgerFor(zkApp, atPeriod(3)));
    await session.spend(shop, mina(1));

    const tighter = new Mandate({ agent, payees: [shop], perSpendCap: mina(0.5), periodCap: mina(1) });
    const tx = await Mina.transaction(owner, async () => {
      await zkApp.setMandate(agent, tighter.hash);
    });
    await tx.prove();
    await tx.sign([owner.key]).send().wait();

    await assert.rejects(settle(zkApp, session.proofOfLog), /different mandate/);
  });

  it('resets the cap in a new period but never reopens a closed one', async () => {
    const mandate = newMandate();
    const zkApp = await deploy(mandate);

    const day3 = await SpendSession.open(mandate, agent.key, ledgerFor(zkApp, atPeriod(3)));
    await day3.spend(shop, mina(2));
    await day3.spend(shop, mina(2));
    await day3.spend(cloud, mina(1));
    await settle(zkApp, day3.proofOfLog);

    const day4 = await SpendSession.open(mandate, agent.key, ledgerFor(zkApp, atPeriod(4)));
    assert.equal(day4.start.spent.toBigInt(), 0n);
    await day4.spend(cloud, mina(2));
    await settle(zkApp, day4.proofOfLog);
    assert.equal(zkApp.period.get().toBigint(), 4n);
    assert.equal(zkApp.spent.get().toBigInt(), mina(2).toBigInt());

    // Try to squeeze more out of day 3 after day 4 has settled.
    const late = await SpendSession.open(mandate, agent.key, ledgerFor(zkApp, UInt32.from(3)));
    await late.spend(shop, mina(1));
    await assert.rejects(settle(zkApp, late.proofOfLog), /already closed/);
  });

  it('refuses a log for a period that has not started', async () => {
    const mandate = newMandate();
    const zkApp = await deploy(mandate);
    atPeriod(3);
    const early = await SpendSession.open(mandate, agent.key, ledgerFor(zkApp, UInt32.from(4)));
    await early.spend(shop, mina(2));
    await assert.rejects(settle(zkApp, early.proofOfLog), /Valid_while_precondition_unsatisfied/);
    assert.equal(zkApp.spent.get().toBigInt(), 0n);

    // The same proof settles once period 4 has actually begun.
    atPeriod(4);
    await settle(zkApp, early.proofOfLog);
    assert.equal(zkApp.spent.get().toBigInt(), mina(2).toBigInt());
  });

  it('lets only the owner rotate the mandate or withdraw', async () => {
    const mandate = newMandate();
    const zkApp = await deploy(mandate, 10);

    const hijack = new Mandate({ agent: intruder, payees: [intruder], perSpendCap: mina(10), periodCap: mina(10) });
    const rotate = await Mina.transaction(intruder, async () => {
      await zkApp.setMandate(intruder, hijack.hash);
    });
    await rotate.prove();
    const missingOwnerSignature = /permission for this field is 'Signature'/;
    await assert.rejects(rotate.sign([intruder.key]).send().wait(), missingOwnerSignature);

    const steal = await Mina.transaction(intruder, async () => {
      await zkApp.withdraw(mina(10));
    });
    await steal.prove();
    await assert.rejects(steal.sign([intruder.key]).send().wait(), missingOwnerSignature);

    const before = balance(owner);
    const withdraw = await Mina.transaction(owner, async () => {
      await zkApp.withdraw(mina(4));
    });
    await withdraw.prove();
    await withdraw.sign([owner.key]).send().wait();
    assert.equal(balance(owner) - before, mina(4).toBigInt());
    assert.equal(Mina.getBalance(zkApp.address).toBigInt(), mina(6).toBigInt());
  });

  it('maps slots to 24-hour periods', () => {
    assert.equal(periodOfSlot(0).toBigint(), 0n);
    assert.equal(periodOfSlot(SLOTS_PER_PERIOD - 1).toBigint(), 0n);
    assert.equal(periodOfSlot(SLOTS_PER_PERIOD).toBigint(), 1n);
  });
});
