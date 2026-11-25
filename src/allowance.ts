import {
  AccountUpdate,
  Field,
  Permissions,
  Provable,
  PublicKey,
  SmartContract,
  State,
  Struct,
  UInt32,
  UInt64,
  method,
  state,
} from 'o1js';
import { SpendLogProof } from './spend-log.js';

/** 960 slots of 90 s each (Mesa slot time) is 24 hours. */
export const SLOTS_PER_PERIOD = 960;

export function periodOfSlot(slot: number | bigint): UInt32 {
  return UInt32.from(BigInt(slot) / BigInt(SLOTS_PER_PERIOD));
}

export class MandateSet extends Struct({ agent: PublicKey, policyHash: Field }) {}

export class Settled extends Struct({
  period: UInt32,
  spent: UInt64,
  paid: UInt64,
  receipts: Field,
}) {}

/**
 * Holds an owner's budget for one AI agent.
 *
 * The agent pays for things off-chain from its own float. To be reimbursed,
 * anyone submits a SpendLog proof. The contract checks that the proof
 * continues exactly from the last settled state, under the current policy,
 * in a period that has started, and then pays the agent the amount the proof
 * covers. The policy itself (allowlist, caps, agent key) stays private; only
 * its hash is on-chain.
 *
 * State: 8 fields (owner 2, agent 2, policyHash, period, spent, receipts).
 */
export class Allowance extends SmartContract {
  @state(PublicKey) owner = State<PublicKey>();
  @state(PublicKey) agent = State<PublicKey>();
  @state(Field) policyHash = State<Field>();
  @state(UInt32) period = State<UInt32>();
  @state(UInt64) spent = State<UInt64>();
  @state(Field) receipts = State<Field>();

  events = {
    'mandate-set': MandateSet,
    settled: Settled,
    withdrawn: UInt64,
  };

  /**
   * Locks the contract's code and permissions after deploy, so an agent
   * relying on reimbursement knows these rules cannot change under it.
   */
  async deploy() {
    await super.deploy();
    this.account.permissions.set({
      ...Permissions.default(),
      setVerificationKey: Permissions.VerificationKey.impossibleDuringCurrentVersion(),
      setPermissions: Permissions.impossible(),
    });
  }

  /** Call in the same transaction as `deploy`, or anyone could claim ownership first. */
  @method async initialize(owner: PublicKey, agent: PublicKey, policyHash: Field) {
    this.account.provedState.getAndRequireEquals().assertFalse('already initialized');
    // provedState only turns true once a proof has written *every* state
    // field. Setting just our 8 would leave it false, and anyone could call
    // initialize again to take ownership. super.init() writes all of them.
    super.init();
    AccountUpdate.createSigned(owner);
    this.owner.set(owner);
    this.writeMandate(agent, policyHash);
  }

  /**
   * Rotate the policy or the agent. Any spend log proven under the old policy
   * stops settling at once. The period's spent total carries over, so rotating
   * mid-day doesn't reset the cap.
   */
  @method async setMandate(agent: PublicKey, policyHash: Field) {
    this.requireOwner();
    this.writeMandate(agent, policyHash);
  }

  /** Owner takes unspent budget back. */
  @method async withdraw(amount: UInt64) {
    const owner = this.requireOwner();
    this.send({ to: owner, amount });
    this.emitEvent('withdrawn', amount);
  }

  @method async settle(proof: SpendLogProof) {
    proof.verify();
    const start = proof.publicInput;
    const end = proof.publicOutput;

    const policyHash = this.policyHash.getAndRequireEquals();
    const period = this.period.getAndRequireEquals();
    const spent = this.spent.getAndRequireEquals();
    const receipts = this.receipts.getAndRequireEquals();
    const agent = this.agent.getAndRequireEquals();

    start.policyHash.assertEquals(policyHash, 'proof is for a different mandate');
    start.receipts.assertEquals(receipts, 'proof does not continue the settled log');
    end.receipts.assertNotEquals(start.receipts, 'proof contains no spends');

    // A log may continue the current period or open a later one, which
    // resets the period total to zero. It may not reopen a closed period.
    start.period.assertGreaterThanOrEqual(period, 'period is already closed');
    const samePeriod = start.period.equals(period);
    start.spent.value.assertEquals(
      Provable.if(samePeriod, UInt64, spent, UInt64.zero).value,
      'proof starts from the wrong period total'
    );

    // Can't settle a period that hasn't started, or an agent could draw
    // future days' budgets today.
    this.currentSlot.requireBetween(start.period.mul(SLOTS_PER_PERIOD), UInt32.MAXINT());

    const paid = end.spent.sub(start.spent);
    this.send({ to: agent, amount: paid });

    this.period.set(end.period);
    this.spent.set(end.spent);
    this.receipts.set(end.receipts);
    this.emitEvent(
      'settled',
      new Settled({ period: end.period, spent: end.spent, paid, receipts: end.receipts })
    );
  }

  private requireOwner(): PublicKey {
    const owner = this.owner.getAndRequireEquals();
    AccountUpdate.createSigned(owner);
    return owner;
  }

  private writeMandate(agent: PublicKey, policyHash: Field) {
    this.agent.set(agent);
    this.policyHash.set(policyHash);
    this.emitEvent('mandate-set', new MandateSet({ agent, policyHash }));
  }
}
