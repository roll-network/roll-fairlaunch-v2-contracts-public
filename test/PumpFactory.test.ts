import { ethers, network } from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { getNetworkConfig, getChainSpecificFeeSetter, CHAIN_IDS, getDefaultTokenConfiguration, createTokenConfiguration } from "../deployment/pumpFactory.config";
import { ZeroAddress } from "ethers";
import { BondingCurve } from "../typechain-types";

describe("PumpFactory", function () {
    async function deployFactoryFixture() {
        const [owner, tokenDeveloper, user, referrer] = await ethers.getSigners();

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
            tokenDeveloper,
            user,
            referrer,
            testConfig
        };
    }

    describe("Token Type Management", function () {
        it("Should add new token type correctly", async function () {
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

        it("Should update existing configuration", async function () {
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
        });

        it("Should toggle configuration status", async function () {
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
    });

    describe("Token Creation", function () {
        it("Should create token with valid configuration", async function () {
            const { factory, user, testConfig } = await loadFixture(deployFactoryFixture);

            await expect(
                factory.connect(user).createToken(
                    "Test Token",
                    "TEST",
                    "https://test.uri",
                    0,
                    user.address,
                    ZeroAddress,
                    { value: testConfig.tokenCreationFee }
                )
            ).to.emit(factory, "TokenCreated");
        });

        it("Should fail to create token with inactive configuration", async function () {
            const { factory, owner, user, testConfig } = await loadFixture(deployFactoryFixture);

            // Deactivate config
            await factory.connect(owner).toggleTokenTypeStatus(0);

            await expect(
                factory.connect(user).createToken(
                    "Test Token",
                    "TEST",
                    "https://test.uri",
                    0,
                    user.address,
                    ZeroAddress,
                    { value: testConfig.tokenCreationFee },
                )
            ).to.be.revertedWithCustomError(factory, "TokenTypeNotActive");
        });

        it("Should fail to create token with invalid configuration ID", async function () {
            const { factory, user, testConfig } = await loadFixture(deployFactoryFixture);

            await expect(
                factory.connect(user).createToken(
                    "Test Token",
                    "TEST",
                    "https://test.uri",
                    99, // Invalid config ID
                    user.address,
                    ZeroAddress,
                    { value: testConfig.tokenCreationFee }
                )
            ).to.be.revertedWithCustomError(factory, "TokenTypeNotFound");
        });

        it("Should fail to create token with insufficient fee", async function () {
            const { factory, user } = await loadFixture(deployFactoryFixture);

            await expect(
                factory.connect(user).createToken(
                    "Test Token",
                    "TEST",
                    "https://test.uri",
                    0,
                    user.address,
                    ZeroAddress,
                    { value: 0 }
                )
            ).to.be.revertedWithCustomError(factory, "InsufficientFee");
        });
    });

    describe("Token Creation with Referrals", function () {
        it("Should create token with valid configuration and referrer", async function () {
            const { factory, user, referrer, testConfig } = await loadFixture(deployFactoryFixture);

            await expect(
                factory.connect(user).createToken(
                    "Test Token",
                    "TEST",
                    "https://test.uri",
                    0,
                    user.address,
                    referrer.address,
                    { value: testConfig.tokenCreationFee }
                )
            ).to.emit(factory, "TokenCreated");

            // Get the created token and bonding curve addresses
            const events = await factory.queryFilter(factory.filters.TokenCreated());
            const tokenAddress = events[events.length - 1].args.token;
            const bondingCurveAddress = events[events.length - 1].args.bondingCurve;

            // // Verify referrer is set correctly in the bonding curve
            const bondingCurve = await ethers.getContractAt("BondingCurve", bondingCurveAddress);
            expect(await bondingCurve.referrer()).to.equal(referrer.address);
        });

        it("Should create token with zero address referrer when referral fee is zero", async function () {
            const { factory, user, owner } = await loadFixture(deployFactoryFixture);

            // Create a new config with zero referral fee
            const configWithNoReferral = createTokenConfiguration({
                referralSwapFeePercentage: 0,
                ethAmountForReferralReward: BigInt(0)
            });

            await factory.connect(owner).addTokenConfiguration(configWithNoReferral, "No Referral Config");

            await expect(
                factory.connect(user).createToken(
                    "Test Token",
                    "TEST",
                    "https://test.uri",
                    1, // Using the new config ID
                    user.address,
                    ZeroAddress, // Zero address as referrer
                    { value: configWithNoReferral.tokenCreationFee }
                )
            ).to.emit(factory, "TokenCreated");
        });

        it("Should allow referrer to claim accumulated fees", async function () {
            const { factory, user, referrer, testConfig } = await loadFixture(deployFactoryFixture);

            // Create token with referrer
            const tx = await factory.connect(user).createToken(
                "Test Token",
                "TEST",
                "https://test.uri",
                0,
                user.address,
                referrer.address,
                { value: testConfig.tokenCreationFee }
            );
            await tx.wait();

            // Get the bonding curve address
            const events = await factory.queryFilter(factory.filters.TokenCreated());
            const bondingCurveAddress = events[events.length - 1].args.bondingCurve;
            const BondingCurve = await ethers.getContractFactory("BondingCurve") as unknown as BondingCurve;
            const bondingCurve = BondingCurve.attach(bondingCurveAddress) as unknown as BondingCurve;

            // Perform a buy to generate referral fees
            await bondingCurve.connect(user).buy({ value: ethers.parseEther("1") });

            // Check referral fees can be claimed
            const initialBalance = await ethers.provider.getBalance(referrer.address);
            await bondingCurve.connect(referrer).claimReferralFees();
            const finalBalance = await ethers.provider.getBalance(referrer.address);

            expect(finalBalance).to.be.gt(initialBalance);
        });
    });

    describe("Configuration Validation", function () {
        it("Should fail to add configuration with empty name", async function () {
            const { factory, owner, testConfig } = await loadFixture(deployFactoryFixture);

            await expect(
                factory.connect(owner).addTokenConfiguration(testConfig, "")
            ).to.be.revertedWithCustomError(factory, "EmptyConfigName");
        });

        it("Should fail to add configuration with invalid swap fee percentage", async function () {
            const { factory, owner } = await loadFixture(deployFactoryFixture);

            const invalidConfig = createTokenConfiguration({
                platformSwapFeePercentage: 10001 // Greater than 100%
            });

            await expect(
                factory.connect(owner).addTokenConfiguration(invalidConfig, "Invalid Config")
            ).to.be.revertedWithCustomError(factory, "InvalidPercentage");
        });
    });
});
