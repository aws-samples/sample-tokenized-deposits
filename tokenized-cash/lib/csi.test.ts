import { deriveInstructionId, buildCsi, hashTypedData, idempotencyKey, clientIdempotencyKey } from "./csi";
import { CHAIN_ID } from "./constants";
import { keccak256, solidityPacked, AbiCoder, TypedDataEncoder } from "ethers";

// Test vectors matching the Python implementation's encoding logic
describe("CSI Library", () => {
  const testParams = {
    messageDigest: keccak256(new TextEncoder().encode("test-payment-001")),
    asset: "0x1234567890abcdef1234567890abcdef12345678",
    amount: BigInt("1000000000000000000"), // 1 token
    fromParty: "0xaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    toParty: "0xbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
    valueTime: 1700000000,
    intent: 0, // MINT_ONLY
    chainId: CHAIN_ID,
    createdAt: 1700000000,
    expiry: 1700003600,
    nonce: "0x" + "cc".repeat(32),
  };

  describe("deriveInstructionId", () => {
    it("produces a deterministic bytes32 hash", () => {
      const id = deriveInstructionId(testParams);
      expect(id).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it("is deterministic for same inputs", () => {
      const id1 = deriveInstructionId(testParams);
      const id2 = deriveInstructionId(testParams);
      expect(id1).toBe(id2);
    });

    it("changes when any field changes", () => {
      const id1 = deriveInstructionId(testParams);
      const id2 = deriveInstructionId({ ...testParams, amount: BigInt("2000000000000000000") });
      expect(id1).not.toBe(id2);
    });

    it("matches solidityPacked encoding of CSI_V1 prefix", () => {
      // Verify the packed encoding matches what Solidity abi.encodePacked would produce
      const packed = solidityPacked(
        ["string", "bytes32", "address", "uint256", "address", "address", "uint64", "uint8", "uint256", "uint64", "uint64", "bytes32"],
        [
          "CSI_V1",
          testParams.messageDigest,
          testParams.asset,
          testParams.amount,
          testParams.fromParty,
          testParams.toParty,
          testParams.valueTime,
          testParams.intent,
          testParams.chainId,
          testParams.createdAt,
          testParams.expiry,
          testParams.nonce,
        ]
      );
      const expected = keccak256(packed);
      const actual = deriveInstructionId(testParams);
      expect(actual).toBe(expected);
    });
  });

  describe("buildCsi", () => {
    it("computes instructionId and includes all fields", () => {
      const csi = buildCsi(testParams);
      expect(csi.instructionId).toBe(deriveInstructionId(testParams));
      expect(csi.asset).toBe(testParams.asset);
      expect(csi.amount).toBe(testParams.amount);
      expect(csi.chainId).toBe(CHAIN_ID);
    });
  });

  describe("hashTypedData", () => {
    it("produces a 32-byte digest", () => {
      const csi = buildCsi(testParams);
      const verifyingContract = "0xcccccccccccccccccccccccccccccccccccccccc";
      const digest = hashTypedData(csi, verifyingContract);
      expect(digest).toMatch(/^0x[0-9a-f]{64}$/);
    });

    it("is deterministic", () => {
      const csi = buildCsi(testParams);
      const vc = "0xcccccccccccccccccccccccccccccccccccccccc";
      expect(hashTypedData(csi, vc)).toBe(hashTypedData(csi, vc));
    });

    it("changes with different verifyingContract (domain separation)", () => {
      const csi = buildCsi(testParams);
      const d1 = hashTypedData(csi, "0xcccccccccccccccccccccccccccccccccccccccc");
      const d2 = hashTypedData(csi, "0xdddddddddddddddddddddddddddddddddddddddd");
      expect(d1).not.toBe(d2);
    });
  });

  describe("idempotencyKey", () => {
    const idemParams = {
      asset: testParams.asset,
      amount: testParams.amount,
      fromParty: testParams.fromParty,
      toParty: testParams.toParty,
      intent: testParams.intent,
      chainId: testParams.chainId,
    };

    it("same inputs + reference produce same key", () => {
      const k1 = idempotencyKey({ ...idemParams, reference: "ref-123" });
      const k2 = idempotencyKey({ ...idemParams, reference: "ref-123" });
      expect(k1).toBe(k2);
    });

    it("different references produce different keys", () => {
      const k1 = idempotencyKey({ ...idemParams, reference: "ref-123" });
      const k2 = idempotencyKey({ ...idemParams, reference: "ref-456" });
      expect(k1).not.toBe(k2);
    });

    it("different business fields produce different keys", () => {
      const k1 = idempotencyKey({ ...idemParams, reference: "ref-123" });
      const k2 = idempotencyKey({ ...idemParams, amount: idemParams.amount + 1n, reference: "ref-123" });
      expect(k1).not.toBe(k2);
    });

    it("is stable across calls (no time/random component)", () => {
      const k1 = idempotencyKey({ ...idemParams, reference: "ref-123" });
      const k2 = idempotencyKey({ ...idemParams, reference: "ref-123" });
      const k3 = idempotencyKey({ ...idemParams, reference: "ref-123" });
      expect(k1).toBe(k2);
      expect(k2).toBe(k3);
    });

    it("empty reference uses zero-bytes hash and is deterministic", () => {
      const k1 = idempotencyKey({ ...idemParams, reference: "" });
      const k2 = idempotencyKey({ ...idemParams, reference: "" });
      expect(k1).toMatch(/^0x[0-9a-f]{64}$/);
      expect(k1).toBe(k2);
    });
  });

  describe("clientIdempotencyKey", () => {
    it("is deterministic for the same client request id", () => {
      expect(clientIdempotencyKey("req-abc")).toBe(clientIdempotencyKey("req-abc"));
    });

    it("differs for different client request ids", () => {
      expect(clientIdempotencyKey("req-abc")).not.toBe(clientIdempotencyKey("req-xyz"));
    });

    it("produces a bytes32 hash", () => {
      expect(clientIdempotencyKey("req-abc")).toMatch(/^0x[0-9a-f]{64}$/);
    });
  });
});
