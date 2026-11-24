import { Provable, SelfProof, Signature, ZkProgram } from 'o1js';
import {
  AllowlistWitness,
  Ledger,
  Policy,
  Spend,
  hashPolicy,
  nextReceipts,
  payeeLeaf,
  spendMessage,
} from './mandate.js';

/**
 * A recursive proof over an agent's spend log.
 *
 * `open` starts a log at some ledger state. Each `append` verifies the
 * previous proof, checks one more spend against the hidden policy, and
 * advances the ledger. However many spends the log holds, the result is one
 * constant-size proof that says: starting from `publicInput`, every spend was
 * signed by the mandated agent, paid an allowlisted payee, stayed under the
 * per-spend cap, and kept the period total under the period cap, ending at
 * `publicOutput`.
 */
export const SpendLog = ZkProgram({
  name: 'allowance-spend-log',
  publicInput: Ledger,
  publicOutput: Ledger,

  methods: {
    open: {
      privateInputs: [],
      async method(start: Ledger): Promise<{ publicOutput: Ledger }> {
        return { publicOutput: start };
      },
    },

    append: {
      privateInputs: [SelfProof, Policy, Spend, Signature, AllowlistWitness],
      async method(
        start: Ledger,
        prev: SelfProof<Ledger, Ledger>,
        policy: Policy,
        spend: Spend,
        signature: Signature,
        witness: AllowlistWitness
      ): Promise<{ publicOutput: Ledger }> {
        prev.verify();
        // Every step in the chain must share the same starting point, so the
        // final proof's public input is where the whole log began.
        Provable.assertEqual(Ledger, prev.publicInput, start);
        const at = prev.publicOutput;

        hashPolicy(policy).assertEquals(at.policyHash, 'policy does not match the mandate');

        witness
          .calculateRoot(payeeLeaf(spend.payee))
          .assertEquals(policy.allowlistRoot, 'payee is not on the allowlist');

        spend.amount.assertLessThanOrEqual(policy.perSpendCap, 'spend is over the per-spend cap');

        const spent = at.spent.add(spend.amount);
        spent.assertLessThanOrEqual(policy.periodCap, 'spend would exceed the period cap');

        signature
          .verify(policy.agent, spendMessage(at, spend))
          .assertTrue('spend is not signed by the mandated agent');

        return {
          publicOutput: new Ledger({
            policyHash: at.policyHash,
            period: at.period,
            spent,
            receipts: nextReceipts(at.receipts, spend),
          }),
        };
      },
    },
  },
});

export class SpendLogProof extends ZkProgram.Proof(SpendLog) {}
