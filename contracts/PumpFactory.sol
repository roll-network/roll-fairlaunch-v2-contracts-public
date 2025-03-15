// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

import {ERC20} from "@openzeppelin/contracts/token/ERC20/ERC20.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IOwnable} from "./interfaces/IOwnable.sol";

import {ERC20FixedSupply} from "./ERC20FixedSupply.sol";
import {BondingCurve} from "./BondingCurve.sol";
import {LPBlackHole} from "./LPBlackHole.sol";
import {BondingCurveTypes} from "./BondingCurveTypes.sol";

contract PumpFactory is Ownable, BondingCurveTypes {
    struct TokenTypeConfig{
        string name;
        bool isActive;
        uint256 tokenTotalSupply;
        uint256 tokenCreationFee;
        BondingCurveConfig bondingCurveConfig;
        FeesEconomics feesEconomics;
    }    
    mapping(address => address) public getTokenBondingCurve;
    mapping(uint256 => TokenTypeConfig) public tokenTypes;
    uint256 public tokenTypesCount;

    address public feeRecipient;
    address public feeRecipientSetter;

    ExternalContracts public externalContracts;

    event TokenCreated(address indexed token, address indexed bondingCurve, uint256 configId);
    event TokenTypeAdded(uint256 indexed configId, TokenTypeConfig config);
    event TokenTypeUpdated(uint256 indexed configId, TokenTypeConfig config);
    event TokenTypeStatusUpdated(uint256 indexed configId, bool isActive);
    event LPBlackHoleUpdated(address oldLPBlackHole, address newLPBlackHole);

    error TransferFailed();
    error Forbidden();
    error InvalidPercentage();
    error InvalidTokenTypeId();
    error TokenTypeNotActive();
    error TokenTypeAlreadyExists();
    error TokenTypeNotFound();
    error InsufficientFee();
    error EmptyConfigName();

    constructor(
        address _feeRecipient,
        address _feeRecipientSetter,
        ExternalContracts memory _externalContracts
    ) Ownable(msg.sender) {
        feeRecipientSetter = _feeRecipientSetter;
        feeRecipient = _feeRecipient;

        externalContracts = _externalContracts;
    }

    function addTokenConfiguration(
        TokenTypeConfig memory config,
        string memory configName
    ) external onlyOwner returns (uint256) {
        if (config.feesEconomics.platformSwapFeePercentage > 10000) revert InvalidPercentage();
        if (config.feesEconomics.referralSwapFeePercentage > 10000) revert InvalidPercentage();
        if (bytes(configName).length == 0) revert EmptyConfigName();
        
        uint256 newConfigId = tokenTypesCount++;
        
        // Set the configuration with active status and name
        config.isActive = true;
        config.name = configName;
        tokenTypes[newConfigId] = config;
        
        emit TokenTypeAdded(newConfigId, config);
        return newConfigId;
    }

    function updateTokenConfiguration(
        uint256 configId,
        TokenTypeConfig memory config
    ) external onlyOwner {
        if (!_tokenTypeExists(configId)) revert TokenTypeNotFound();
        if (config.feesEconomics.platformSwapFeePercentage > 10000) revert InvalidPercentage();
        if (config.feesEconomics.referralSwapFeePercentage > 10000) revert InvalidPercentage();
        if (bytes(config.name).length == 0) revert EmptyConfigName();
        
        // Preserve the existing name if not provided in the update
        if (bytes(config.name).length == 0) {
            config.name = tokenTypes[configId].name;
        }
        
        tokenTypes[configId] = config;
        emit TokenTypeUpdated(configId, config);
    }

    function toggleTokenTypeStatus(uint256 configId) external onlyOwner {
        if (!_tokenTypeExists(configId)) revert TokenTypeNotFound();
        
        tokenTypes[configId].isActive = !tokenTypes[configId].isActive;
        emit TokenTypeStatusUpdated(configId, tokenTypes[configId].isActive);
    }

    function createToken(
        string memory name,
        string memory symbol,
        string memory tokenURI,
        uint256 configId, // token type id
        address tokenDeveloper,
        address referrer
    ) external payable returns (address) {
        // Validate config exists and is active
        if (!_tokenTypeExists(configId)) revert TokenTypeNotFound();
        if (!_isTokenTypeActive(configId)) revert TokenTypeNotActive();
        
        TokenTypeConfig memory config = tokenTypes[configId];
        if (msg.value < config.tokenCreationFee) revert InsufficientFee();
        
        uint256 msgValue = msg.value;

        ERC20FixedSupply token = new ERC20FixedSupply(
            name,
            symbol,
            config.tokenTotalSupply,
            tokenURI
        );

        TokenConfig memory _tokenConfig = TokenConfig({
            tokenAddress: address(token),
            tokenDeveloper: tokenDeveloper
        });

        BondingCurve bondingCurve = new BondingCurve(
            _tokenConfig,
            config.bondingCurveConfig,
            config.feesEconomics,
            externalContracts,
            referrer
        );

        if (!token.transfer(address(bondingCurve), token.totalSupply())) revert TransferFailed();

        getTokenBondingCurve[address(token)] = address(bondingCurve);

        IOwnable(address(token)).transferOwnership(address(bondingCurve));
        emit TokenCreated(address(token), address(bondingCurve), configId);

        _safeTransferETH(feeRecipient, config.tokenCreationFee);

        if (msg.value > config.tokenCreationFee) {
            bondingCurve.buyFor{value: msgValue - config.tokenCreationFee}(tokenDeveloper);
        }

        return address(token);
    }

    function _safeTransferETH(address to, uint256 amount) internal {
        (bool success,) = payable(to).call{value: amount}("");
        require(success, "ETH transfer failed");
    }

    function setFeeRecipientSetter(address _feeRecipientSetter) external {
        if (msg.sender != feeRecipientSetter) revert Forbidden();
        feeRecipientSetter = _feeRecipientSetter;
    }

    function setFeeRecipient(address _feeRecipient) external {
        if (msg.sender != feeRecipientSetter) revert Forbidden();
        feeRecipient = _feeRecipient;
    }

    // Internal helper functions for config validation
    function _tokenTypeExists(uint256 configId) internal view returns (bool) {
        return configId < tokenTypesCount && bytes(tokenTypes[configId].name).length > 0;
    }

    function _isTokenTypeActive(uint256 configId) internal view returns (bool) {
        return tokenTypes[configId].isActive;
    }

    // View functions for external use
    function getTokenTypeDetails(uint256 configId) 
        external 
        view 
        returns (TokenTypeConfig memory) 
    {
        if (!_tokenTypeExists(configId)) revert TokenTypeNotFound();
        return tokenTypes[configId];
    }

    function isTokenTypeActive(uint256 configId) external view returns (bool) {
        if (!_tokenTypeExists(configId)) revert TokenTypeNotFound();
        return _isTokenTypeActive(configId);
    }
    
    /// @notice Updates the LP black hole
    /// @dev Can only be called by the contract owner
    /// @param _newLPBlackHole The new address of lp blackhole contract
    function setLPBlackHole(address _newLPBlackHole) external onlyOwner {
        address oldLPBlackHole = externalContracts.lpBlackHole;
        require(_newLPBlackHole != oldLPBlackHole, "same as old lp black hole contract");
        externalContracts.lpBlackHole = _newLPBlackHole;
        emit LPBlackHoleUpdated(oldLPBlackHole, _newLPBlackHole);
    }
}
