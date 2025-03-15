import { ethers } from "hardhat";
import { Addr, TokenTypeConfiguration } from "./config";

export const CHAIN_IDS = {
    FORM_MAINNET: 478,
    FORM_TESTNET: 132902,
    LOCALHOST: 31337,
};

interface NetworkConfig {
    WETH: Addr;
    ALGEBRA_FACTORY: Addr;
    ALGEBRA_POSITION_MANAGER: Addr;
}

export interface PumpFactoryDeploymentConfig {
    tokenTotalSupply: string;
    tokenCreationFee: string;
    swapFeePercentage: string;
    virtualTokenReserve: string;
    virtualEthReserve: string;
    ethAmountForLiquidity: string;
    ethAmountForLiquidityFee: string;
    ethAmountForDevReward: string;
    feeRecipient: Addr;
    feeRecipientSetter: Addr;
    WETH: string;
    ALGEBRA_FACTORY: string;
    ALGEBRA_POSITION_MANAGER: string;
}

const chainConfigs: { [key: number]: NetworkConfig } = {
    [CHAIN_IDS.FORM_MAINNET]: {
        WETH: ethers.getAddress("0xb1b812b664c28E1bA1d35De925Ae88b7Bc7cdCF5") as Addr,
        ALGEBRA_FACTORY: ethers.getAddress("0xbd799BE84dd34B1242e1f7736A6441d6b1540e8b") as Addr,
        ALGEBRA_POSITION_MANAGER: ethers.getAddress("0x3FE6BA6D9aBeBb6d853891b2bda8C4A59C688457") as Addr,
    },
    [CHAIN_IDS.FORM_TESTNET]: {
        WETH: ethers.getAddress("0xA65be6D7DE4A82Cc9638FB3Dbf8E68b7f2e757ab") as Addr,
        ALGEBRA_FACTORY: ethers.getAddress("0x27951C7F8b609C0bb9c42e3988916d5E3ae0aC22") as Addr,
        ALGEBRA_POSITION_MANAGER: ethers.getAddress("0x19977d64d965C4763f9AF89C9dA34558B7b328D6") as Addr,
    },
};

const DEFAULT_CONFIG: NetworkConfig = chainConfigs[CHAIN_IDS.FORM_TESTNET];

export function getNetworkConfig(chainId?: number): NetworkConfig {
    if (!chainId) return DEFAULT_CONFIG;
    return chainConfigs[chainId] || DEFAULT_CONFIG;
}

function calculateVirtualEthReserve(
    tokenTotalSupply: bigint,
    virtualTokenReserve: bigint,
    ethAmountForLiquidity: bigint,
    ethAmountForLiquidityFee: bigint,
    ethAmountForDevReward: bigint,
    ethAmountForReferralReward: bigint
): bigint {
    const totalEthReserveAtMigration =
        ethAmountForLiquidity + ethAmountForLiquidityFee + ethAmountForDevReward + ethAmountForReferralReward;

    // 20% of total supply left in pool
    const totalTokenReserveAtMigration = (ethers.parseEther(tokenTotalSupply.toString()) * BigInt(20)) / BigInt(100);
    const result = (totalTokenReserveAtMigration * totalEthReserveAtMigration) /
        (virtualTokenReserve - totalTokenReserveAtMigration);

        return result;
}

export function createTokenConfiguration(
    params: {
        tokenTotalSupply?: bigint,
        tokenCreationFee?: bigint,
        platformSwapFeePercentage?: number,
        referralSwapFeePercentage?: number,
        virtualTokenReserve?: bigint,
        ethAmountForLiquidity?: bigint,
        ethAmountForLiquidityFee?: bigint,
        ethAmountForDevReward?: bigint,
        ethAmountForReferralReward?:bigint
        name?: string,
        isActive?: boolean
    } = {}
): TokenTypeConfiguration {
    // Default values
    const tokenTotalSupply = params.tokenTotalSupply ?? BigInt(1 * 10 ** 9);
    const tokenCreationFee = params.tokenCreationFee ?? ethers.parseEther("0.00001");
    const platformSwapFeePercentage = params.platformSwapFeePercentage ?? 100;
    const referralSwapFeePercentage = params.referralSwapFeePercentage ?? 100;
    const virtualTokenReserve = params.tokenTotalSupply ? ethers.parseEther(tokenTotalSupply.toString()) : ethers.parseEther(BigInt(1 * 10 ** 9).toString());
    const ethAmountForLiquidity = params.ethAmountForLiquidity ?? ethers.parseEther("4");
    const ethAmountForLiquidityFee = params.ethAmountForLiquidityFee ?? ethers.parseEther("0.1");
    const ethAmountForDevReward = params.ethAmountForDevReward ?? ethers.parseEther("0.1");
    const ethAmountForReferralReward = params.ethAmountForReferralReward ?? ethers.parseEther("0.0");
    const name = params.name ?? "Default Configuration";
    const isActive = params.isActive ?? true;

    const virtualEthReserve = calculateVirtualEthReserve(
        tokenTotalSupply,
        virtualTokenReserve,
        ethAmountForLiquidity,
        ethAmountForLiquidityFee,
        ethAmountForDevReward,
        ethAmountForReferralReward
    );

    let tokenTypeConfig: TokenTypeConfiguration = {
        name,
        isActive,
        tokenTotalSupply,
        tokenCreationFee,
        bondingCurveConfig: {
            virtualTokenReserve,
            virtualEthReserve,
            ethAmountForLiquidity,
        },
        feesEconomics: {
            platformSwapFeePercentage,
            referralSwapFeePercentage,
            ethAmountForLiquidityFee,
            ethAmountForDevReward,
            ethAmountForReferralReward
        },
    };
    return tokenTypeConfig;
}

// Use the function to create default configuration
export const getDefaultTokenConfiguration = (): TokenTypeConfiguration => createTokenConfiguration();

export const FEE_SETTER_FORM_MAINNET = ethers.getAddress(
    "0x4e93F5876304CF9D8374A77BCEDB7680d5A9D14e".toLowerCase()
);

export const FEE_SETTER_FORM_TESTNET = ethers.getAddress(
    "0xc05ed3743D87Bee34b76792d28347478015D7754".toLowerCase()
);

export const getChainSpecificFeeSetter = (chainId: number): string => {
    if (chainId === CHAIN_IDS.FORM_MAINNET) {
        return FEE_SETTER_FORM_MAINNET;
    }
    return FEE_SETTER_FORM_TESTNET;
};

