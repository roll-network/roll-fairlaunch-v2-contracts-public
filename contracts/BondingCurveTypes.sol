// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

interface BondingCurveTypes {

    struct TokenConfig {
        // token address
        address tokenAddress;
        // token developer address
        address tokenDeveloper;
    }

    struct BondingCurveConfig {
        // virtual token reserve
        uint256 virtualTokenReserve;
        // virtual eth reserve
        uint256 virtualEthReserve;
        // eth amount to transfer to liquidity pool at migration
        uint256 ethAmountForLiquidity;
        //@note: token amount to transfer to liquidity pool is decided by virtualTokenReserve / virtualEthReserve, 
        //which is precalculated and passed accordingly
    }

    struct FeesEconomics {
        // swap fee that is being charged at each buy/sell for platform
        uint256 platformSwapFeePercentage;
        // referral swap fee that is being charged at each buy/sell for referral
        uint256 referralSwapFeePercentage;
        // platform fee that is being charged for liquidity migration
        uint256 ethAmountForLiquidityFee;
        // developer reward that goes to token developer at liquidity migration
        uint256 ethAmountForDevReward;
        // referral reward
        uint256 ethAmountForReferralReward;
    }

    struct ExternalContracts {
        // weth address
        address weth;
        // algebra factory address
        address algebraFactory;
        // algebra position manager address
        address algebraPositionManager;
        // lp black hole address
        address lpBlackHole;
    }
}
