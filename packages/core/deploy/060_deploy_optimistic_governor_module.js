require("dotenv").config();

// Deploys the mastercopy of the OptimisticGovernor contract. It is not intended to be used directly, but rather to be
// used when deploying minimal proxy contracts that delegate calls this mastercopy. Constructor arguments are arbitrary
// here, just to satisfy the requirements of OptimisticGovernor constructor and make sure that the mastercopy is not
// usable directly. Proxy contracts can be deployed using the ModuleProxyFactory from Gnosis Zodiac at
// https://github.com/gnosis/zodiac/blob/master/contracts/factory/ModuleProxyFactory.sol and passing encoded bytes data
// in its deployModule method's initializer parameter to call setUp on the deployed proxy contract.

const func = async function (hre) {
  const { deployments, getNamedAccounts } = hre;
  const { deploy } = deployments;

  const { deployer } = await getNamedAccounts();

  const Finder = await deployments.get("Finder");
  // const owner = "0x000000000000000000000000000000000000dEaD"; // Mastercopy contract should not be usable directly.
  const owner = "0x1b01f8B5399Ad8db1d037D1C7A3dA69613A4fE3F"; // safe address
  // const collateral = await deployments.read("OptimisticOracleV3", "defaultCurrency");
  const collateral = "0xB4FBF271143F4FBf7B91A5ded31805e42b2208d6";
  const bondAmount = "10000000000000000";

  const space = "https://demo.snapshot.org/#/oshhhnap.eth";
  const quorum = "0.01 tokens";
  const votingPeriod = "180 seconds";
  const rules =
    "I assert that this transaction proposal is valid according to the following rules: Proposals approved on" +
    " Snapshot, as verified at https://snapshot.org/#/" +
    space +
    ", are valid as long as there is a minimum quorum of " +
    quorum +
    " and a minimum voting period of " +
    votingPeriod +
    " hours and it does not appear that the Snapshot voting system is being exploited or is otherwise unavailable." +
    " The quorum and voting period are minimum requirements for a proposal to be valid. Quorum and voting period" +
    " values set for a specific proposal in Snapshot should be used if they are more strict than the rules" +
    " parameter. The explanation included with the on-chain proposal must be the unique IPFS identifier for the" +
    " specific Snapshot proposal that was approved or a unique identifier for a proposal in an alternative" +
    " voting system approved by DAO social consensus if Snapshot is being exploited or is otherwise unavailable.";
  const identifier = await deployments.read("OptimisticOracleV3", "defaultIdentifier");
  const liveness = 10;

  await deploy("OptimisticGovernor", {
    from: deployer,
    args: [Finder.address, owner, collateral, bondAmount, rules, identifier, liveness],
    log: true,
    skipIfAlreadyDeployed: false,
  });
};
module.exports = func;
func.tags = ["OptimisticGovernor"];
func.dependencies = ["Finder", "AddressWhitelist", "IdentifierWhitelist", "OptimisticOracleV3"];
