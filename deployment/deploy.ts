import { ethers, run, network } from "hardhat";

import { Addr, ContractsKeys, deployConfigMap, FeesHandler } from "./config";
import {
    getCurrentDeploy,
    getCurrentDeployByNetwork,
    saveDeployInfo,
} from "./tools";
import { getDefaultTokenConfiguration, getNetworkConfig } from "./pumpFactory.config";
import { PumpFactory } from "@typechain-types";

const verifyContract = async (
    contractAddress: string,
    constructorArguments: any[]
) => {
    // Verification process
    console.log(`Verifying contract ${contractAddress}`);
    try {
        await run("verify:verify", {
            address: contractAddress,
            constructorArguments,
        });
        console.log("Verification successful");
    } catch (error) {
        console.error("Verification failed:", error);
    }
};

const getDeploy = async (
    key: ContractsKeys,
    deploy: boolean,
    params: any[]
) => {
    return getCurrentDeploy(key);
};

const getContract = async (key: ContractsKeys) => {
    const data = await getDeploy(key, false, []);
    if (!data || !data.contractMeta) {
        throw new Error("Could not find deployment");
    }

    const factory = await ethers.getContractFactory(data.contractMeta.key);
    return factory.attach(data.address) as unknown as PumpFactory;
};

const deployShapes = async (
    feesHandler: FeesHandler,
    LPBlackHoleContract: Addr | null
): Promise<string> => {

    let LP_BLACK_HOLE;
    if (LPBlackHoleContract == null) {
        console.log("Deploying LP BlackHole contract...");
        const LPBlackHole = await ethers.getContractFactory("LPBlackHole");

        const lpBlackHoleContract = await LPBlackHole.deploy();

        const contract = await lpBlackHoleContract.waitForDeployment();

        const lpBlackHoleContractAddress = await lpBlackHoleContract.getAddress();
        console.log(
            "LP black hole contract deployed to:",
            lpBlackHoleContractAddress
        );

        await verifyContract(lpBlackHoleContractAddress, []);
        const abi = contract.interface.formatJson();
        const data = {
            abi: JSON.parse(abi),
            address: lpBlackHoleContractAddress,
            contractMeta: {
                key: "LPBlackHole",
            },
        };
        saveDeployInfo(data as any);

        LP_BLACK_HOLE = lpBlackHoleContractAddress;
    } else {
        LP_BLACK_HOLE = LPBlackHoleContract;
    }
    const chainId = network.config.chainId || 0;
    const networkConfig = getNetworkConfig(chainId);

    const externalContracts = {
        weth: networkConfig.WETH,
        algebraFactory: networkConfig.ALGEBRA_FACTORY,
        algebraPositionManager: networkConfig.ALGEBRA_POSITION_MANAGER,
        lpBlackHole: LP_BLACK_HOLE
    }

    console.log("Deploying PumpFactory...");

    console.log("Chain ID:", chainId);
    console.log("Fee Recipient:", feesHandler.feeRecipient)
    console.log("Fee Recipient Setter:", feesHandler.feeRecipientSetter)
    console.log("externalContracts:", externalContracts);
    console.log("LP Black Hole:", LP_BLACK_HOLE);


    const PumpFactory = await ethers.getContractFactory("PumpFactory");
    const pumpFactory = await PumpFactory.deploy(
        feesHandler.feeRecipient,
        feesHandler.feeRecipientSetter,
        externalContracts
    );

    const contract = await pumpFactory.waitForDeployment();
    const pumpFactoryAddress = await pumpFactory.getAddress();

    console.log("PumpFactory deployed to:", pumpFactoryAddress);

    await verifyContract(pumpFactoryAddress, [
        feesHandler.feeRecipient,
        feesHandler.feeRecipientSetter,
        externalContracts
    ]);

    // Add default configuration
    const defaultConfig = getDefaultTokenConfiguration();
    await contract.addTokenConfiguration(defaultConfig, "Default Configuration");
    console.log("Added default configuration");

    const abi = contract.interface.formatJson();
    const data = {
        abi: JSON.parse(abi),
        address: pumpFactoryAddress,
        contractMeta: {
            key: "PumpFactory",
        },
    };
    saveDeployInfo(data as any);

    return "";
};

export const deployContracts = async (
    feesHandler: FeesHandler,
    LPBlackHoleContract: Addr | null): Promise<string> => {
    await deployShapes(feesHandler, LPBlackHoleContract);
    console.log("All contracts successfully deployed");
    return "";
};

export const postDeploy = async (newOwner: string) => {
    const pumpFactory = await getContract(ContractsKeys.PumpFactory);
    console.log("Transferring ownership to:", newOwner);
    const tx = await pumpFactory.transferOwnership(newOwner);
    await tx.wait();
    console.log("Ownership transferred, tx:", tx.hash);
    console.log("Post deploy routine completed");
};
