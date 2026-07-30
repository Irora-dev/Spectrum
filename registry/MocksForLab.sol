// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// Anvil-only doubles for the LeaguePool E2E — never deployed anywhere real.
contract MockSettlement {
    string public constant symbol = "USDC";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    mapping(address => mapping(address => uint256)) public allowance;

    function mint(address to, uint256 amt) external { balanceOf[to] += amt; }
    function approve(address spender, uint256 amt) external returns (bool) {
        allowance[msg.sender][spender] = amt;
        return true;
    }
    function transfer(address to, uint256 amt) external returns (bool) {
        balanceOf[msg.sender] -= amt;
        balanceOf[to] += amt;
        return true;
    }
    function transferFrom(address from, address to, uint256 amt) external returns (bool) {
        allowance[from][msg.sender] -= amt;
        balanceOf[from] -= amt;
        balanceOf[to] += amt;
        return true;
    }
}

contract MockFactory {
    mapping(address => address) public tokens; // basket → deployer
    function register(address basket, address deployer) external { tokens[basket] = deployer; }
}

/// Stands in for a lineage basket: approves + credits the pool in one call.
contract MockBasket {
    function flushLeague(address pool, address settlement, address creator, uint256 amount) external {
        MockSettlement(settlement).approve(pool, amount);
        (bool ok,) = pool.call(abi.encodeWithSignature("credit(address,uint256)", creator, amount));
        require(ok, "credit failed");
    }
}
