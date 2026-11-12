/** Operator-only signer. No secret-key input, AWS mutations, RPC or broadcast path. */
import { KMSClient, GetPublicKeyCommand, SignCommand,
  type GetPublicKeyCommandOutput, type SignCommandOutput } from '@aws-sdk/client-kms';
import { secp256k1 } from '@noble/curves/secp256k1';
import { CallData, constants, hash, stark, transaction,
  type SignerInterface, type Signature, type Call, type InvocationsSignerDetails,
  type DeployAccountSignerDetails, type DeclareSignerDetails, type TypedData } from 'starknet';
const N = secp256k1.CURVE.n;
const MASK = (1n << 128n) - 1n;
const FIELD = (1n << 251n) + 17n * (1n << 192n) + 1n;
export interface KmsPort {
  getPublicKey(keyId: string): Promise<GetPublicKeyCommandOutput>;
  sign(keyId: string, digest: Uint8Array): Promise<SignCommandOutput>;
}
export interface Review {
  kind: 'invoke' | 'deploy'; hash: string; account: string; chainId: string;
  maxFeeFri: string; details: InvocationsSignerDetails | DeployAccountSignerDetails; calls?: Call[];
}
export interface Config {
  /** Immutable key ARN, never an alias; actual value stays in private local configuration. */
  keyId: string;
  /** Uncompressed SEC1 key (0x04 + x + y), independently checked against the account. */
  publicKey: string;
  accountAddress: string; classHash: string; maxFeeFri: bigint;
  /** Explicit review of each complete transaction, including query estimates. */
  approve: (review: Review) => Promise<boolean>;
}
export function awsKmsPort(region: string): KmsPort {
  if (!region) throw new Error('KMS_REGION_REQUIRED');
  const client = new KMSClient({ region, maxAttempts: 1 });
  return {
    getPublicKey: keyId => client.send(new GetPublicKeyCommand({ KeyId: keyId }),
      { abortSignal: AbortSignal.timeout(15_000) }),
    sign: (keyId, digest) => client.send(new SignCommand({ KeyId: keyId,
      Message: digest, MessageType: 'DIGEST', SigningAlgorithm: 'ECDSA_SHA_256' }),
      { abortSignal: AbortSignal.timeout(15_000) }),
  };
}
/** Never SHA256 again or add an Ethereum personal-message prefix. */
export function digestBytes(value: string): Uint8Array {
  const n = BigInt(value);
  if (n < 0n || n >= FIELD) throw new Error('KMS_HASH_INVALID');
  return Uint8Array.from(Buffer.from(n.toString(16).padStart(64, '0'), 'hex'));
}
export function signatureFelts(der: Uint8Array): string[] {
  try {
    const { r, s } = secp256k1.Signature.fromDER(der).normalizeS();
    if (r <= 0n || r >= N || s <= 0n || s > N / 2n) throw new Error();
    return [r & MASK, r >> 128n, s & MASK, s >> 128n].map(n => `0x${n.toString(16)}`);
  } catch { throw new Error('KMS_SIGNATURE_INVALID'); }
}
function spkiKey(bytes: Uint8Array): string {
  // Canonical RFC 5280 SPKI: id-ecPublicKey, namedCurve secp256k1, uncompressed SEC1.
  // Accept this exact DER structure only; no BER, arbitrary OIDs or trailing bytes.
  const prefix = Buffer.from('3056301006072a8648ce3d020106052b8104000a034200', 'hex');
  if (bytes.length !== prefix.length + 65
    || !Buffer.from(bytes.subarray(0, prefix.length)).equals(prefix)
    || bytes[prefix.length] !== 4) throw new Error('KMS_PUBLIC_KEY_INVALID');
  const point = bytes.subarray(prefix.length);
  try { secp256k1.ProjectivePoint.fromHex(point).assertValidity(); }
  catch { throw new Error('KMS_PUBLIC_KEY_INVALID'); }
  return `0x${Buffer.from(point).toString('hex')}`;
}
function felt(value: string): bigint {
  const n = BigInt(value);
  if (n <= 0n || n >= FIELD) throw new Error('KMS_CONFIG_INVALID');
  return n;
}
export class KmsK1Signer implements SignerInterface {
  private readonly config: Config;
  constructor(private readonly kms: KmsPort, config: Config) {
    if (!/^arn:[a-z-]+:kms:[a-z0-9-]+:\d{12}:key\/[0-9a-f-]{36}$/.test(config.keyId)
      || !/^0x04[0-9a-f]{128}$/i.test(config.publicKey) || config.maxFeeFri <= 0n)
      throw new Error('KMS_CONFIG_INVALID');
    secp256k1.ProjectivePoint.fromHex(config.publicKey.slice(2)).assertValidity();
    felt(config.accountAddress); felt(config.classHash);
    this.config = { ...config, publicKey: config.publicKey.toLowerCase() };
  }
  async getPubKey(): Promise<string> {
    let output: GetPublicKeyCommandOutput;
    try { output = await this.kms.getPublicKey(this.config.keyId); }
    catch { throw new Error('KMS_PUBLIC_KEY_UNAVAILABLE'); }
    if (output.KeyId !== this.config.keyId || output.KeySpec !== 'ECC_SECG_P256K1'
      || output.KeyUsage !== 'SIGN_VERIFY' || !output.SigningAlgorithms?.includes('ECDSA_SHA_256')
      || !output.PublicKey) throw new Error('KMS_KEY_METADATA_INVALID');
    if (spkiKey(output.PublicKey) !== this.config.publicKey) throw new Error('KMS_PUBLIC_KEY_MISMATCH');
    return `0x${this.config.publicKey.slice(4)}`;
  }
  constructorCalldata(): string[] {
    const x = BigInt(`0x${this.config.publicKey.slice(4, 68)}`);
    const y = BigInt(`0x${this.config.publicKey.slice(68)}`);
    return [x & MASK, x >> 128n, y & MASK, y >> 128n].map(String);
  }
  private check(details: InvocationsSignerDetails | DeployAccountSignerDetails): bigint {
    if (BigInt(details.chainId) !== BigInt(constants.StarknetChainId.SN_SEPOLIA)
      || ![3n, (1n << 128n) + 3n].includes(BigInt(details.version)))
      throw new Error('KMS_TRANSACTION_DOMAIN_INVALID');
    const integer = (value: unknown, bits: bigint) => {
      if (typeof value !== 'bigint' && typeof value !== 'string' && typeof value !== 'number')
        throw new Error('KMS_FEE_INVALID');
      if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('KMS_FEE_INVALID');
      const n = BigInt(value);
      if (n < 0n || n >= 1n << bits) throw new Error('KMS_FEE_INVALID');
      return n;
    };
    const tip = integer(details.tip, 64n);
    let maximum = 0n;
    for (const name of ['l1_gas', 'l2_gas', 'l1_data_gas'] as const) {
      const resource = details.resourceBounds[name];
      if (!resource) throw new Error('KMS_FEE_INVALID');
      const amount = integer(resource.max_amount, 64n);
      maximum += amount * integer(resource.max_price_per_unit, 128n);
      if (name === 'l2_gas') maximum += amount * tip;
    }
    if (maximum > this.config.maxFeeFri) throw new Error('KMS_FEE_LIMIT');
    return maximum;
  }
  private async sign(review: Review): Promise<string[]> {
    if (await this.config.approve(structuredClone(review)) !== true) throw new Error('KMS_NOT_APPROVED');
    await this.getPubKey();
    const digest = digestBytes(review.hash);
    let result: SignCommandOutput;
    try { result = await this.kms.sign(this.config.keyId, digest); }
    catch { throw new Error('KMS_SIGN_UNAVAILABLE'); }
    if (result.KeyId !== this.config.keyId || result.SigningAlgorithm !== 'ECDSA_SHA_256'
      || !result.Signature) throw new Error('KMS_SIGNATURE_INVALID');
    const felts = signatureFelts(result.Signature);
    const r = BigInt(felts[0]) + (BigInt(felts[1]) << 128n);
    const s = BigInt(felts[2]) + (BigInt(felts[3]) << 128n);
    if (!secp256k1.verify(new secp256k1.Signature(r, s), digest, this.config.publicKey.slice(2)))
      throw new Error('KMS_SIGNATURE_INVALID');
    return felts;
  }
  async signTransaction(calls: Call[], input: InvocationsSignerDetails): Promise<Signature> {
    const details = structuredClone(input), snapshot = structuredClone(calls);
    const maximum = this.check(details);
    if (BigInt(details.walletAddress) !== BigInt(this.config.accountAddress) || details.cairoVersion !== '1')
      throw new Error('KMS_ACCOUNT_MISMATCH');
    const txHash = hash.calculateInvokeTransactionHash({ ...details,
      senderAddress: details.walletAddress,
      compiledCalldata: transaction.getExecuteCalldata(snapshot, '1'),
      nonceDataAvailabilityMode: stark.intDAM(details.nonceDataAvailabilityMode),
      feeDataAvailabilityMode: stark.intDAM(details.feeDataAvailabilityMode) });
    return this.sign({ kind: 'invoke', hash: txHash, account: this.config.accountAddress,
      chainId: String(details.chainId), maxFeeFri: String(maximum), details, calls: snapshot });
  }
  async signDeployAccountTransaction(input: DeployAccountSignerDetails): Promise<Signature> {
    const details = structuredClone(input);
    const maximum = this.check(details);
    const calldata = CallData.compile(details.constructorCalldata);
    const address = hash.calculateContractAddressFromHash(details.addressSalt, details.classHash, calldata, 0);
    if (BigInt(details.contractAddress) !== BigInt(address)
      || BigInt(details.classHash) !== BigInt(this.config.classHash)
      || BigInt(address) !== BigInt(this.config.accountAddress)
      || calldata.length !== 4 || calldata.some((v, i) => BigInt(v) !== BigInt(this.constructorCalldata()[i])))
      throw new Error('KMS_DEPLOYMENT_MISMATCH');
    const txHash = hash.calculateDeployAccountTransactionHash({ ...details,
      salt: details.addressSalt, compiledConstructorCalldata: calldata,
      nonceDataAvailabilityMode: stark.intDAM(details.nonceDataAvailabilityMode),
      feeDataAvailabilityMode: stark.intDAM(details.feeDataAvailabilityMode) });
    return this.sign({ kind: 'deploy', hash: txHash, account: address,
      chainId: String(details.chainId), maxFeeFri: String(maximum), details });
  }
  async signMessage(_data: TypedData, _address: string): Promise<Signature> {
    throw new Error('KMS_MESSAGE_SIGNING_DISABLED');
  }
  async signDeclareTransaction(_details: DeclareSignerDetails): Promise<Signature> {
    throw new Error('KMS_DECLARE_SIGNING_DISABLED');
  }
}
