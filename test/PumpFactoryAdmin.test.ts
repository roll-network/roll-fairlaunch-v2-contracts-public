import { ethers, network } from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { getNetworkConfig, getChainSpecificFeeSetter, CHAIN_IDS, getDefaultTokenConfiguration } from "../deployment/pumpFactory.config";

describe("PumpFactory Admin Functions", function () {
    async function deployFactoryFixture() {
        const [owner, newFeeRecipient, newFeeRecipientSetter, user] = await ethers.getSigners();

        // Get chain-specific configuration
        const networkConfig = getNetworkConfig(network.config.chainId);
        const feeSetter = getChainSpecificFeeSetter(network.config.chainId || CHAIN_IDS.FORM_TESTNET);

        const lpBlackHoleContract = await ethers.deployContract("LPBlackHole");
        await lpBlackHoleContract.waitForDeployment()
        const lpBlackHoleContractAddress = lpBlackHoleContract.target

        const externalContracts = {
            weth: networkConfig.WETH,
            algebraFactory: networkConfig.ALGEBRA_FACTORY,
            algebraPositionManager: networkConfig.ALGEBRA_POSITION_MANAGER,
            lpBlackHole: lpBlackHoleContractAddress
        }

        const factory = await ethers.deployContract("PumpFactory", [
            await ethers.getAddress(feeSetter), // feeRecipient
            await ethers.getAddress(feeSetter), // feeRecipientSetter
            externalContracts
        ]);

        const testConfig = getDefaultTokenConfiguration();

        await factory.connect(owner).addTokenConfiguration(testConfig, "Token Type 1");

        return {
            factory,
            owner,
            user,
            testConfig,
            newFeeRecipient,
            newFeeRecipientSetter
        };
    }

    describe("Fee Recipient Management", function () {
        it("Should allow fee recipient setter to change fee recipient", async function () {
            const { factory, owner, newFeeRecipient } = await loadFixture(deployFactoryFixture);

            // Get the actual fee setter address
            const feeSetter = getChainSpecificFeeSetter(network.config.chainId || CHAIN_IDS.FORM_TESTNET);

            // Set balance for the impersonated account
            await network.provider.send("hardhat_setBalance", [
                feeSetter,
                "0x1000000000000000000000", // 1000 ETH in hex
            ]);

            // Impersonate the fee setter account
            await network.provider.request({
                method: "hardhat_impersonateAccount",
                params: [feeSetter],
            });
            const feeSetterSigner = await ethers.getSigner(feeSetter);

            await factory.connect(feeSetterSigner).setFeeRecipient(newFeeRecipient.address);
            expect(await factory.feeRecipient()).to.equal(newFeeRecipient.address);
        });

        it("Should prevent non-fee-recipient-setter from changing fee recipient", async function () {
            const { factory, user, newFeeRecipient } = await loadFixture(deployFactoryFixture);

            await expect(
                factory.connect(user).setFeeRecipient(newFeeRecipient.address)
            ).to.be.revertedWithCustomError(factory, "Forbidden");
        });

        it("Should allow fee recipient setter to change fee recipient setter", async function () {
            const { factory, newFeeRecipientSetter } = await loadFixture(deployFactoryFixture);

            // Get the actual fee setter address
            const feeSetter = getChainSpecificFeeSetter(network.config.chainId || CHAIN_IDS.FORM_TESTNET);

            // Set balance for the impersonated account
            await network.provider.send("hardhat_setBalance", [
                feeSetter,
                "0x1000000000000000000000", // 1000 ETH in hex
            ]);

            // Impersonate the fee setter account
            await network.provider.request({
                method: "hardhat_impersonateAccount",
                params: [feeSetter],
            });
            const feeSetterSigner = await ethers.getSigner(feeSetter);

            await factory.connect(feeSetterSigner).setFeeRecipientSetter(newFeeRecipientSetter.address);
            expect(await factory.feeRecipientSetter()).to.equal(newFeeRecipientSetter.address);
        });

        it("Should prevent non-fee-recipient-setter from changing fee recipient setter", async function () {
            const { factory, user, newFeeRecipientSetter } = await loadFixture(deployFactoryFixture);

            await expect(
                factory.connect(user).setFeeRecipientSetter(newFeeRecipientSetter.address)
            ).to.be.revertedWithCustomError(factory, "Forbidden");
        });
    });

    describe("Configuration Management", function () {
        it("Should allow owner to add new configuration", async function () {
            const { factory, owner, testConfig } = await loadFixture(deployFactoryFixture);

            const newConfig = {
                ...testConfig,
                name: "New Config",
                tokenTotalSupply: ethers.parseEther("2000000")
            };

            await expect(factory.connect(owner).addTokenConfiguration(newConfig, "New Config"))
                .to.emit(factory, "TokenTypeAdded");

            const savedConfig = await factory.getTokenTypeDetails(1);
            expect(savedConfig.tokenTotalSupply).to.equal(newConfig.tokenTotalSupply);
            expect(savedConfig.name).to.equal("New Config");
            expect(savedConfig.isActive).to.be.true;
        });

        it("Should allow owner to update existing configuration", async function () {
            const { factory, owner, testConfig } = await loadFixture(deployFactoryFixture);

            const updatedConfig = {
                ...testConfig,
                tokenTotalSupply: ethers.parseEther("2000000"),
                name: "Updated Config"
            };

            await expect(factory.connect(owner).updateTokenConfiguration(0, updatedConfig))
                .to.emit(factory, "TokenTypeUpdated");

            const savedConfig = await factory.getTokenTypeDetails(0);
            expect(savedConfig.tokenTotalSupply).to.equal(updatedConfig.tokenTotalSupply);
            expect(savedConfig.name).to.equal("Updated Config");
        });

        it("Should allow owner to toggle configuration status", async function () {
            const { factory, owner } = await loadFixture(deployFactoryFixture);

            await expect(factory.connect(owner).toggleTokenTypeStatus(0))
                .to.emit(factory, "TokenTypeStatusUpdated")
                .withArgs(0, false);

            expect(await factory.isTokenTypeActive(0)).to.be.false;

            await expect(factory.connect(owner).toggleTokenTypeStatus(0))
                .to.emit(factory, "TokenTypeStatusUpdated")
                .withArgs(0, true);

            expect(await factory.isTokenTypeActive(0)).to.be.true;
        });

        it("Should prevent non-owner from managing configurations", async function () {
            const { factory, user, testConfig } = await loadFixture(deployFactoryFixture);

            await expect(
                factory.connect(user).addTokenConfiguration(testConfig, "New Config")
            ).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount")
                .withArgs(user.address);

            await expect(
                factory.connect(user).updateTokenConfiguration(0, testConfig)
            ).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount")
                .withArgs(user.address);

            await expect(
                factory.connect(user).toggleTokenTypeStatus(0)
            ).to.be.revertedWithCustomError(factory, "OwnableUnauthorizedAccount")
                .withArgs(user.address);
        });

        it("Should fail to add configuration with empty name", async function () {
            const { factory, owner, testConfig } = await loadFixture(deployFactoryFixture);

            await expect(
                factory.connect(owner).addTokenConfiguration(testConfig, "")
            ).to.be.revertedWithCustomError(factory, "EmptyConfigName");
        });

        it("Should fail to add configuration with invalid swap fee percentage", async function () {
            const { factory, owner, testConfig } = await loadFixture(deployFactoryFixture);

            const invalidConfig = {
                ...testConfig,
                feesEconomics: {
                    ...testConfig.feesEconomics,
                    platformSwapFeePercentage: 10001
                }
            };

            await expect(
                factory.connect(owner).addTokenConfiguration(invalidConfig, "Invalid Config")
            ).to.be.revertedWithCustomError(factory, "InvalidPercentage");
        });

        it("Should fail to update non-existent configuration", async function () {
            const { factory, owner, testConfig } = await loadFixture(deployFactoryFixture);

            await expect(
                factory.connect(owner).updateTokenConfiguration(99, testConfig)
            ).to.be.revertedWithCustomError(factory, "TokenTypeNotFound");
        });

        it("Should fail to toggle non-existent configuration", async function () {
            const { factory, owner } = await loadFixture(deployFactoryFixture);

            await expect(
                factory.connect(owner).toggleTokenTypeStatus(99)
            ).to.be.revertedWithCustomError(factory, "TokenTypeNotFound");
        });
    });
});
