import {
  Field,
  MerkleTree,
  MerkleWitness,
  Poseidon,
  PrivateKey,
  PublicKey,
  Signature,
  Struct,
  UInt32,
  UInt64,
} from 'o1js';

/** Allowlist tree height. A tree of height h has 2^(h-1) leaves, so 128 payees. */
export const ALLOWLIST_HEIGHT = 8;
export const MAX_PAYEES = 2 ** (ALLOWLIST_HEIGHT - 1);

export class AllowlistWitness extends MerkleWitness(ALLOWLIST_HEIGHT) {}

/**
 * The owner's spending policy for one agent. It never goes on-chain: the
 * contract stores only `hashPolicy(policy)`. The random salt stops anyone
 * from brute-forcing the caps, which are low-entropy numbers.
 */
export class Policy extends Struct({
  agent: PublicKey,
  allowlistRoot: Field,
  perSpendCap: UInt64,
  periodCap: UInt64,
  salt: Field,
}) {}

/** One payment the agent made off-chain, such as an API call or an x402 invoice. */
export class Spend extends Struct({
  payee: PublicKey,
  amount: UInt64,
  /** Free-form reference, such as a hash of the invoice or receipt. */
  memo: Field,
}) {}

/**
 * The running state of an agent's spend log. The Allowance contract stores
 * the same four values, so a proof's public input can be checked against
 * on-chain state field by field.
 */
export class Ledger extends Struct({
  policyHash: Field,
  /** Settlement period (a day by default), counted from genesis. */
  period: UInt32,
  /** Total spent in `period` so far. */
  spent: UInt64,
  /** Hash chain over every spend ever settled under this contract. */
  receipts: Field,
}) {}

export function hashPolicy(policy: Policy): Field {
  return Poseidon.hash(Policy.toFields(policy));
}

export function payeeLeaf(payee: PublicKey): Field {
  return Poseidon.hash(payee.toFields());
}

export function hashSpend(spend: Spend): Field {
  return Poseidon.hash(Spend.toFields(spend));
}

export function nextReceipts(receipts: Field, spend: Spend): Field {
  return Poseidon.hash([receipts, hashSpend(spend)]);
}

/**
 * What the agent signs for each spend. Including `receipts` pins the
 * signature to one position in the log, so it cannot be replayed later in
 * the chain or under another mandate.
 */
export function spendMessage(at: Ledger, spend: Spend): Field[] {
  return [at.policyHash, at.period.value, at.receipts, ...Spend.toFields(spend)];
}

export function signSpend(agentKey: PrivateKey, at: Ledger, spend: Spend): Signature {
  return Signature.create(agentKey, spendMessage(at, spend));
}

/** Off-chain helper the owner uses to build a policy and hand out allowlist witnesses. */
export class Mandate {
  readonly policy: Policy;
  readonly hash: Field;
  private readonly tree = new MerkleTree(ALLOWLIST_HEIGHT);
  private readonly index = new Map<string, bigint>();

  constructor(opts: {
    agent: PublicKey;
    payees: PublicKey[];
    perSpendCap: UInt64;
    periodCap: UInt64;
    salt?: Field;
  }) {
    if (opts.payees.length > MAX_PAYEES) {
      throw new Error(`at most ${MAX_PAYEES} payees, got ${opts.payees.length}`);
    }
    opts.payees.forEach((payee, i) => {
      this.tree.setLeaf(BigInt(i), payeeLeaf(payee));
      this.index.set(payee.toBase58(), BigInt(i));
    });
    this.policy = new Policy({
      agent: opts.agent,
      allowlistRoot: this.tree.getRoot(),
      perSpendCap: opts.perSpendCap,
      periodCap: opts.periodCap,
      salt: opts.salt ?? Field.random(),
    });
    this.hash = hashPolicy(this.policy);
  }

  allows(payee: PublicKey): boolean {
    return this.index.has(payee.toBase58());
  }

  witness(payee: PublicKey): AllowlistWitness {
    const i = this.index.get(payee.toBase58());
    if (i === undefined) throw new Error(`payee ${payee.toBase58()} is not on the allowlist`);
    return new AllowlistWitness(this.tree.getWitness(i));
  }

  /** Witness for an arbitrary leaf slot. Only useful for testing rejections. */
  witnessAt(index: number): AllowlistWitness {
    return new AllowlistWitness(this.tree.getWitness(BigInt(index)));
  }
}
