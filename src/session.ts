import { Field, PrivateKey, PublicKey, Signature, UInt32, UInt64 } from 'o1js';
import type { Allowance } from './allowance.js';
import { AllowlistWitness, Ledger, Mandate, Spend, nextReceipts, signSpend } from './mandate.js';
import { SpendLog, SpendLogProof } from './spend-log.js';

/**
 * The ledger a new spend log must start from to settle in `period`:
 * continue the on-chain total if it is the same period, else start at zero.
 * Reads local contract state, so on a live network call `fetchAccount` first.
 */
export function ledgerFor(zkApp: Allowance, period: UInt32): Ledger {
  const samePeriod = period.equals(zkApp.period.get()).toBoolean();
  return new Ledger({
    policyHash: zkApp.policyHash.get(),
    period,
    spent: samePeriod ? zkApp.spent.get() : UInt64.zero,
    receipts: zkApp.receipts.get(),
  });
}

/**
 * Owner-side audit: recompute the receipts chain from the agent's spend
 * records. If it matches on-chain `receipts`, the records are complete and
 * untampered, with nothing missing, added or reordered.
 */
export function auditReceipts(from: Field, spends: Spend[]): Field {
  return spends.reduce((receipts, spend) => nextReceipts(receipts, spend), from);
}

/** Agent-side: sign each spend as it happens and fold it into one recursive proof. */
export class SpendSession {
  readonly spends: Spend[] = [];

  private constructor(
    readonly mandate: Mandate,
    private readonly agentKey: PrivateKey,
    readonly start: Ledger,
    private proof: SpendLogProof
  ) {}

  static async open(mandate: Mandate, agentKey: PrivateKey, start: Ledger): Promise<SpendSession> {
    const { proof } = await SpendLog.open(start);
    return new SpendSession(mandate, agentKey, start, proof);
  }

  /** Ledger after every spend so far. */
  get ledger(): Ledger {
    return this.proof.publicOutput;
  }

  /** One proof covering every spend in the session. Pass it to `Allowance.settle`. */
  get proofOfLog(): SpendLogProof {
    return this.proof;
  }

  async spend(payee: PublicKey, amount: UInt64, memo = Field(0)): Promise<SpendLogProof> {
    const spend = new Spend({ payee, amount, memo });
    const signature = signSpend(this.agentKey, this.ledger, spend);
    return this.append(spend, signature, this.mandate.witness(payee));
  }

  /** Low-level step with a caller-supplied signature and witness. */
  async append(spend: Spend, signature: Signature, witness: AllowlistWitness): Promise<SpendLogProof> {
    const { proof } = await SpendLog.append(
      this.start,
      this.proof,
      this.mandate.policy,
      spend,
      signature,
      witness
    );
    this.proof = proof;
    this.spends.push(spend);
    return proof;
  }
}
