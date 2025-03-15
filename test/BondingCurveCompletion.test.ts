import { ethers, network } from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { BondingCurve, INonfungiblePositionManager } from "../typechain-types";
import { getNetworkConfig, getChainSpecificFeeSetter, CHAIN_IDS, getDefaultTokenConfiguration } from "../deployment/pumpFactory.config";

describe("BondingCurve Completion", function () {
    async function deployBondingCurveFixture() {
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

        await factory.connect(owner).addTokenConfiguration(testConfig, "Test Config");

        // Create a token using the configuration
        const tx = await factory
            .connect(tokenDeveloper)
            .createToken(
                "Test Token", 
                "TEST", 
                "https://test.uri", 
                0, 
                tokenDeveloper.address,
                referrer.address,
                { value: testConfig.tokenCreationFee }
            );
        await tx.wait();

        // Get the created token and bonding curve addresses
        const filter = factory.filters.TokenCreated();
        const events = await factory.queryFilter(filter);
        const tokenAddress = events[events.length - 1].args.token;
        const bondingCurveAddress = events[events.length - 1].args.bondingCurve;

        // Get contract instances
        const token = await ethers.getContractAt("ERC20FixedSupply", tokenAddress);
        const bondingCurve = await ethers.getContractAt("BondingCurve", bondingCurveAddress);

        return {
            factory,
            token,
            bondingCurve,
            owner,
            tokenDeveloper,
            user,
            referrer,
            testConfig,
            lpBlackHoleContractAddress,
            ALGEBRA_POSITION_MANAGER: networkConfig.ALGEBRA_POSITION_MANAGER
        };
    }

    async function calculateRequiredETHWithFee(
        bondingCurve: BondingCurve,
        platformFeePercentage: number,
        referralFeePercentage: number
    ) {
        const remaining = await bondingCurve.remainingEthToCompleteCurve();
        let totalFeesPercentage = platformFeePercentage;

        const referrer = await bondingCurve.referrer();
        if (referrer != ethers.ZeroAddress) {
            totalFeesPercentage += referralFeePercentage;
        }
        return (BigInt(10000) * remaining) / BigInt(10000 - totalFeesPercentage);
    }


    describe("Curve Completion Process", function () {
        it("Should complete curve when receiving enough ETH", async function () {
            const { bondingCurve, user, testConfig } = await loadFixture(
                deployBondingCurveFixture
            );

            const requiredETH = await calculateRequiredETHWithFee(
                bondingCurve,
                testConfig.feesEconomics.platformSwapFeePercentage,
                testConfig.feesEconomics.referralSwapFeePercentage
            );

            await expect(
                bondingCurve.connect(user).buy({ value: requiredETH })
            ).to.emit(bondingCurve, "BondingCurveComplete");
        });

        it("Should create Algebra pool on completion", async function () {
            const { bondingCurve, token, user, testConfig } = await loadFixture(
                deployBondingCurveFixture
            );

            const requiredETH = await calculateRequiredETHWithFee(
                bondingCurve,
                testConfig.feesEconomics.platformSwapFeePercentage,
                testConfig.feesEconomics.referralSwapFeePercentage
            );

            const tx = await bondingCurve.connect(user).buy({ value: requiredETH });
            const receipt = await tx.wait();

            // Find BondingCurveComplete event
            const completeEvent = receipt?.logs?.find((log) => {
                try {
                    const parsedLog = bondingCurve.interface.parseLog(log);
                    return parsedLog?.name === "BondingCurveComplete";
                } catch {
                    return false;
                }
            });
            expect(completeEvent).to.not.be.undefined;

            if (!completeEvent) {
                throw new Error("BondingCurveComplete event not found");
            }

            const parsedLog = bondingCurve.interface.parseLog(completeEvent);
            if (!parsedLog) {
                throw new Error("Could not parse BondingCurveComplete event");
            }

            const liquidityPoolAddress = parsedLog.args[1]; // second argument in the event
            expect(liquidityPoolAddress).to.not.equal(ethers.ZeroAddress);
        });

        it("Should distribute rewards correctly on completion", async function () {
            const { bondingCurve, tokenDeveloper, testConfig, user, referrer } =
                await loadFixture(deployBondingCurveFixture);

            // Get initial balances
            const feeRecipient = getChainSpecificFeeSetter(network.config.chainId || CHAIN_IDS.FORM_TESTNET);
            const initialDevBalance = await ethers.provider.getBalance(tokenDeveloper.address);
            const initialFeeRecipientBalance = await ethers.provider.getBalance(feeRecipient);
            const initialReferrerBalance = await ethers.provider.getBalance(referrer.address);

            // Calculate and send required ETH
            const requiredETH = await calculateRequiredETHWithFee(
                bondingCurve,
                testConfig.feesEconomics.platformSwapFeePercentage,
                testConfig.feesEconomics.referralSwapFeePercentage
            );
            await bondingCurve.connect(user).buy({ value: requiredETH });

            // Check developer reward
            const finalDevBalance = await ethers.provider.getBalance(tokenDeveloper.address);
            expect(finalDevBalance - initialDevBalance).to.equal(
                testConfig.feesEconomics.ethAmountForDevReward
            );

            // Check liquidity fee and platform fees
            const finalFeeRecipientBalance = await ethers.provider.getBalance(feeRecipient);

            // Fee recipient gets:
            // 1. The liquidity fee (ethAmountForLiquidityFee)
            // 2. The platform portion of the swap fee from the final buy transaction
            const totalFeePercentage = testConfig.feesEconomics.platformSwapFeePercentage + 
                testConfig.feesEconomics.referralSwapFeePercentage;
            const totalBuyFee = (requiredETH * BigInt(totalFeePercentage)) / BigInt(10000);
            const platformFee = (totalBuyFee * BigInt(testConfig.feesEconomics.platformSwapFeePercentage)) / 
                BigInt(totalFeePercentage);

            const expectedFeeRecipientIncrease = testConfig.feesEconomics.ethAmountForLiquidityFee + platformFee;

            expect(finalFeeRecipientBalance - initialFeeRecipientBalance)
                .to.be.approximately(
                    expectedFeeRecipientIncrease,
                    ethers.parseEther("0.1") // Increased margin
                );

            // Check referral fees are accumulated but not transferred
            const finalReferrerBalance = await ethers.provider.getBalance(referrer.address);
            expect(finalReferrerBalance).to.equal(initialReferrerBalance);
            
            // Verify accumulated referral fees
            const referralFee = (totalBuyFee * BigInt(testConfig.feesEconomics.referralSwapFeePercentage)) / 
                BigInt(totalFeePercentage);
            expect(await bondingCurve.totalReferralFees()).to.equal(referralFee);
        });

        it("Should refund excess ETH if sending more than required", async function () {
            const { bondingCurve, user, testConfig } = await loadFixture(
                deployBondingCurveFixture
            );

            const requiredETH = await calculateRequiredETHWithFee(
                bondingCurve,
                testConfig.feesEconomics.platformSwapFeePercentage,
                testConfig.feesEconomics.referralSwapFeePercentage
            );
            const excess = ethers.parseEther("1");

            const initialBalance = await ethers.provider.getBalance(user.address);
            const tx = await bondingCurve
                .connect(user)
                .buy({ value: requiredETH + excess });
            const receipt = await tx.wait();

            const finalBalance = await ethers.provider.getBalance(user.address);
            const gasCost = receipt!.gasUsed * receipt!.gasPrice;

            // Account for gas costs in the calculation
            const amountSpent = initialBalance - finalBalance + gasCost;
            expect(amountSpent).to.be.approximately(
                requiredETH,
                ethers.parseEther("0.1")
            );
        });

        it("Should set isActive to false after completion", async function () {
            const { bondingCurve, user, testConfig } = await loadFixture(
                deployBondingCurveFixture
            );

            expect(await bondingCurve.isActive()).to.be.true;

            const requiredETH = await calculateRequiredETHWithFee(
                bondingCurve,
                testConfig.feesEconomics.platformSwapFeePercentage,
                testConfig.feesEconomics.referralSwapFeePercentage
            );
            await bondingCurve.connect(user).buy({ value: requiredETH });

            expect(await bondingCurve.isActive()).to.be.false;
        });

        it("Should revert direct ETH transfers", async function () {
            const { bondingCurve, user } = await loadFixture(
                deployBondingCurveFixture
            );

            await expect(
                user.sendTransaction({
                    to: bondingCurve.getAddress(),
                    value: ethers.parseEther("1"),
                })
            ).to.be.reverted;
        });

        it("Should send LP NFT to black hole correctly on completion", async function () {
            const {
                bondingCurve,
                user,
                testConfig,
                lpBlackHoleContractAddress,
                ALGEBRA_POSITION_MANAGER
            } = await loadFixture(deployBondingCurveFixture);

            const requiredETH = await calculateRequiredETHWithFee(
                bondingCurve,
                testConfig.feesEconomics.platformSwapFeePercentage,
                testConfig.feesEconomics.referralSwapFeePercentage
            );

            // Execute the buy transaction
            const tx = await bondingCurve.connect(user).buy({ value: requiredETH });
            const receipt = await tx.wait();

            // Ensure the transaction receipt exists
            if (!receipt) {
                throw new Error("Transaction receipt is null");
            }

            // Get the contract interface
            const iface = bondingCurve.interface;

            // Find and decode the LPTokenLocked event
            const eventLog = receipt.logs.find((log) => {
                try {
                    const parsed = iface.parseLog(log);
                    return parsed && parsed.name === "LPTokenLocked";
                } catch {
                    return false;
                }
            });

            if (!eventLog) {
                throw new Error("LPTokenLocked event not found");
            }

            // Decode event arguments
            const parsedEvent = iface.parseLog(eventLog);
            if (!parsedEvent) {
                return;
            }
            const tokenId = parsedEvent.args.tokenId;
            const blackHoleAddress = parsedEvent.args.blackHoleAddress;

            // Validate event parameters
            expect(tokenId).to.not.be.undefined;
            expect(blackHoleAddress).to.equal(lpBlackHoleContractAddress);

            const nftPositionManager: INonfungiblePositionManager =
                await ethers.getContractAt(
                    "INonfungiblePositionManager",
                    ALGEBRA_POSITION_MANAGER
                );

            expect(await nftPositionManager.ownerOf(tokenId)).to.equal(
                blackHoleAddress
            );
        });
    });
});
