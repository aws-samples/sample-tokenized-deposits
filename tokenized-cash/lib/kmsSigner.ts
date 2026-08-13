import { KMSClient, SignCommand, GetPublicKeyCommand } from "@aws-sdk/client-kms";
import {
  keccak256,
  getBytes,
  hexlify,
  Signature,
  SigningKey,
  recoverAddress,
  AbstractSigner,
  Transaction,
  TransactionRequest,
  Provider,
  TypedDataDomain,
  TypedDataField,
} from "ethers";
import * as asn1js from "asn1js";

const SECP256K1_N = BigInt("0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141");
const SECP256K1_N_HALF = SECP256K1_N / 2n;

export class KmsSigner {
  private keyId: string;
  private kms: KMSClient;
  private cachedAddress: string | null = null;
  private cachedPubKeyUncompressed: Uint8Array | null = null;

  constructor(keyId: string, region?: string) {
    this.keyId = keyId;
    this.kms = new KMSClient({ region });
  }

  async getAddress(): Promise<string> {
    if (this.cachedAddress) return this.cachedAddress;
    await this.loadPublicKey();
    return this.cachedAddress!;
  }

  private async loadPublicKey(): Promise<void> {
    const response = await this.kms.send(
      new GetPublicKeyCommand({ KeyId: this.keyId })
    );
    if (!response.PublicKey) throw new Error("No public key returned from KMS");

    const pubKeyBytes = this.parseSpkiPublicKey(response.PublicKey);
    this.cachedPubKeyUncompressed = pubKeyBytes;

    // Address = last 20 bytes of keccak256(uncompressed_pub_without_04_prefix)
    const hash = keccak256(pubKeyBytes.slice(1)); // skip 0x04 prefix
    this.cachedAddress = "0x" + hash.slice(-40);
  }

  private parseSpkiPublicKey(der: Uint8Array): Uint8Array {
    const asn1Result = asn1js.fromBER(new Uint8Array(der).buffer as ArrayBuffer);
    if (asn1Result.offset === -1) throw new Error("Failed to parse ASN.1 public key");

    const seq = asn1Result.result as asn1js.Sequence;
    const bitString = seq.valueBlock.value[1] as asn1js.BitString;
    const pubKeyBytes = new Uint8Array(bitString.valueBlock.valueHexView);

    if (pubKeyBytes.length !== 65 || pubKeyBytes[0] !== 0x04) {
      throw new Error("Expected uncompressed secp256k1 public key (65 bytes, 0x04 prefix)");
    }
    return pubKeyBytes;
  }

  async signDigest(digest: string | Uint8Array): Promise<{
    signature: string;
    signer: string;
    r: string;
    s: string;
    v: number;
  }> {
    const digestBytes = typeof digest === "string" ? getBytes(digest) : digest;
    if (digestBytes.length !== 32) throw new Error("digest must be 32 bytes");

    const response = await this.kms.send(
      new SignCommand({
        KeyId: this.keyId,
        Message: digestBytes,
        MessageType: "DIGEST",
        SigningAlgorithm: "ECDSA_SHA_256",
      })
    );
    if (!response.Signature) throw new Error("No signature returned from KMS");

    let { r, s } = this.parseDerSignature(response.Signature);

    // Normalize to low-s
    if (s > SECP256K1_N_HALF) {
      s = SECP256K1_N - s;
    }

    // Determine v by trial recovery
    const signer = await this.getAddress();
    let v: number | null = null;

    for (const recId of [0, 1]) {
      const recovered = this.recoverAddress(digestBytes, r, s, recId);
      if (recovered.toLowerCase() === signer.toLowerCase()) {
        v = recId + 27;
        break;
      }
    }
    if (v === null) throw new Error("Unable to determine recovery id (v)");

    const sigHex = this.signatureToHex(r, s, v);

    return { signature: sigHex, signer, r: "0x" + r.toString(16), s: "0x" + s.toString(16), v };
  }

