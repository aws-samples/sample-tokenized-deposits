// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Token {
    string public name;
    string public symbol;
    uint8 public immutable DECIMALS;
    uint256 public totalSupply;
    address public minter;

    mapping(address => uint256) public balanceOf;

    event Transfer(address indexed from, address indexed to, uint256 value);
    event MinterUpdated(address indexed oldMinter, address indexed newMinter);

    modifier onlyMinter() {
        _onlyMinter();
        _;
    }

    function _onlyMinter() internal view {
        require(msg.sender == minter, "MINTER_ONLY");
    }

    constructor(string memory tokenName, string memory tokenSymbol, address initialMinter) {
        require(initialMinter != address(0), "MINTER_ZERO");
        name = tokenName;
        symbol = tokenSymbol;
        DECIMALS = 18;
        minter = initialMinter;
        emit MinterUpdated(address(0), initialMinter);
    }

    function decimals() external view returns (uint8) {
        return DECIMALS;
    }

    function setMinter(address newMinter) external onlyMinter {
        require(newMinter != address(0), "MINTER_ZERO");
        address oldMinter = minter;
        minter = newMinter;
        emit MinterUpdated(oldMinter, newMinter);
    }

    function mint(address to, uint256 amount) external onlyMinter {
        require(to != address(0), "MINT_TO_ZERO");
        balanceOf[to] += amount;
        totalSupply += amount;
        emit Transfer(address(0), to, amount);
    }

    function burn(address from, uint256 amount) external onlyMinter {
        require(from != address(0), "BURN_FROM_ZERO");
        uint256 balance = balanceOf[from];
        require(balance >= amount, "INSUFFICIENT_BALANCE");
        balanceOf[from] = balance - amount;
        totalSupply -= amount;
        emit Transfer(from, address(0), amount);
    }
}
