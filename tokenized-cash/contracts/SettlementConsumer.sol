// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {KeyRegistry} from "./KeyRegistry.sol";

interface IToken {
    function mint(address to, uint256 amount) external;
    function burn(address from, uint256 amount) external;
}

interface IERC165 {
    function supportsInterface(bytes4 interfaceId) external view returns (bool);
}

interface IReceiver is IERC165 {
    function onReport(bytes calldata metadata, bytes calldata report) external;
}

contract SettlementConsumer {
    enum Intent {
        MINT_ONLY,
        BURN_AND_MINT,
        BURN_ONLY
    }

    struct CanonicalSettlementInstruction {
        bytes32 instructionId;
        bytes32 messageDigest;
        address asset;
        uint256 amount;
        address fromParty;
        address toParty;
        uint64 valueTime;
        uint64 createdAt;
        uint64 expiry;
        uint8 intent;
        uint256 chainId;
        bytes32 nonce;
    }

    struct SettlementReport {
        CanonicalSettlementInstruction instruction;
        bytes signature;
    }

    string public constant NAME = "SettlementInstruction";
    string public constant VERSION = "1";

    bytes32 public constant DOMAIN_TYPEHASH = keccak256(
        "EIP712Domain(string name,string version,uint256 chainId,address verifyingContract)"
    );

    bytes32 public constant CSI_TYPEHASH = keccak256(
        "CanonicalSettlementInstruction(bytes32 instructionId,bytes32 messageDigest,address asset,uint256 amount,address fromParty,address toParty,uint64 valueTime,uint64 createdAt,uint64 expiry,uint8 intent,uint256 chainId,bytes32 nonce)"
    );

    uint256 private constant SECP256K1_N =
        0xFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFFEBAAEDCE6AF48A03BBFD25E8CD0364141;
    uint256 private constant SECP256K1_N_HALF = SECP256K1_N / 2;

    KeyRegistry public immutable KEY_REGISTRY;
    address public admin;
    address public forwarder;
    mapping(address => bool) public allowlistedRelayers;
    mapping(bytes32 => bool) public executed;

    event SettlementExecuted(
        bytes32 indexed instructionId,
        bytes32 indexed messageDigest,
        address indexed asset,
        address fromParty,
        address toParty,
        uint256 amount,
        uint8 intent
    );
    event ForwarderUpdated(address indexed oldForwarder, address indexed newForwarder);
    event AdminUpdated(address indexed oldAdmin, address indexed newAdmin);
    event RelayerUpdated(address indexed relayer, bool allowed);

    modifier onlyAdmin() {
        _onlyAdmin();
        _;
    }

    function _onlyAdmin() internal view {
        require(msg.sender == admin, "ADMIN_ONLY");
    }

    constructor(address registry, address forwarderAddress) {
        require(registry != address(0), "REGISTRY_ZERO");
        require(forwarderAddress != address(0), "FORWARDER_ZERO");
        KEY_REGISTRY = KeyRegistry(registry);
        admin = msg.sender;
        forwarder = forwarderAddress;
        allowlistedRelayers[forwarderAddress] = true;
        emit AdminUpdated(address(0), msg.sender);
        emit ForwarderUpdated(address(0), forwarderAddress);
        emit RelayerUpdated(forwarderAddress, true);
    }

    function onReport(bytes calldata, bytes calldata report) external {
        require(msg.sender == forwarder, "FORWARDER_ONLY");
        SettlementReport memory decoded = abi.decode(report, (SettlementReport));
        _settle(decoded.instruction, decoded.signature);
    }

    /// @notice Direct settlement call for allowlisted relayer EOAs (Besu pilot)
    function settle(SettlementReport calldata report) external {
        require(allowlistedRelayers[msg.sender], "RELAYER_UNAUTHORIZED");
        _settle(report.instruction, report.signature);
    }

    function setRelayer(address relayer, bool allowed) external onlyAdmin {
        require(relayer != address(0), "RELAYER_ZERO");
        allowlistedRelayers[relayer] = allowed;
        emit RelayerUpdated(relayer, allowed);
    }

    function setForwarder(address newForwarder) external onlyAdmin {
        require(newForwarder != address(0), "FORWARDER_ZERO");
        address oldForwarder = forwarder;
        forwarder = newForwarder;
        emit ForwarderUpdated(oldForwarder, newForwarder);
    }

    function setAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "ADMIN_ZERO");
        address oldAdmin = admin;
        admin = newAdmin;
        emit AdminUpdated(oldAdmin, newAdmin);
    }

    function supportsInterface(bytes4 interfaceId) external pure returns (bool) {
        return interfaceId == type(IReceiver).interfaceId || interfaceId == type(IERC165).interfaceId;
    }

    function _settle(CanonicalSettlementInstruction memory csi, bytes memory signature) internal {
        require(csi.chainId == block.chainid, "CHAIN_ID");
        require(block.timestamp <= csi.expiry, "EXPIRED");
        require(csi.expiry > csi.createdAt, "EXPIRY_ORDER");
        require(csi.asset != address(0), "ASSET_ZERO");
        require(!executed[csi.instructionId], "ALREADY_EXECUTED");
        require(csi.intent <= uint8(Intent.BURN_ONLY), "INTENT_INVALID");
        require(csi.instructionId == _deriveInstructionId(csi), "INSTRUCTION_ID");

        bytes32 digest = _hashTypedData(csi);
        address signer = _recoverSigner(digest, signature);
        require(KEY_REGISTRY.canSign(signer, csi.intent), "SIGNER_INTENT_UNAUTHORIZED");

        executed[csi.instructionId] = true;

        if (csi.intent == uint8(Intent.MINT_ONLY)) {
            IToken(csi.asset).mint(csi.toParty, csi.amount);
        } else if (csi.intent == uint8(Intent.BURN_AND_MINT)) {
            IToken(csi.asset).burn(csi.fromParty, csi.amount);
            IToken(csi.asset).mint(csi.toParty, csi.amount);
        } else {
            IToken(csi.asset).burn(csi.fromParty, csi.amount);
        }

        emit SettlementExecuted(
            csi.instructionId,
            csi.messageDigest,
            csi.asset,
            csi.fromParty,
            csi.toParty,
            csi.amount,
            csi.intent
        );
    }

    function _domainSeparator() internal view returns (bytes32) {
        return keccak256(
            abi.encode(
                DOMAIN_TYPEHASH,
                keccak256(bytes(NAME)),
                keccak256(bytes(VERSION)),
                block.chainid,
                address(this)
            )
        );
    }

    function _hashTypedData(CanonicalSettlementInstruction memory csi) internal view returns (bytes32) {
        bytes32 structHash = keccak256(
            abi.encode(
                CSI_TYPEHASH,
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
        return keccak256(abi.encodePacked("\x19\x01", _domainSeparator(), structHash));
    }

    function _deriveInstructionId(CanonicalSettlementInstruction memory csi) internal pure returns (bytes32) {
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

    function _recoverSigner(bytes32 digest, bytes memory signature) internal pure returns (address) {
        require(signature.length == 65, "SIG_LENGTH");
        bytes32 r;
        bytes32 s;
        uint8 v;
        assembly {
            r := mload(add(signature, 32))
            s := mload(add(signature, 64))
            v := byte(0, mload(add(signature, 96)))
        }
        if (v < 27) {
            v += 27;
        }
        require(v == 27 || v == 28, "SIG_V");
        require(uint256(s) <= SECP256K1_N_HALF, "SIG_S");
        address signer = ecrecover(digest, v, r, s);
        require(signer != address(0), "SIG_RECOVER");
        return signer;
    }
}
