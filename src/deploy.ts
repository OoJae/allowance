import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import {
  AccountUpdate,
  Cache,
  Field,
  Lightnet,
  Mina,
  PrivateKey,
  PublicKey,
  UInt64,
  fetchAccount,
  fetchCurrentSlot,
} from 'o1js';
import { Allowance, periodOfSlot } from './allowance.js';
import { Mandate } from './mandate.js';
import { SpendLog } from './spend-log.js';
import { SpendSession, auditReceipts, ledgerFor } from './session.js';

// Deploy Allowance to a live network, prove a real spend log and settle it.
//
//   NETWORK=devnet   npm run deploy   # public devnet; fund the owner from the faucet first
//   NETWORK=lightnet npm run deploy   # local network from `zk lightnet start`
//
// Keys and the private policy are saved under keys/ (gitignored), so re-runs reuse
// the same contract. Addresses and transaction hashes go to deployments/.

const NETWORK = (process.env.NETWORK ?? 'devnet') as 'devnet' | 'lightnet';
const NETWORKS = {
  devnet: {
    mina: process.env.MINA_GRAPHQL ?? 'https://api.minascan.io/node/devnet/v1/graphql',
    explorer: 'https://minascan.io/devnet',
  },
  lightnet: {
    mina: process.env.MINA_GRAPHQL ?? 'http://127.0.0.1:8080/graphql',
    accountManager: 'http://127.0.0.1:8181',
    explorer: undefined,
  },
} as const;
const config = NETWORKS[NETWORK];
if (!config) throw new Error(`unknown NETWORK ${NETWORK}`);

const FEE = 100_000_000; // 0.1 MINA
const BUDGET = 3;
const mina = (n: number) => UInt64.from(BigInt(Math.round(n * 1e9)));
const WAIT = { maxAttempts: 90, interval: 20_000 }; // up to 30 min; devnet blocks are ~3 min

type Keys = { owner: string; zkApp: string; agent: string; payees: string[]; salt: string };

async function loadKeys(): Promise<Keys> {
  const file = `keys/${NETWORK}.json`;
  if (existsSync(file)) return JSON.parse(readFileSync(file, 'utf8'));
  const owner =
    NETWORK === 'lightnet'
      ? (await Lightnet.acquireKeyPair({ lightnetAccountManagerEndpoint: NETWORKS.lightnet.accountManager })).privateKey
      : PrivateKey.random();
  const keys: Keys = {
    owner: owner.toBase58(),
    zkApp: PrivateKey.random().toBase58(),
    agent: PrivateKey.random().toBase58(),
    payees: [PrivateKey.random(), PrivateKey.random()].map((k) => k.toPublicKey().toBase58()),
    salt: Field.random().toString(),
  };
  mkdirSync('keys', { recursive: true });
  writeFileSync(file, JSON.stringify(keys, null, 2), { mode: 0o600 });
  console.log(`created ${file} (private keys and policy salt, keep it out of git)`);
  return keys;
}

function link(kind: 'account' | 'tx', id: string) {
  return config.explorer ? `${config.explorer}/${kind}/${id}` : id;
}

Mina.setActiveInstance(
  Mina.Network({
    networkId: 'devnet',
    mina: config.mina,
    ...(NETWORK === 'lightnet' ? { lightnetAccountManager: NETWORKS.lightnet.accountManager } : {}),
  })
);

const keys = await loadKeys();
const ownerKey = PrivateKey.fromBase58(keys.owner);
const zkAppKey = PrivateKey.fromBase58(keys.zkApp);
const agentKey = PrivateKey.fromBase58(keys.agent);
const owner = ownerKey.toPublicKey();
const agent = agentKey.toPublicKey();
const payees = keys.payees.map((p) => PublicKey.fromBase58(p));
const zkApp = new Allowance(zkAppKey.toPublicKey());
const mandate = new Mandate({
  agent,
  payees,
  perSpendCap: mina(1),
  periodCap: mina(2),
  salt: Field(keys.salt),
});

console.log(`network  ${NETWORK} (${config.mina})`);
console.log(`owner    ${owner.toBase58()}`);
console.log(`zkApp    ${zkApp.address.toBase58()}`);
console.log(`agent    ${agent.toBase58()}`);

