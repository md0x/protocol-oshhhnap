const { assert } = require("chai");
const hre = require("hardhat");
const { web3, getContract, assertEventEmitted, findEvent } = hre;
const {
  didContractThrow,
  interfaceName,
  runDefaultFixture,
  TokenRolesEnum,
  ZERO_ADDRESS,
  RegistryRolesEnum,
} = require("@uma/common");
const { StandardMerkleTree } = require("@openzeppelin/merkle-tree");
// const { isEmpty } = require("lodash");
const { hexToUtf8, leftPad, rightPad, utf8ToHex, toWei, toBN /* randomHex, toChecksumAddress */ } = web3.utils;

// Tested contracts
const OptimisticGovernor = getContract("OptimisticGovernorTest");

// Helper contracts
const Finder = getContract("Finder");
const IdentifierWhitelist = getContract("IdentifierWhitelist");
const AddressWhitelist = getContract("AddressWhitelist");
const OptimisticOracleV3Test = getContract("OptimisticOracleV3Test");
const MockOracle = getContract("MockOracleAncillary");
const Timer = getContract("Timer");
const Store = getContract("Store");
const ERC20 = getContract("ExpandedERC20");
const TestnetERC20 = getContract("TestnetERC20");
const TestAvatar = getContract("TestAvatar");
const FullPolicyEscalationManager = getContract("FullPolicyEscalationManager");

const finalFee = toWei("100");
const liveness = 7200;
const bond = toWei("500");
const identifier = utf8ToHex("ZODIAC");
const totalBond = toBN(finalFee).add(toBN(bond)).toString();
const doubleTotalBond = toBN(totalBond).mul(toBN(2)).toString();
const rules = "https://bafybeigdyrzt5sfp7udm7hu76uh7y26nf3efuylqabf3oclgtqy55fbzdi.ipfs.dweb.link/";
const burnedBondPercentage = toWei("0.5");

