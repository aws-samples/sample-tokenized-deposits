// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract KeyRegistry {
    address public admin;
    mapping(address => bool) public isSigner;

    event AdminUpdated(address indexed oldAdmin, address indexed newAdmin);
    event SignerAdded(address indexed signer);
    event SignerRemoved(address indexed signer);

    modifier onlyAdmin() {
        _onlyAdmin();
        _;
    }

    function _onlyAdmin() internal view {
        require(msg.sender == admin, "ADMIN_ONLY");
    }

    constructor(address initialAdmin, address initialSigner) {
        require(initialAdmin != address(0), "ADMIN_ZERO");
        admin = initialAdmin;
        emit AdminUpdated(address(0), initialAdmin);
        if (initialSigner != address(0)) {
            isSigner[initialSigner] = true;
            emit SignerAdded(initialSigner);
        }
    }

    function setAdmin(address newAdmin) external onlyAdmin {
        require(newAdmin != address(0), "ADMIN_ZERO");
        address oldAdmin = admin;
        admin = newAdmin;
        emit AdminUpdated(oldAdmin, newAdmin);
    }

    function addSigner(address signer) external onlyAdmin {
        require(signer != address(0), "SIGNER_ZERO");
        require(!isSigner[signer], "SIGNER_EXISTS");
        isSigner[signer] = true;
        emit SignerAdded(signer);
    }

    function removeSigner(address signer) external onlyAdmin {
        require(isSigner[signer], "SIGNER_MISSING");
        isSigner[signer] = false;
        emit SignerRemoved(signer);
    }

    function isAuthorized(address signer) external view returns (bool) {
        return isSigner[signer];
    }
}