const ownerAccount = await fetchAccount({ publicKey: owner });
if (ownerAccount.error) {
  console.log(`\nCould not load the owner account: ${ownerAccount.error.statusCode} ${ownerAccount.error.statusText}`);
  console.log(`If ${NETWORK} is up, the account has no funds yet.`);
  if (NETWORK === 'devnet') console.log(`Fund it, then re-run: https://faucet.minaprotocol.com/?address=${owner.toBase58()}`);
  process.exit(2);
}
console.log(`balance  ${Number(ownerAccount.account!.balance.toBigInt()) / 1e9} MINA\n`);

const cache = Cache.FileSystem('./cache');
console.time('compile');
await SpendLog.compile({ cache });
await Allowance.compile({ cache });
console.timeEnd('compile');

const record: Record<string, unknown> = {
  network: NETWORK,
  endpoint: config.mina,
  zkApp: zkApp.address.toBase58(),
  owner: owner.toBase58(),
  agent: agent.toBase58(),
  policyHash: mandate.hash.toString(),
};

if ((await fetchAccount({ publicKey: zkApp.address })).error) {
  const agentExists = !(await fetchAccount({ publicKey: agent })).error;
  console.log('deploying: deploy + initialize + fund budget' + (agentExists ? '' : ' + open agent account'));
  const tx = await Mina.transaction({ sender: owner, fee: FEE }, async () => {
    AccountUpdate.fundNewAccount(owner, agentExists ? 1 : 2);
    await zkApp.deploy();
    await zkApp.initialize(owner, agent, mandate.hash);
    const pay = AccountUpdate.createSigned(owner);
    pay.send({ to: zkApp.address, amount: mina(BUDGET) });
    if (!agentExists) pay.send({ to: agent, amount: mina(0.1) });
  });
  await tx.prove();
  const pending = await tx.sign([ownerKey, zkAppKey]).send();
  console.log(`  sent ${link('tx', pending.hash)}`);
  await pending.wait(WAIT);
  console.log('  included');
  record.deployTx = pending.hash;
} else {
  console.log('zkApp already deployed, reusing it');
}

await fetchAccount({ publicKey: zkApp.address });
await fetchAccount({ publicKey: agent });
const slot = await fetchCurrentSlot();
const period = periodOfSlot(slot);
console.log(`\nslot ${slot}, period ${period}: proving a spend log`);
const session = await SpendSession.open(mandate, agentKey, ledgerFor(zkApp, period));
const room = mandate.policy.periodCap.sub(session.ledger.spent).toBigInt();
const spends: [number, number][] = [
  [0, 0.6],
  [1, 0.4],
].filter(([, amount]) => mina(amount).toBigInt() <= room) as [number, number][];
if (spends.length === 0) {
  console.log('the period cap is already used up; wait for the next period (24h) and re-run');
  process.exit(0);
}
for (const [i, amount] of spends) {
  console.time(`  prove spend ${amount} MINA`);
  await session.spend(payees[i], mina(amount), Field(Date.now()));
  console.timeEnd(`  prove spend ${amount} MINA`);
}

const before = Mina.getBalance(agent).toBigInt();
const tx = await Mina.transaction({ sender: owner, fee: FEE }, async () => {
  await zkApp.settle(session.proofOfLog);
});
await tx.prove();
const pending = await tx.sign([ownerKey]).send();
console.log(`settling ${link('tx', pending.hash)}`);
await pending.wait(WAIT);
record.settleTx = pending.hash;

await fetchAccount({ publicKey: zkApp.address });
await fetchAccount({ publicKey: agent });
const paid = Mina.getBalance(agent).toBigInt() - before;
const receipts = zkApp.receipts.get();
console.log(`  included: agent reimbursed ${Number(paid) / 1e9} MINA`);
console.log(`  on-chain spent ${Number(zkApp.spent.get().toBigInt()) / 1e9} MINA in period ${zkApp.period.get()}`);
console.log(
  `  receipts ${auditReceipts(session.start.receipts, session.spends).equals(receipts).toBoolean() ? 'match' : 'DO NOT match'} the agent's records`
);
console.log(`\ncontract: ${link('account', zkApp.address.toBase58())}`);

mkdirSync('deployments', { recursive: true });
const out = `deployments/${NETWORK}.json`;
const previous = existsSync(out) ? JSON.parse(readFileSync(out, 'utf8')) : {};
writeFileSync(
  out,
  JSON.stringify({ ...previous, ...record, settlements: [...(previous.settlements ?? []), { tx: pending.hash, period: period.toString(), paid: paid.toString() }] }, null, 2) + '\n'
);
console.log(`wrote ${out}`);
