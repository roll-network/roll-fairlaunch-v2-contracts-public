import { DeployConfig } from "./tools";

export interface DeployConfigMap {
    [key: string]: {
        meta: DeployConfig;
    };
}

export enum ContractsKeys {
    PumpFactory = "PumpFactory",
}

export const deployConfigMap: DeployConfigMap = {
    [ContractsKeys.PumpFactory]: {
        meta: {
            create2Salt: undefined,
            isUpgradable: false,
            key: ContractsKeys.PumpFactory,
            name: "PumpFactory",
            params: [],
        },
    },
};

export type Addr = `0x${string}`;

export interface FeesHandler {
    feeRecipientSetter: Addr;
    feeRecipient: Addr;
}

export interface BondingCurveConfig {
    virtualTokenReserve: bigint;
    virtualEthReserve: bigint;
    ethAmountForLiquidity: bigint;
}

export interface FeesEconomics {
    platformSwapFeePercentage: number,
    referralSwapFeePercentage: number,
    ethAmountForLiquidityFee: bigint;
    ethAmountForDevReward: bigint;
    ethAmountForReferralReward: bigint;
}

export interface TokenTypeConfiguration {
    name: string;
    isActive: boolean;
    tokenTotalSupply: bigint;
    tokenCreationFee: bigint;
    bondingCurveConfig: BondingCurveConfig;
    feesEconomics: FeesEconomics;
}