  private parseDerSignature(der: Uint8Array): { r: bigint; s: bigint } {
    const asn1Result = asn1js.fromBER(new Uint8Array(der).buffer as ArrayBuffer);
    if (asn1Result.offset === -1) throw new Error("Failed to parse DER signature");

    const seq = asn1Result.result as asn1js.Sequence;
    const rInt = seq.valueBlock.value[0] as asn1js.Integer;
    const sInt = seq.valueBlock.value[1] as asn1js.Integer;

    const rHex = Buffer.from(rInt.valueBlock.valueHexView).toString("hex");
    const sHex = Buffer.from(sInt.valueBlock.valueHexView).toString("hex");

    return { r: BigInt("0x" + rHex), s: BigInt("0x" + sHex) };
  }

  private recoverAddress(digest: Uint8Array, r: bigint, s: bigint, recId: number): string {
    const sig = Signature.from({
      r: "0x" + r.toString(16).padStart(64, "0"),
      s: "0x" + s.toString(16).padStart(64, "0"),
      v: recId + 27,
    });
    return recoverAddress(hexlify(digest), sig);
  }

  private signatureToHex(r: bigint, s: bigint, v: number): string {
    const rHex = r.toString(16).padStart(64, "0");
    const sHex = s.toString(16).padStart(64, "0");
    const vHex = v.toString(16).padStart(2, "0");
    return "0x" + rHex + sHex + vHex;
  }
}

/**
 * An ethers-compatible signer backed by AWS KMS.
 * Can be used as a drop-in replacement for ethers.Wallet with Contract instances.
 */
export class KmsTransactionSigner extends AbstractSigner {
  private inner: KmsSigner;

  constructor(keyId: string, provider: Provider, region?: string) {
    super(provider);
    this.inner = new KmsSigner(keyId, region);
  }

  async getAddress(): Promise<string> {
    return this.inner.getAddress();
  }

  connect(provider: Provider): KmsTransactionSigner {
    return new KmsTransactionSigner(
      (this.inner as any).keyId,
      provider,
      (this.inner as any).kms.config?.region as string | undefined
    );
  }

  async signTransaction(tx: TransactionRequest): Promise<string> {
    const address = await this.getAddress();

    // Resolve nonce if not provided
    let nonce = tx.nonce;
    if (nonce == null && this.provider) {
      nonce = await this.provider.getTransactionCount(address, "pending");
    }

    // Build a clean legacy (type 0) transaction for Besu IBFT
    const transaction = new Transaction();
    transaction.type = 0;
    transaction.to = tx.to as string ?? null;
    transaction.data = tx.data as string ?? "0x";
    transaction.nonce = Number(nonce ?? 0);
    transaction.gasLimit = BigInt(tx.gasLimit ?? 2_000_000);
    transaction.gasPrice = BigInt((tx as any).gasPrice ?? 0);
    transaction.value = BigInt(tx.value ?? 0);
    transaction.chainId = BigInt(tx.chainId ?? 70924);
    const unsignedHash = transaction.unsignedHash;

    const sigResult = await this.inner.signDigest(unsignedHash);
    transaction.signature = Signature.from({
      r: sigResult.r,
      s: sigResult.s,
      v: sigResult.v,
    });

    return transaction.serialized;
  }

  async signMessage(message: string | Uint8Array): Promise<string> {
    const msgBytes = typeof message === "string" ? new TextEncoder().encode(message) : message;
    const prefix = `\x19Ethereum Signed Message:\n${msgBytes.length}`;
    const digest = keccak256(
      new Uint8Array([...new TextEncoder().encode(prefix), ...msgBytes])
    );
    const result = await this.inner.signDigest(digest);
    return result.signature;
  }

  async signTypedData(
    domain: TypedDataDomain,
    types: Record<string, TypedDataField[]>,
    value: Record<string, any>
  ): Promise<string> {
    const { TypedDataEncoder } = await import("ethers");
    const digest = TypedDataEncoder.hash(domain, types, value);
    const result = await this.inner.signDigest(digest);
    return result.signature;
  }
}
