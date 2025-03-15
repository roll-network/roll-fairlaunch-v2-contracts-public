// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {IPumpFactory} from "./interfaces/IPumpFactory.sol";
import {IWETH} from "./interfaces/IWETH.sol";
import {ILaunch} from "./interfaces/ILaunch.sol";
import {LPBlackHole} from "./LPBlackHole.sol";
import {BondingCurveTypes} from "./BondingCurveTypes.sol";
import {FeeSplitter} from "./FeeSplitter.sol";

import "@cryptoalgebra/integral-core/contracts/interfaces/IAlgebraFactory.sol";
import "@cryptoalgebra/integral-core/contracts/interfaces/IAlgebraPool.sol";
import "@cryptoalgebra/integral-periphery/contracts/interfaces/INonfungiblePositionManager.sol";

interface IERC721Receiver {
    function onERC721Received(address operator, address from, uint256 tokenId, bytes calldata data)
        external
        returns (bytes4);
}

contract BondingCurve is FeeSplitter, BondingCurveTypes {
    TokenConfig public tokenConfig;
    BondingCurveConfig public bondingCurveConfig;
    ExternalContracts public externalContracts;

    uint256 public ethReserve;
    uint256 public tokenReserve;

    uint256 public immutable TOTAL_ETH_TO_COMPLETE_CURVE;

    IPumpFactory private factoryContract;
    bool public isActive = true;
    int24 private TICK_EXTREME = 887220;

    event LogBuy(uint256 indexed amountBought, uint256 indexed totalCost, address indexed buyer);
    event LogSell(uint256 indexed amountSell, uint256 indexed reward, address indexed seller);
    event BondingCurveComplete(address indexed tokenAddress, address indexed liquidityPoolAddress);
    event LPTokenLocked(uint256 tokenId, address blackHoleAddress);

    error InactiveBondingCurve();
    error TransferFailed();
    error Forbidden();
    error InsufficientFunds();
    error ApproveFailed();

    /// @notice Creates a new BondingCurve instance
    /// @dev Sets up initial parameters and connects to external contracts
    constructor(
        TokenConfig memory _tokenConfig,
        BondingCurveConfig memory _bondingCurveConfig,
        FeesEconomics memory _feesEconomics,
        ExternalContracts memory _externalContracts,
        address _referrer
    ) FeeSplitter(_preprocessFeeEconomics(_feesEconomics, _referrer), _referrer) {
        tokenConfig = _tokenConfig;
        bondingCurveConfig = _bondingCurveConfig;
        feesEconomics = _feesEconomics;
        externalContracts = _externalContracts;

        ethReserve = _bondingCurveConfig.virtualEthReserve;
        tokenReserve = _bondingCurveConfig.virtualTokenReserve;

        uint256 totalEthToCompleteCurve = _bondingCurveConfig.ethAmountForLiquidity
            + _feesEconomics.ethAmountForLiquidityFee + _feesEconomics.ethAmountForDevReward
            + _bondingCurveConfig.virtualEthReserve;

        TOTAL_ETH_TO_COMPLETE_CURVE = referrer == address(0)
            ? totalEthToCompleteCurve
            : totalEthToCompleteCurve + _feesEconomics.ethAmountForReferralReward;

        factoryContract = IPumpFactory(msg.sender);
    }

    /// @notice Preprocesses the fee economics
    /// @dev This function is used to preprocess the fee economics
    /// @param _feesEconomics The fees economics to preprocess
    /// @param referrer The referrer address
    /// @notice If the referrer is the zero address, the referral swap fee and referral reward are set to 0
    /// @return The preprocessed fees economics
    function _preprocessFeeEconomics(FeesEconomics memory _feesEconomics, address referrer)
        internal
        pure
        returns (FeesEconomics memory)
    {
        if (referrer == address(0)) {
            _feesEconomics.ethAmountForReferralReward = 0;
            _feesEconomics.referralSwapFeePercentage = 0;
        }
        return _feesEconomics;
    }

    /// @notice Deactivates the bonding curve
    /// @dev This function is called internally when the curve is completed
    function _deactivateBondingCurve() internal {
        isActive = false;
    }

    /// @notice Handles token purchase for a specified buyer
    /// @dev This internal function is called by the public buy functions
    /// @param buyer Address of the token buyer
    /// @return bool Returns true if the purchase was successful
    function _buyFor(address buyer) internal returns (bool) {
        if (!isActive) revert InactiveBondingCurve();
        require(msg.value > 0);

        (uint256 buyFee, uint256 platformFees, uint256 referrerFees) = calculateTradeFee(msg.value);
        uint256 effectiveEth = msg.value - buyFee;
        uint256 refund = 0;
        bool bondingCurveComplete = false;
        uint256 requiredEthToCompleteCurve = remainingEthToCompleteCurve();

        if (effectiveEth >= requiredEthToCompleteCurve) {
            effectiveEth = requiredEthToCompleteCurve;
            (buyFee,,) = calculateTradeFee(requiredEthToCompleteCurve);

            refund = msg.value - effectiveEth - buyFee;
            bondingCurveComplete = true;
            _deactivateBondingCurve();
        }

        uint256 tokensToTransfer = _getAmountOut(effectiveEth, ethReserve, tokenReserve);

        ethReserve += effectiveEth;
        tokenReserve -= tokensToTransfer;

        if (!IERC20(tokenConfig.tokenAddress).transfer(buyer, tokensToTransfer)) revert TransferFailed();

        // Transfer fees to the fee recipient
        _payFees(platformFees, referrerFees);

        if (refund > 0) {
            _safeTransferETH(buyer, refund);
        }

        emit LogBuy(tokensToTransfer, effectiveEth + buyFee, buyer);

        if (bondingCurveComplete) {
            _completeBondingCurve();

            _safeTransferETH(tokenConfig.tokenDeveloper, feesEconomics.ethAmountForDevReward);

            _payFees(feesEconomics.ethAmountForLiquidityFee, feesEconomics.ethAmountForReferralReward);
        }
        return true;
    }

    /// @notice Buys tokens for the message sender
    /// @return A boolean indicating whether the purchase was successful
    function buy() public payable returns (bool) {
        return _buyFor(msg.sender);
    }

    function buyFor(address buyer) external payable {
        if (msg.sender != address(factoryContract)) revert Forbidden();
        _buyFor(buyer);
    }

    /// @notice Sells a specified amount of tokens
    /// @param tokenAmount The amount of tokens to sell
    /// @return A boolean indicating whether the sale was successful
    function sell(uint256 tokenAmount) public returns (bool) {
        if (!isActive) revert InactiveBondingCurve();
        require(tokenAmount > 0);

        uint256 ethAmount = _getAmountOut(tokenAmount, tokenReserve, ethReserve);

        if (ethAmount > address(this).balance) revert InsufficientFunds();

        (uint256 sellFee, uint256 platformFees, uint256 referrerFees) = calculateTradeFee(ethAmount);
        uint256 effectiveEthAmount = ethAmount - sellFee;

        ethReserve -= ethAmount;
        tokenReserve += tokenAmount;

        _safeTransferETH(msg.sender, effectiveEthAmount);

        if (!IERC20(tokenConfig.tokenAddress).transferFrom(msg.sender, address(this), tokenAmount)) {
            revert TransferFailed();
        }

        // Transfer fees to the fee recipient
        _payFees(platformFees, referrerFees);

        emit LogSell(tokenAmount, ethAmount, msg.sender);
        return true;
    }

    /// @notice Completes the bonding curve by adding liquidity to Uniswap
    /// @dev This function is called internally when the curve is filled
    function _completeBondingCurve() internal {
        uint256 ethAmountToSendLP = bondingCurveConfig.ethAmountForLiquidity;
        uint256 tokenAmountToSendLP = IERC20(tokenConfig.tokenAddress).balanceOf(address(this));

        IWETH(externalContracts.weth).deposit{value: ethAmountToSendLP}();
        (address pool) = IAlgebraFactory(externalContracts.algebraFactory).createPool(
            address(tokenConfig.tokenAddress), externalContracts.weth, ""
        );

        (uint256 reserve0, uint256 reserve1) = address(tokenConfig.tokenAddress) < externalContracts.weth
            ? (tokenAmountToSendLP, ethAmountToSendLP)
            : (ethAmountToSendLP, tokenAmountToSendLP);

        IAlgebraPool(pool).initialize(getSqrtPriceX96(reserve0, reserve1));

        if (
            !IERC20(tokenConfig.tokenAddress).approve(
                address(externalContracts.algebraPositionManager), tokenAmountToSendLP
            )
        ) revert ApproveFailed();
        if (
            !IERC20(externalContracts.weth).approve(address(externalContracts.algebraPositionManager), ethAmountToSendLP)
        ) revert ApproveFailed();

        (uint256 tokenId,,,) = INonfungiblePositionManager(externalContracts.algebraPositionManager).mint(
            INonfungiblePositionManager.MintParams({
                token0: address(tokenConfig.tokenAddress) < externalContracts.weth
                    ? address(tokenConfig.tokenAddress)
                    : externalContracts.weth,
                token1: address(tokenConfig.tokenAddress) < externalContracts.weth
                    ? externalContracts.weth
                    : address(tokenConfig.tokenAddress),
                deployer: address(0),
                tickLower: -TICK_EXTREME,
                tickUpper: TICK_EXTREME,
                amount0Desired: reserve0,
                amount1Desired: reserve1,
                amount0Min: 0,
                amount1Min: 0,
                recipient: externalContracts.lpBlackHole,
                deadline: block.timestamp + 1
            })
        );
        emit LPTokenLocked(tokenId, externalContracts.lpBlackHole);

        ILaunch(tokenConfig.tokenAddress).launch();

        emit BondingCurveComplete(tokenConfig.tokenAddress, pool);
    }

    function _payFees(uint256 platformFees, uint256 referrerFees) internal override {
        if (platformFees > 0) {
            address feeRecipient = factoryContract.feeRecipient();
            _safeTransferETH(feeRecipient, platformFees);
        }
        if (referrer != address(0) && referrerFees > 0) {
            addReferralFees(referrerFees);
        }
    }

    /// @notice Calculates the remaining ETH needed to complete the curve
    /// @dev Subtracts the current ETH reserve from the total ETH needed
    /// @return The amount of ETH needed to complete the curve
    function remainingEthToCompleteCurve() public view returns (uint256) {
        return TOTAL_ETH_TO_COMPLETE_CURVE - ethReserve;
    }

    /// @notice Calculates the output amount for a given input in a constant product market maker
    /// @dev Uses the formula (dx * y) / (x + dx) to calculate the output
    /// @param amountIn The input amount
    /// @param reserveIn The reserve of the input token
    /// @param reserveOut The reserve of the output token
    /// @return The calculated output amount
    function _getAmountOut(uint256 amountIn, uint256 reserveIn, uint256 reserveOut) internal pure returns (uint256) {
        // (x + dx)(y - dy) = xy
        // dx.y - dx.dy - x.dy = 0
        // dx.y = dy(x + dx)
        // dx.y / (x + dx) = dy
        return (amountIn * reserveOut) / (reserveIn + amountIn);
    }

    // Calculate sqrtPriceX96 from reserveA and reserveB
    function getSqrtPriceX96(uint256 reserveA, uint256 reserveB) internal pure returns (uint160) {
        require(reserveA > 0 && reserveB > 0, "Reserves must be greater than 0");

        uint256 ratioX192 = reserveB * (2 ** 192 / reserveA); // Scale ratio by 2**192
        return uint160(_sqrt(ratioX192)); // Take the square root and cast to uint160
    }

    // Internal function to compute square root using the Babylonian method
    function _sqrt(uint256 x) internal pure returns (uint256) {
        if (x == 0) return 0;

        // Initial estimate
        uint256 z = (x + (2 ** 96)) / 2;
        uint256 y = x;

        while (z < y) {
            y = z;
            z = (x / z + z) / 2;
        }

        return y;
    }

    /// @notice Prevents accidental ETH transfers to the contract
    /// @dev This function reverts all incoming ETH transfers
    receive() external payable {
        revert();
    }
}
