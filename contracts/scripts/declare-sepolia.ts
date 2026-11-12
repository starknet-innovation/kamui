// Declares KamuiAccount on Starknet Sepolia. Testnet only.
//
//   bun --env-file=<file with RPC_URL, RELAYER_ADDRESS, RELAYER_PRIVATE_KEY> run declare-sepolia.ts
//
// Estimates the fee first and stops if it is above MAX_FEE_STRK. Prints the class hash.
import { Account, RpcProvider, config, json } from 'starknet';

const MAX_FEE_STRK = 300;
const ARTIFACT = `${import.meta.dir}/../target/dev/kamui_KamuiAccount`;

const env = (name: string) => {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set`);
  return value;
};

const provider = new RpcProvider({ nodeUrl: env('RPC_URL') });
if ((await provider.getChainId()) !== '0x534e5f5345504f4c4941') throw new Error('Sepolia only');

// starknet.js pads the estimate by 1.5x on amount and price. 10% keeps the cap near the real cost.
const margin = { max_amount: 10, max_price_per_unit: 10 };
config.set('resourceBoundsOverhead', { l1_gas: margin, l2_gas: margin, l1_data_gas: margin });

const account = new Account({ provider, address: env('RELAYER_ADDRESS'), signer: env('RELAYER_PRIVATE_KEY') });
const contract = json.parse(await Bun.file(`${ARTIFACT}.contract_class.json`).text());
const casm = json.parse(await Bun.file(`${ARTIFACT}.compiled_contract_class.json`).text());

const estimate = (await account.estimateDeclareFee({ contract, casm }).catch((e: Error) => e)) as any;
if (estimate instanceof Error) {
  if (/already declared|CLASS_ALREADY_DECLARED/i.test(estimate.message)) {
    console.log('already declared');
  } else {
    throw estimate;
  }
} else {
  const fee = Number(BigInt(estimate.overall_fee)) / 1e18;
  console.log(`estimated fee: ${fee.toFixed(2)} STRK`);
  if (fee > MAX_FEE_STRK) throw new Error(`above the ${MAX_FEE_STRK} STRK limit, not sending`);
}

const { class_hash, transaction_hash } = await account.declareIfNot({ contract, casm });
console.log(`class hash ${class_hash}`);
if (transaction_hash) {
  console.log(`tx ${transaction_hash}`);
  const receipt = (await provider.waitForTransaction(transaction_hash)) as any;
  console.log(`status ${receipt.execution_status}, fee ${(Number(BigInt(receipt.actual_fee.amount)) / 1e18).toFixed(2)} STRK`);
} else {
  console.log('nothing sent: the class was already declared');
}
