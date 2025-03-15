import { ethers, network } from "hardhat";
import { expect } from "chai";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import { BondingCurve } from "../typechain-types";
import { CHAIN_IDS, getChainSpecificFeeSetter, getDefaultTokenConfiguration, getNetworkConfig } from "../deployment/pumpFactory.config";

async function calculateRequiredETHWithFee(
    bondingCurve: BondingCurve,
    swapFeePercentage: number,
    referrerSwapFeePercentage: number
) {
    const remaining = await bondingCurve.remainingEthToCompleteCurve();
    let totalFeesPercentage = swapFeePercentage;

    const referrer = await bondingCurve.referrer();
    if (referrer != ethers.ZeroAddress) {
        totalFeesPercentage += referrerSwapFeePercentage;
    }
    return (BigInt(10000) * remaining) / BigInt(10000 - totalFeesPercentage)
}

describe("BondingCurve Operations", function () {
    async function deployBondingCurveFixture() {
        const [owner, tokenDeveloper, user, referrer]
            = await ethers.getSigners();
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
            feeSetter
        };
    }

    describe("Initial State", function () {
        it("Should initialize with correct parameters", async function () {
            const { bondingCurve, token, tokenDeveloper, testConfig } =
                await loadFixture(deployBondingCurveFixture);

            // Get the full structs
            const tokenConfig = await bondingCurve.tokenConfig();
            const bondingCurveConfig = await bondingCurve.bondingCurveConfig();
            const feesEconomics = await bondingCurve.feesEconomics();

            // Access struct members using array indices or property names
            expect(tokenConfig.tokenAddress).to.equal(await token.getAddress());
            expect(tokenConfig.tokenDeveloper).to.equal(tokenDeveloper.address);
            expect(bondingCurveConfig.virtualTokenReserve).to.equal(testConfig.bondingCurveConfig.virtualTokenReserve);
            expect(bondingCurveConfig.virtualEthReserve).to.equal(testConfig.bondingCurveConfig.virtualEthReserve);
            expect(feesEconomics.platformSwapFeePercentage).to.equal(testConfig.feesEconomics.platformSwapFeePercentage);
            expect(await bondingCurve.isActive()).to.be.true;
        });
    });

    describe("Token Purchase", function () {
        it("Should calculate buy amount correctly", async function () {
            const { bondingCurve, user } = await loadFixture(deployBondingCurveFixture);

            const ethAmount = ethers.parseEther("1.01");
            const tokenConfig = await bondingCurve.tokenConfig();
            const initialBalance = await ethers.getContractAt("ERC20FixedSupply", tokenConfig.tokenAddress)
                .then((token) => token.balanceOf(user.address));

            await bondingCurve.connect(user).buy({ value: ethAmount });

            const finalBalance = await ethers.getContractAt("ERC20FixedSupply", tokenConfig.tokenAddress)
                .then((token) => token.balanceOf(user.address));

            expect(finalBalance).to.be.gt(initialBalance);
        });

        it("Should update reserves after purchase", async function () {
            const { bondingCurve, user } = await loadFixture(deployBondingCurveFixture);

            const ethAmount = ethers.parseEther("1");
            const initialEthReserve = await bondingCurve.ethReserve();
            const initialTokenReserve = await bondingCurve.tokenReserve();

            await bondingCurve.connect(user).buy({ value: ethAmount });

            const finalEthReserve = await bondingCurve.ethReserve();
            const finalTokenReserve = await bondingCurve.tokenReserve();

            expect(finalEthReserve).to.be.gt(initialEthReserve);
            expect(finalTokenReserve).to.be.lt(initialTokenReserve);
        });

        it("Should collect correct fees on purchase", async function () {
            const { bondingCurve, user, testConfig, feeSetter, referrer } =
                await loadFixture(deployBondingCurveFixture);

            const ethAmount = ethers.parseEther("1");
            const initialFeeRecipientBalance = await ethers.provider.getBalance(feeSetter);
            const initialReferrerBalance = await ethers.provider.getBalance(referrer.address);

            await bondingCurve.connect(user).buy({ value: ethAmount });

            const finalFeeRecipientBalance = await ethers.provider.getBalance(feeSetter);
            const finalReferrerBalance = await ethers.provider.getBalance(referrer.address);

            // Calculate expected platform and referral fees
            const totalFeePercentage = testConfig.feesEconomics.platformSwapFeePercentage +
                testConfig.feesEconomics.referralSwapFeePercentage;
            const totalFee = (ethAmount * BigInt(totalFeePercentage)) / BigInt(10000);

            const expectedPlatformFee = (totalFee * BigInt(testConfig.feesEconomics.platformSwapFeePercentage)) /
                BigInt(totalFeePercentage);
            const expectedReferralFee = (totalFee * BigInt(testConfig.feesEconomics.referralSwapFeePercentage)) /
                BigInt(totalFeePercentage);

            expect(finalFeeRecipientBalance - initialFeeRecipientBalance)
                .to.be.approximately(expectedPlatformFee, ethers.parseEther("0.01"));
            expect(finalReferrerBalance - initialReferrerBalance)
                .to.be.equal(0); // Referral fees are accumulated, not instantly transferred
        });

        it("Should accumulate and allow claiming of referral fees", async function () {
            const { bondingCurve, user, referrer } = await loadFixture(deployBondingCurveFixture);

            // Make a purchase to generate referral fees
            await bondingCurve.connect(user).buy({ value: ethers.parseEther("1") });

            // Check accumulated fees
            const accumulatedFees = await bondingCurve.totalReferralFees();
            expect(accumulatedFees).to.be.gt(0);

            // Claim fees
            const initialBalance = await ethers.provider.getBalance(referrer.address);
            await bondingCurve.connect(referrer).claimReferralFees();
            const finalBalance = await ethers.provider.getBalance(referrer.address);

            expect(finalBalance).to.be.gt(initialBalance);
            expect(await bondingCurve.totalReferralFees()).to.equal(0);
        });

        it("Should revert if curve is inactive", async function () {
            const { bondingCurve, user, testConfig } = await loadFixture(deployBondingCurveFixture);

            // Complete the bonding curve to make it inactive
            const requiredETH = await calculateRequiredETHWithFee(
                bondingCurve,
                testConfig.feesEconomics.platformSwapFeePercentage,
                testConfig.feesEconomics.referralSwapFeePercentage
            );
            await bondingCurve.connect(user).buy({ value: requiredETH });
            const requiredETH2 = await calculateRequiredETHWithFee(
                bondingCurve,
                testConfig.feesEconomics.platformSwapFeePercentage,
                testConfig.feesEconomics.referralSwapFeePercentage
            );

            // Verify curve is inactive
            expect(await bondingCurve.isActive()).to.be.false;

            // Try to buy after completion
            await expect(
                bondingCurve.connect(user).buy({ value: ethers.parseEther("1") })
            ).to.be.revertedWithCustomError(bondingCurve, "InactiveBondingCurve");
        });
    });

    describe("Token Sale", function () {
        async function setupTokenSale() {
            const fixture = await deployBondingCurveFixture();

            // Buy some tokens first with a substantial amount
            const buyAmount = ethers.parseEther("2");
            await fixture.bondingCurve.connect(fixture.user).buy({ value: buyAmount });

            const tokenConfig = await fixture.bondingCurve.tokenConfig();
            // Approve tokens for selling
            const token = await ethers.getContractAt(
                "ERC20FixedSupply",
                tokenConfig.tokenAddress
            );
            const userBalance = await token.balanceOf(fixture.user.address);
            await token.connect(fixture.user).approve(fixture.bondingCurve.getAddress(), userBalance);

            return { ...fixture, userBalance };
        }

        it("Should calculate sell amount correctly", async function () {
            const { bondingCurve, user, userBalance } = await loadFixture(setupTokenSale);

            const sellAmount = userBalance / BigInt(2);
            const initialEthBalance = await ethers.provider.getBalance(user.address);

            const tx = await bondingCurve.connect(user).sell(sellAmount);
            const receipt = await tx.wait();
            const gasCost = receipt!.gasUsed * receipt!.gasPrice;

            const finalEthBalance = await ethers.provider.getBalance(user.address);
            expect(finalEthBalance + gasCost).to.be.gt(initialEthBalance);
        });

        it("Should update reserves after sale", async function () {
            const { bondingCurve, user, userBalance } = await loadFixture(setupTokenSale);

            const sellAmount = userBalance / BigInt(2);
            const initialEthReserve = await bondingCurve.ethReserve();
            const initialTokenReserve = await bondingCurve.tokenReserve();

            await bondingCurve.connect(user).sell(sellAmount);

            const finalEthReserve = await bondingCurve.ethReserve();
            const finalTokenReserve = await bondingCurve.tokenReserve();

            expect(finalEthReserve).to.be.lt(initialEthReserve);
            expect(finalTokenReserve).to.equal(initialTokenReserve + sellAmount);
        });

        it("Should collect correct fees on sale", async function () {
            const { bondingCurve, user, testConfig, feeSetter, referrer, userBalance } =
                await loadFixture(setupTokenSale);

            const sellAmount = userBalance / BigInt(2);
            const initialFeeRecipientBalance = await ethers.provider.getBalance(feeSetter);
            const initialReferrerBalance = await ethers.provider.getBalance(referrer.address);

            await bondingCurve.connect(user).sell(sellAmount);

            const finalFeeRecipientBalance = await ethers.provider.getBalance(feeSetter);
            const finalReferrerBalance = await ethers.provider.getBalance(referrer.address);

            // Verify platform fees were collected
            expect(finalFeeRecipientBalance).to.be.gt(initialFeeRecipientBalance);
            // Verify referral fees were accumulated but not transferred
            expect(finalReferrerBalance).to.equal(initialReferrerBalance);
            // Verify there are accumulated referral fees
            expect(await bondingCurve.totalReferralFees()).to.be.gt(0);
        });

        it("Should revert if trying to sell more than balance", async function () {
            const { bondingCurve, user, token } = await loadFixture(setupTokenSale);

            const userBalance = await token.balanceOf(user.address);
            await expect(
                bondingCurve.connect(user).sell(userBalance + BigInt(1))
            ).to.be.reverted;
        });

        it("Should revert if curve is inactive", async function () {
            const { bondingCurve, user, userBalance, testConfig } = await loadFixture(setupTokenSale);

            // Complete the bonding curve
            const requiredETH = await calculateRequiredETHWithFee(
                bondingCurve,
                testConfig.feesEconomics.platformSwapFeePercentage,
                testConfig.feesEconomics.referralSwapFeePercentage
            );

            await bondingCurve.connect(user).buy({ value: requiredETH });

            // Verify curve is inactive
            expect(await bondingCurve.isActive()).to.be.false;

            // Try to sell after completion
            await expect(
                bondingCurve.connect(user).sell(userBalance)
            ).to.be.revertedWithCustomError(bondingCurve, "InactiveBondingCurve");
        });
    });
});
