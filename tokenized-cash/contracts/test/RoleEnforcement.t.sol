// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {KeyRegistry} from "../KeyRegistry.sol";
import {SettlementConsumer} from "../SettlementConsumer.sol";
import {Token} from "../Token.sol";

/// Minimal cheatcode interface so this suite has no forge-std dependency.
interface Vm {
    function addr(uint256 privateKey) external pure returns (address);
    function sign(uint256 privateKey, bytes32 digest) external pure returns (uint8 v, bytes32 r, bytes32 s);
    function expectRevert(bytes calldata revertData) external;
}

/// Verifies that per-intent signer roles are enforced ON-CHAIN: the CA key may
/// sign mints and transfers, the MX key may sign only redemptions, and neither
/// a wrong-role signer nor an unregistered key can settle.
contract RoleEnforcementTest {
    Vm constant vm = Vm(address(uint160(uint256(keccak256("hevm cheat code")))));

    // Intent bits (mirror lib/constants.ts): MINT_ONLY=0, BURN_AND_MINT=1, BURN_ONLY=2
    uint8 constant MINT_ONLY = 0;
    uint8 constant BURN_AND_MINT = 1;
    uint8 constant BURN_ONLY = 2;
    uint8 constant ROLE_CA = (uint8(1) << MINT_ONLY) | (uint8(1) << BURN_AND_MINT); // 0b011
    uint8 constant ROLE_MX = uint8(1) << BURN_ONLY; // 0b100

    uint256 constant CA_PK = 0xA11CE;
    uint256 constant MX_PK = 0xB0B;
    uint256 constant STRANGER_PK = 0xDEAD;

    KeyRegistry registry;
    SettlementConsumer consumer;
    Token token;
    address caAddr;
    address mxAddr;

    address constant ALICE = address(0xA1);
    address constant BOB = address(0xB2);

    function setUp() public {
        caAddr = vm.addr(CA_PK);
        mxAddr = vm.addr(MX_PK);

        // CA is the initial signer with mint+transfer roles; MX is added with redeem-only.
        registry = new KeyRegistry(address(this), caAddr, ROLE_CA);
        registry.addSigner(mxAddr, ROLE_MX);

        // This test contract is the forwarder, so it can call settle() directly.
        consumer = new SettlementConsumer(address(registry), address(this));
        token = new Token("Tokenized CAD", "tCAD", address(consumer));
    }

    // --- Happy paths -------------------------------------------------------

    function test_CaSigner_CanMint() public {
        _settle(_report(CA_PK, MINT_ONLY, address(0), ALICE, 1000, "n-mint"));
        require(token.balanceOf(ALICE) == 1000, "mint did not credit alice");
    }

    function test_CaSigner_CanTransfer() public {
        // Fund alice via a mint, then a CA-signed BURN_AND_MINT moves it to bob.
        _settle(_report(CA_PK, MINT_ONLY, address(0), ALICE, 1000, "n-mint2"));
        _settle(_report(CA_PK, BURN_AND_MINT, ALICE, BOB, 400, "n-xfer"));
        require(token.balanceOf(ALICE) == 600, "alice not debited");
        require(token.balanceOf(BOB) == 400, "bob not credited");
    }

    function test_MxSigner_CanRedeem() public {
        _settle(_report(CA_PK, MINT_ONLY, address(0), ALICE, 1000, "n-mint3"));
        _settle(_report(MX_PK, BURN_ONLY, ALICE, address(0), 250, "n-redeem"));
        require(token.balanceOf(ALICE) == 750, "burn did not debit alice");
        require(token.totalSupply() == 750, "supply not reduced");
    }

    // --- Role enforcement (the point of this change) -----------------------

    function test_MxSigner_CannotMint() public {
        // Build the signed report first: _report() makes cheatcode/view calls, and
        // expectRevert must latch onto the settle() call, not those.
        SettlementConsumer.SettlementReport memory report =
            _report(MX_PK, MINT_ONLY, address(0), ALICE, 1000, "n-badmint");
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "SIGNER_INTENT_UNAUTHORIZED"));
        consumer.settle(report);
    }

    function test_MxSigner_CannotTransfer() public {
        SettlementConsumer.SettlementReport memory report =
            _report(MX_PK, BURN_AND_MINT, ALICE, BOB, 100, "n-badxfer");
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "SIGNER_INTENT_UNAUTHORIZED"));
        consumer.settle(report);
    }

    function test_CaSigner_CannotRedeem() public {
        SettlementConsumer.SettlementReport memory report =
            _report(CA_PK, BURN_ONLY, ALICE, address(0), 100, "n-badredeem");
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "SIGNER_INTENT_UNAUTHORIZED"));
        consumer.settle(report);
    }

    function test_UnregisteredSigner_CannotSettle() public {
        SettlementConsumer.SettlementReport memory report =
            _report(STRANGER_PK, MINT_ONLY, address(0), ALICE, 1000, "n-stranger");
        vm.expectRevert(abi.encodeWithSignature("Error(string)", "SIGNER_INTENT_UNAUTHORIZED"));
        consumer.settle(report);
    }

    // --- Helpers -----------------------------------------------------------

    function _settle(SettlementConsumer.SettlementReport memory report) internal {
        consumer.settle(report);
    }

    /// Builds a fully-formed, correctly-signed settlement report for `intent`,
    /// signed by `signerPk`, matching the contract's id-derivation and EIP-712 hashing.
    function _report(
        uint256 signerPk,
        uint8 intent,
        address fromParty,
        address toParty,
        uint256 amount,
        bytes32 nonce
    ) internal view returns (SettlementConsumer.SettlementReport memory) {
        SettlementConsumer.CanonicalSettlementInstruction memory csi = SettlementConsumer
            .CanonicalSettlementInstruction({
            instructionId: bytes32(0),
            messageDigest: keccak256(abi.encodePacked("msg", nonce)),
            asset: address(token),
            amount: amount,
            fromParty: fromParty,
            toParty: toParty,
            valueTime: uint64(block.timestamp),
            createdAt: uint64(block.timestamp),
            expiry: uint64(block.timestamp + 3600),
            intent: intent,
            chainId: block.chainid,
            nonce: nonce
        });
        csi.instructionId = _deriveId(csi);

        bytes32 digest = _digest(csi);
        (uint8 v, bytes32 r, bytes32 s) = vm.sign(signerPk, digest);
        return SettlementConsumer.SettlementReport({instruction: csi, signature: abi.encodePacked(r, s, v)});
    }

    function _deriveId(SettlementConsumer.CanonicalSettlementInstruction memory csi)
        internal
        pure
        returns (bytes32)
    {
        return keccak256(
            abi.encodePacked(
                "CSI_V1",
                csi.messageDigest,
                csi.asset,
                csi.amount,
                csi.fromParty,
                csi.toParty,
                csi.valueTime,
                csi.intent,
                csi.chainId,
                csi.createdAt,
                csi.expiry,
                csi.nonce
            )
        );
    }

    function _digest(SettlementConsumer.CanonicalSettlementInstruction memory csi)
        internal
        view
        returns (bytes32)
    {
        bytes32 domainSeparator = keccak256(
            abi.encode(
                consumer.DOMAIN_TYPEHASH(),
                keccak256(bytes(consumer.NAME())),
                keccak256(bytes(consumer.VERSION())),
                block.chainid,
                address(consumer)
            )
        );
        bytes32 structHash = keccak256(
            abi.encode(
                consumer.CSI_TYPEHASH(),
                csi.instructionId,
                csi.messageDigest,
                csi.asset,
                csi.amount,
                csi.fromParty,
                csi.toParty,
                csi.valueTime,
                csi.createdAt,
                csi.expiry,
                csi.intent,
                csi.chainId,
                csi.nonce
            )
        );
        return keccak256(abi.encodePacked("\x19\x01", domainSeparator, structHash));
    }
}
