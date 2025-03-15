// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {BondingCurveTypes} from "./BondingCurveTypes.sol";

contract FeeSplitter {
    BondingCurveTypes.FeesEconomics public feesEconomics;
    address public referrer;
    uint256 public totalReferralFees;

    error NoReferrer();
    error NoReferralFees();

    /// @notice Creates a new BondingCurve instance
    /// @dev Sets up initial parameters and connects to external contracts
    constructor(BondingCurveTypes.FeesEconomics memory _feesEconomics, address _referrer) {
        feesEconomics = _feesEconomics;
        referrer = _referrer;
    }

    function calculateTradeFee(uint256 amount) internal view returns (uint256, uint256, uint256) {
        uint256 totalFeesPercentage = feesEconomics.platformSwapFeePercentage;

        if (referrer != address(0)) {
            totalFeesPercentage += feesEconomics.referralSwapFeePercentage;
        }
        
        uint256 totalFees = _calculateTotalFee(amount, totalFeesPercentage);

        if (referrer == address(0)) {
            return (totalFees, totalFees, 0);
        }

        uint256 platformFees =
            calculateFeesShare(totalFees, feesEconomics.platformSwapFeePercentage, totalFeesPercentage);
        uint256 referrerFees =
            calculateFeesShare(totalFees, feesEconomics.referralSwapFeePercentage, totalFeesPercentage);

        return (totalFees, platformFees, referrerFees);
    }

    function calculateFeesShare(uint256 totalFees, uint256 share, uint256 totalShares)
        internal
        pure
        returns (uint256)
    {
        return (totalFees * share) / totalShares;
    }

    function _payFees(uint256 platformFees, uint256 referrerFees) internal virtual {}

    function _safeTransferETH(address to, uint256 amount) internal {
        (bool success,) = to.call{value: amount}("");
        require(success, "ETH transfer failed");
    }

    function addReferralFees(uint256 amount) internal {
        if (referrer == address(0)) revert NoReferrer();
        totalReferralFees += amount;
    }

    function claimReferralFees() external {
        if (referrer == address(0)) revert NoReferrer();
        if (totalReferralFees == 0) revert NoReferralFees();
        _safeTransferETH(referrer, totalReferralFees);
        totalReferralFees = 0;
    }

    /// @notice Calculates the fee
    /// @dev Uses the percentage to calculate the fee
    /// @param amount The amount of tokens being traded
    /// @return The calculated fee
    function _calculateTotalFee(uint256 amount, uint256 feesPercentage) private pure returns (uint256) {
        return (amount * feesPercentage) / 10000;
    }
}