describe("OptimisticGovernorV3", () => {
  let accounts, owner, proposer, disputer, rando, executor;

  let timer,
    finder,
    collateralWhitelist,
    store,
    identifierWhitelist,
    registry,
    bondToken,
    mockOracle,
    optimisticOracleV3,
    optimisticOracleModule,
    testToken,
    testToken2,
    avatar;

  const constructTransferTransaction = (destination, amount) => {
    return testToken.methods.transfer(destination, amount).encodeABI();
  };

  // const constructProposalDeleteTransaction = (proposalHash) => {
  //   return optimisticOracleModule.methods.deleteProposal(proposalHash).encodeABI();
  // };

  const advanceTime = async (timeIncrease) => {
    await timer.methods
      .setCurrentTime(Number(await timer.methods.getCurrentTime().call()) + timeIncrease)
      .send({ from: owner });
  };

  before(async function () {
    accounts = await web3.eth.getAccounts();
    [owner, proposer, disputer, rando, executor] = accounts;

    await runDefaultFixture(hre);

    timer = await Timer.deployed();
    finder = await Finder.deployed();
    collateralWhitelist = await AddressWhitelist.deployed();
    store = await Store.deployed();
    identifierWhitelist = await IdentifierWhitelist.deployed();
    registry = await getContract("Registry").deployed();
    testToken = await TestnetERC20.new("Test", "TEST", 18).send({ from: accounts[0] });
    testToken2 = await TestnetERC20.new("Test2", "TEST2", 18).send({ from: accounts[0] });

    // Deploy new MockOracle so that OptimisticOracle disputes can make price requests to it:
    mockOracle = await MockOracle.new(finder.options.address, timer.options.address).send({ from: owner });
    await finder.methods
      .changeImplementationAddress(utf8ToHex(interfaceName.Oracle), mockOracle.options.address)
      .send({ from: owner });
    await identifierWhitelist.methods.addSupportedIdentifier(identifier).send({ from: owner });

    // Deploy new OptimisticOracleV3 and register it with the Finder and Registry:
    // TODO: This should be moved to separate fixture. defaultCurrency is not added to the whitelist
    // and Store since it is not used in this test, but would be required when moved to a fixture.
    const defaultCurrency = await TestnetERC20.new("Default Currency", "DC", 18).send({ from: owner });
    optimisticOracleV3 = await OptimisticOracleV3Test.new(
      finder.options.address,
      defaultCurrency.options.address,
      liveness,
      timer.options.address
    ).send({ from: owner });
    await finder.methods
      .changeImplementationAddress(utf8ToHex(interfaceName.OptimisticOracleV3), optimisticOracleV3.options.address)
      .send({ from: owner });
    await registry.methods.addMember(RegistryRolesEnum.CONTRACT_CREATOR, owner).send({ from: owner });
    await registry.methods.registerContract([], optimisticOracleV3.options.address).send({ from: owner });
    await registry.methods.removeMember(RegistryRolesEnum.CONTRACT_CREATOR, owner).send({ from: owner });
  });

  beforeEach(async function () {
    // Deploy new contracts with clean state and perform setup:
    avatar = await TestAvatar.new().send({ from: owner });
    bondToken = await ERC20.new("BOND", "BOND", 18).send({ from: owner });
    await bondToken.methods.addMember(TokenRolesEnum.MINTER, owner).send({ from: owner });
    await collateralWhitelist.methods.addToWhitelist(bondToken.options.address).send({ from: owner });
    await store.methods.setFinalFee(bondToken.options.address, { rawValue: finalFee }).send({ from: owner });
    await optimisticOracleV3.methods.syncUmaParams(identifier, bondToken.options.address).send({ from: owner });

    optimisticOracleModule = await OptimisticGovernor.new(
      finder.options.address,
      avatar.options.address,
      bondToken.options.address,
      bond,
      rules,
      identifier,
      liveness,
      timer.options.address
    ).send({ from: owner });

    await avatar.methods.setModule(optimisticOracleModule.options.address).send({ from: owner });

    await bondToken.methods.mint(proposer, doubleTotalBond).send({ from: owner });
    await bondToken.methods.approve(optimisticOracleModule.options.address, doubleTotalBond).send({ from: proposer });
    await bondToken.methods.mint(disputer, totalBond).send({ from: owner });
    await bondToken.methods.approve(optimisticOracleV3.options.address, totalBond).send({ from: disputer });
  });
  it("Approved proposals can be executed by any address", async function () {
    // Issue some test tokens to the avatar address.
    await testToken.methods.allocateTo(avatar.options.address, toWei("3")).send({ from: accounts[0] });
    await testToken2.methods.allocateTo(avatar.options.address, toWei("2")).send({ from: accounts[0] });

    // Construct the transaction data to send the newly minted tokens to proposer and another address.
    const txnData1 = constructTransferTransaction(proposer, toWei("1"));
    const txnData2 = constructTransferTransaction(rando, toWei("2"));
    const txnData3 = constructTransferTransaction(proposer, toWei("2"));
    const operation = 0; // 0 for call, 1 for delegatecall

    // Send the proposal with multiple transactions.
    const transactions = [
      { to: testToken.options.address, operation, value: 0, data: txnData1 },
      { to: testToken.options.address, operation, value: 0, data: txnData2 },
      { to: testToken2.options.address, operation, value: 0, data: txnData3 },
    ];

    const explanation = utf8ToHex("These transactions were approved by majority vote on Snapshot.");

    // (1)

    // Let's suppose that these users vote correctly these amount
    const voteValues = [
      [accounts[0], "5000000000000000000", "0", "0"], // address, forVotes, againstVotes, abstainVotes
      [accounts[1], "0", "2500000000000000000", "0"], // address, forVotes, againstVotes, abstainVotes
    ];

    const forVotes = voteValues.reduce((acc, [_, v]) => acc.add(toBN(v)), toBN(0)).toString();
    const againstVotes = "0";
    const abstainVotes = "0";

    console.log(JSON.stringify(voteValues));

    // (2)
    const tree = StandardMerkleTree.of(voteValues, ["address", "uint256", "uint256", "uint256"]);

    // (3)
    console.log("Merkle Root:", tree.root);

    const proofData = {};
    for (const [i, v] of tree.entries()) {
      // (3)
      const proof = tree.getProof(i);

      proofData[v[0]] = {
        voteFor: v[1],
        voteAgainst: v[2],
        voteAbstain: v[3],
        proof,
      };
    }
    const data = JSON.stringify(proofData);

    const calldata = web3.eth.abi.encodeParameters(
      [
        {
          type: "tuple",
          components: [
            { name: "forVotes", type: "uint256" },
            { name: "againstVotes", type: "uint256" },
            { name: "abstainVotes", type: "uint256" },
            { name: "voteMerkleRoot", type: "bytes32" },
            { name: "data", type: "string" },
          ],
        },
      ],
      [
        {
          forVotes,
          againstVotes,
          abstainVotes,
          voteMerkleRoot: tree.root,
          data,
        },
      ]
    );

    let receipt = await optimisticOracleModule.methods
      .proposeTransactionsWithResolution(transactions, explanation, calldata)
      .send({ from: proposer });

    const { proofs, assertionId } = (
      await findEvent(receipt, optimisticOracleModule, "VoteResolved")
    ).match.returnValues;

    console.log(JSON.stringify(proofs));

    let receipt2 = await optimisticOracleModule.methods
      .congratulate(
        assertionId,
        JSON.parse(proofs)[accounts[0]].voteFor,
        JSON.parse(proofs)[accounts[0]].voteAgainst,
        JSON.parse(proofs)[accounts[0]].voteAbstain,
        JSON.parse(proofs)[accounts[0]].proof
      )
      .send({ from: accounts[0] });

    const { user } = (await findEvent(receipt2, optimisticOracleModule, "Congratulated")).match.returnValues;

    // Check that user is congratulated
    assert.equal(user, accounts[0]);

    const { proposalHash } = (
      await findEvent(receipt, optimisticOracleModule, "TransactionsProposed")
    ).match.returnValues;

    const proposalTime = parseInt(await optimisticOracleModule.methods.getCurrentTime().call());
    const endingTime = proposalTime + liveness;

    // const assertionId = await optimisticOracleModule.methods.assertionIds(proposalHash).call();

    await assertEventEmitted(
      receipt,
      optimisticOracleModule,
      "TransactionsProposed",
      (event) =>
        event.proposer == proposer &&
        event.proposalTime == proposalTime &&
        event.proposalHash == proposalHash &&
        event.explanation == explanation &&
        event.rules == rules &&
        event.challengeWindowEnds == endingTime &&
        event.proposal.requestTime == proposalTime &&
        event.proposal.transactions[0].to == testToken.options.address &&
        event.proposal.transactions[0].value == 0 &&
        event.proposal.transactions[0].data == txnData1 &&
        event.proposal.transactions[0].operation == 0 &&
        event.proposal.transactions[1].to == testToken.options.address &&
        event.proposal.transactions[1].value == 0 &&
        event.proposal.transactions[1].data == txnData2 &&
        event.proposal.transactions[1].operation == 0 &&
        event.proposal.transactions[2].to == testToken2.options.address &&
        event.proposal.transactions[2].value == 0 &&
        event.proposal.transactions[2].data == txnData3 &&
        event.proposal.transactions[2].operation == 0
    );

    // Wait until the end of the dispute period.
    await advanceTime(liveness);

    // Set starting balances of tokens to be transferred.
    const startingBalance1 = toBN(await testToken.methods.balanceOf(proposer).call());
    const startingBalance2 = toBN(await testToken.methods.balanceOf(rando).call());
    const startingBalance3 = toBN(await testToken2.methods.balanceOf(proposer).call());

    receipt = await optimisticOracleModule.methods.executeProposal(transactions).send({ from: executor });
    assert.equal(
      (await testToken.methods.balanceOf(proposer).call()).toString(),
      startingBalance1.add(toBN(toWei("1"))).toString()
    );
    assert.equal(
      (await testToken.methods.balanceOf(rando).call()).toString(),
      startingBalance2.add(toBN(toWei("2"))).toString()
    );
    assert.equal(
      (await testToken2.methods.balanceOf(proposer).call()).toString(),
      startingBalance3.add(toBN(toWei("2"))).toString()
    );

    await assertEventEmitted(
      receipt,
      optimisticOracleModule,
      "ProposalExecuted",
      (event) => event.proposalHash == proposalHash && event.assertionId == assertionId
    );
    for (let i = 0; i < 3; i++) {
      await assertEventEmitted(
        receipt,
        optimisticOracleModule,
        "TransactionExecuted",
        (event) => event.proposalHash == proposalHash && event.assertionId == assertionId && event.transactionIndex == i
      );
    }
  });
});
