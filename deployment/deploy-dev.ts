import { network } from "hardhat";

import { deployContracts, postDeploy } from "./deploy";
import { Addr, FeesHandler } from "./config";
import { CHAIN_IDS, getChainSpecificFeeSetter } from "./pumpFactory.config";

const main = async () => {
  if (!["hardhat", "localhost", "formtestnet"].includes(network.name))
    throw Error(`Wrong network, you are in ${network.name}`);

  console.log("network.name", network.name);
  console.log("network.config.chainId", network.config.chainId);
  
  const feesHandler: FeesHandler = {
    feeRecipientSetter: getChainSpecificFeeSetter(CHAIN_IDS.FORM_TESTNET) as Addr,
    feeRecipient: getChainSpecificFeeSetter(CHAIN_IDS.FORM_TESTNET) as Addr,
  };
  const LPBlackHoleContract = null;
  await deployContracts(feesHandler, LPBlackHoleContract);

  const newOwner = feesHandler.feeRecipient;
  await postDeploy("0x511b8b057D9Ded5090fe99CA0e30fF7c00b63412");
};

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error);
    process.exit(1);
  });
