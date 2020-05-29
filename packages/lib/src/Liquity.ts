import { Signer } from "@ethersproject/abstract-signer";
import { Event } from "@ethersproject/contracts";
import { BigNumberish, BigNumber } from "@ethersproject/bignumber";
import { Provider, BlockTag } from "@ethersproject/abstract-provider";
import { AddressZero } from "@ethersproject/constants";

import { Decimal, Decimalish, Difference } from "@liquity/decimal";

import {
  CDPManager,
  BorrowerOperations,
  SortedCDPs,
  PriceFeed,
  PoolManager,
  ActivePool,
  DefaultPool,
  StabilityPool,
  CLVToken,
  MultiCDPGetter
} from "../types";
import { LiquityContracts, LiquityContractAddresses, connectToContracts } from "./contracts";

interface Trovish {
  readonly collateral?: Decimalish;
  readonly debt?: Decimalish;
}

const calculateCollateralRatio = (collateral: Decimal, debt: Decimal, price: Decimalish) => {
  return collateral.mulDiv(price, debt);
};

type TroveChange = {
  collateralDifference?: Difference;
  debtDifference?: Difference;
};

export class Trove {
  readonly collateral: Decimal;
  readonly debt: Decimal;

  constructor({ collateral = 0, debt = 0 }: Trovish = {}) {
    this.collateral = Decimal.from(collateral);
    this.debt = Decimal.from(debt);
  }

  get isEmpty() {
    return this.collateral.isZero && this.debt.isZero;
  }

  collateralRatio(price: Decimalish): Decimal {
    return calculateCollateralRatio(this.collateral, this.debt, price);
  }

  collateralRatioIsBelowMinimum(price: Decimalish) {
    return this.collateralRatio(price).lt(Liquity.MINIMUM_COLLATERAL_RATIO);
  }

  collateralRatioIsBelowCritical(price: Decimalish) {
    return this.collateralRatio(price).lt(Liquity.CRITICAL_COLLATERAL_RATIO);
  }

  toString() {
    return `{ collateral: ${this.collateral}, debt: ${this.debt} }`;
  }

  equals(that: Trove) {
    return this.collateral.eq(that.collateral) && this.debt.eq(that.debt);
  }

  add({ collateral = 0, debt = 0 }: Trovish) {
    return new Trove({
      collateral: this.collateral.add(collateral),
      debt: this.debt.add(debt)
    });
  }

  addCollateral(collateral: Decimalish) {
    return this.add({ collateral });
  }

  addDebt(debt: Decimalish) {
    return this.add({ debt });
  }

  subtract({ collateral = 0, debt = 0 }: Trovish) {
    return new Trove({
      collateral: this.collateral.sub(collateral),
      debt: this.debt.sub(debt)
    });
  }

  subtractCollateral(collateral: Decimalish) {
    return this.subtract({ collateral });
  }

  subtractDebt(debt: Decimalish) {
    return this.subtract({ debt });
  }

  multiply(multiplier: Decimalish) {
    return new Trove({
      collateral: this.collateral.mul(multiplier),
      debt: this.debt.mul(multiplier)
    });
  }

  setCollateral(collateral: Decimalish) {
    return new Trove({
      collateral,
      debt: this.debt
    });
  }

  setDebt(debt: Decimalish) {
    return new Trove({
      collateral: this.collateral,
      debt
    });
  }

  whatChanged({ collateral, debt }: Trove) {
    const change: TroveChange = {};

    if (!collateral.eq(this.collateral)) {
      change.collateralDifference = Difference.between(collateral, this.collateral);
    }

    if (!debt.eq(this.debt)) {
      change.debtDifference = Difference.between(debt, this.debt);
    }

    return change;
  }

  applyCollateralDifference(collateralDifference?: Difference) {
    if (collateralDifference?.positive) {
      return this.addCollateral(collateralDifference.absoluteValue!);
    } else if (collateralDifference?.negative) {
      if (collateralDifference.absoluteValue!.lt(this.collateral)) {
        return this.subtractCollateral(collateralDifference.absoluteValue!);
      } else {
        return this.setCollateral(0);
      }
    } else {
      return this;
    }
  }

  applyDebtDifference(debtDifference?: Difference) {
    if (debtDifference?.positive) {
      return this.addDebt(debtDifference.absoluteValue!);
    } else if (debtDifference?.negative) {
      if (debtDifference.absoluteValue!.lt(this.collateral)) {
        return this.subtractDebt(debtDifference.absoluteValue!);
      } else {
        return this.setDebt(0);
      }
    } else {
      return this;
    }
  }

  apply({ collateralDifference, debtDifference }: TroveChange) {
    return this.applyCollateralDifference(collateralDifference).applyDebtDifference(debtDifference);
  }
}

interface TrovishWithPendingRewards extends Trovish {
  readonly stake?: Decimalish;
  readonly snapshotOfTotalRedistributed?: Trovish;
}

export class TroveWithPendingRewards extends Trove {
  readonly stake: Decimal;
  readonly snapshotOfTotalRedistributed: Trove;

  constructor({
    collateral = 0,
    debt = 0,
    stake = 0,
    snapshotOfTotalRedistributed
  }: TrovishWithPendingRewards = {}) {
    super({ collateral, debt });

    this.stake = Decimal.from(stake);
    this.snapshotOfTotalRedistributed = new Trove(snapshotOfTotalRedistributed);
  }

  applyRewards(totalRedistributed: Trove) {
    return this.add(
      totalRedistributed.subtract(this.snapshotOfTotalRedistributed).multiply(this.stake)
    );
  }

  equals(that: TroveWithPendingRewards) {
    return (
      super.equals(that) &&
      this.stake.eq(that.stake) &&
      this.snapshotOfTotalRedistributed.equals(that.snapshotOfTotalRedistributed)
    );
  }
}

// yeah, sounds stupid...
interface StabilityDepositish {
  readonly deposit?: Decimalish;
  readonly pendingCollateralGain?: Decimalish;
  readonly pendingDepositLoss?: Decimalish;
}

export class StabilityDeposit {
  readonly deposit: Decimal;
  readonly pendingCollateralGain: Decimal;
  readonly pendingDepositLoss: Decimal;

  get isEmpty() {
    return (
      this.deposit.isZero && this.pendingCollateralGain.isZero && this.pendingDepositLoss.isZero
    );
  }

  get depositAfterLoss() {
    return this.deposit.sub(this.pendingDepositLoss);
  }

  constructor({
    deposit = 0,
    pendingCollateralGain = 0,
    pendingDepositLoss = 0
  }: StabilityDepositish) {
    this.deposit = Decimal.from(deposit);
    this.pendingCollateralGain = Decimal.from(pendingCollateralGain);

    if (this.deposit.gt(pendingDepositLoss)) {
      this.pendingDepositLoss = Decimal.from(pendingDepositLoss);
    } else {
      this.pendingDepositLoss = this.deposit;
    }
  }

  toString() {
    return (
      "{\n" +
      `  deposit: ${this.deposit},\n` +
      `  pendingDepositLoss: ${this.pendingDepositLoss},\n` +
      `  pendingCollateralGain: ${this.pendingCollateralGain}\n` +
      "}"
    );
  }

  equals(that: StabilityDeposit) {
    return (
      this.deposit.eq(that.deposit) &&
      this.pendingDepositLoss.eq(that.pendingDepositLoss) &&
      this.pendingCollateralGain.eq(that.pendingCollateralGain)
    );
  }

  calculateDifference(that: StabilityDeposit) {
    if (!that.depositAfterLoss.eq(this.depositAfterLoss)) {
      return Difference.between(that.depositAfterLoss, this.depositAfterLoss);
    }
  }

  apply(difference: Difference) {
    if (difference.positive) {
      return new StabilityDeposit({ deposit: this.depositAfterLoss.add(difference.absoluteValue!) });
    } else if (difference.negative) {
      return new StabilityDeposit({
        deposit: difference.absoluteValue!.lt(this.depositAfterLoss)
          ? this.depositAfterLoss.sub(difference.absoluteValue!)
          : 0
      });
    } else {
      return this;
    }
  }
}

enum CDPStatus {
  nonExistent,
  active,
  closed
}

export type LiquityTransactionOverrides = {
  nonce?: BigNumberish | Promise<BigNumberish>;
  gasLimit?: BigNumberish | Promise<BigNumberish>;
  gasPrice?: BigNumberish | Promise<BigNumberish>;
};

export type LiquityCallOverrides = {
  blockTag?: BlockTag | Promise<BlockTag>;
  from?: string | Promise<string>;
};

const debouncingDelayMs = 50;

const debounce = (listener: (latestBlock: number) => void) => {
  let timeoutId: any = undefined;
  let latestBlock: number = 0;

  return (...args: any[]) => {
    const event = args[args.length - 1] as Event;

    if (event.blockNumber !== undefined && event.blockNumber > latestBlock) {
      latestBlock = event.blockNumber;
    }

    if (timeoutId !== undefined) {
      clearTimeout(timeoutId);
    }

    timeoutId = setTimeout(() => {
      listener(latestBlock);
      timeoutId = undefined;
    }, debouncingDelayMs);
  };
};

const decimalify = (bigNumber: BigNumber) => new Decimal(bigNumber);
const numberify = (bigNumber: BigNumber) => bigNumber.toNumber();

const computePendingReward = (snapshotValue: Decimal, currentValue: Decimal, stake: Decimal) => {
  const rewardPerStake = currentValue.sub(snapshotValue);
  const reward = rewardPerStake.mul(stake);

  return reward;
};

export class Liquity {
  public static readonly CRITICAL_COLLATERAL_RATIO: Decimal = Decimal.from(1.5);
  public static readonly MINIMUM_COLLATERAL_RATIO: Decimal = Decimal.from(1.1);

  public static useHint = true;

  public readonly userAddress?: string;

  private readonly cdpManager: CDPManager;
  private readonly borrowerOperations: BorrowerOperations;
  private readonly priceFeed: PriceFeed;
  private readonly sortedCDPs: SortedCDPs;
  private readonly clvToken: CLVToken;
  private readonly poolManager: PoolManager;
  private readonly activePool: ActivePool;
  private readonly defaultPool: DefaultPool;
  private readonly stabilityPool: StabilityPool;
  private readonly multiCDPgetter: MultiCDPGetter;

  constructor(contracts: LiquityContracts, userAddress?: string) {
    this.cdpManager = contracts.cdpManager;
    this.borrowerOperations = contracts.borrowerOperations;
    this.priceFeed = contracts.priceFeed;
    this.sortedCDPs = contracts.sortedCDPs;
    this.clvToken = contracts.clvToken;
    this.poolManager = contracts.poolManager;
    this.activePool = contracts.activePool;
    this.defaultPool = contracts.defaultPool;
    this.stabilityPool = contracts.stabilityPool;
    this.multiCDPgetter = contracts.multiCDPgetter;
    this.userAddress = userAddress;
  }

  static async connect(addresses: LiquityContractAddresses, signerOrProvider: Signer | Provider) {
    const userAddress = Signer.isSigner(signerOrProvider)
      ? await signerOrProvider.getAddress()
      : undefined;

    const contracts = connectToContracts(addresses, signerOrProvider);

    return new Liquity(contracts, userAddress);
  }

  private requireAddress(): string {
    if (!this.userAddress) {
      throw Error("An address is required");
    }
    return this.userAddress;
  }

  async getTotalRedistributed(overrides?: LiquityCallOverrides) {
    const [collateral, debt] = await Promise.all([
      this.cdpManager.L_ETH({ ...overrides }).then(decimalify),
      this.cdpManager.L_CLVDebt({ ...overrides }).then(decimalify)
    ]);

    return new Trove({ collateral, debt });
  }

  watchTotalRedistributed(onTotalRedistributedChanged: (totalRedistributed: Trove) => void) {
    const etherSent = this.activePool.filters.EtherSent();

    const redistributionListener = debounce((blockTag: number) => {
      this.getTotalRedistributed({ blockTag }).then(onTotalRedistributedChanged);
    });

    const etherSentListener = (toAddress: string, _amount: BigNumber, event: Event) => {
      if (toAddress === this.defaultPool.address) {
        redistributionListener(event);
      }
    };

    this.activePool.on(etherSent, etherSentListener);

    return () => {
      this.activePool.removeListener(etherSent, etherSentListener);
    };
  }

  async getTroveWithoutRewards(address = this.requireAddress(), overrides?: LiquityCallOverrides) {
    const [cdp, snapshot] = await Promise.all([
      this.cdpManager.CDPs(address, { ...overrides }),
      this.cdpManager.rewardSnapshots(address, { ...overrides })
    ]);

    if (cdp.status === CDPStatus.active) {
      return new TroveWithPendingRewards({
        collateral: new Decimal(cdp.coll),
        debt: new Decimal(cdp.debt),
        stake: new Decimal(cdp.stake),

        snapshotOfTotalRedistributed: {
          collateral: new Decimal(snapshot.ETH),
          debt: new Decimal(snapshot.CLVDebt)
        }
      });
    } else {
      return new TroveWithPendingRewards();
    }
  }

  watchTroveWithoutRewards(
    onTroveChanged: (trove: TroveWithPendingRewards) => void,
    address = this.requireAddress()
  ) {
    const { CDPCreated, CDPUpdated } = this.cdpManager.filters;
    const cdpEventFilters = [CDPCreated(address), CDPUpdated(address)];

    const troveListener = debounce((blockTag: number) => {
      this.getTroveWithoutRewards(address, { blockTag }).then(onTroveChanged);
    });

    cdpEventFilters.forEach(filter => this.cdpManager.on(filter, troveListener));

    return () => {
      cdpEventFilters.forEach(filter => this.cdpManager.removeListener(filter, troveListener));
    };
  }

  async getTrove(address = this.requireAddress(), overrides?: LiquityCallOverrides) {
    const [trove, totalRedistributed] = await Promise.all([
      this.getTroveWithoutRewards(address, { ...overrides }),
      this.getTotalRedistributed({ ...overrides })
    ] as const);

    return trove.applyRewards(totalRedistributed);
  }

  async _findHintForCollateralRatio(collateralRatio: Decimal, price: Decimal, address: string) {
    if (!Liquity.useHint) {
      return address;
    }

    const numberOfTroves = await this.getNumberOfTroves();

    if (!numberOfTroves || collateralRatio.infinite) {
      return AddressZero;
    }

    const numberOfTrials = BigNumber.from(Math.ceil(Math.sqrt(numberOfTroves))); // XXX not multiplying by 10 here

    const approxHint = await this.cdpManager.getApproxHint(
      collateralRatio.bigNumber,
      numberOfTrials
    );

    const { 0: hint } = await this.sortedCDPs.findInsertPosition(
      collateralRatio.bigNumber,
      price.bigNumber,
      approxHint,
      approxHint
    );

    return hint;
  }

  _findHint(trove: Trove, price: Decimal, address: string) {
    if (trove instanceof TroveWithPendingRewards) {
      throw new Error("Rewards must be applied to this Trove");
    }

    return this._findHintForCollateralRatio(trove.collateralRatio(price), price, address);
  }

  async openTrove(trove: Trove, price: Decimalish, overrides?: LiquityTransactionOverrides) {
    const address = this.requireAddress();

    return this.borrowerOperations.openLoan(
      trove.debt.bigNumber,
      await this._findHint(trove, Decimal.from(price), address),
      { value: trove.collateral.bigNumber, ...overrides }
    );
  }

  async closeTrove(overrides?: LiquityTransactionOverrides) {
    return this.borrowerOperations.closeLoan({ ...overrides });
  }

  async depositEther(
    initialTrove: Trove,
    depositedEther: Decimalish,
    price: Decimalish,
    overrides?: LiquityTransactionOverrides,
    address = this.requireAddress()
  ) {
    const finalTrove = initialTrove.addCollateral(depositedEther);

    return this.borrowerOperations.addColl(
      address,
      await this._findHint(finalTrove, Decimal.from(price), address),
      {
        value: Decimal.from(depositedEther).bigNumber,
        ...overrides
      }
    );
  }

  async withdrawEther(
    initialTrove: Trove,
    withdrawnEther: Decimalish,
    price: Decimalish,
    overrides?: LiquityTransactionOverrides
  ) {
    const address = this.requireAddress();
    const finalTrove = initialTrove.subtractCollateral(withdrawnEther);

    return this.borrowerOperations.withdrawColl(
      Decimal.from(withdrawnEther).bigNumber,
      await this._findHint(finalTrove, Decimal.from(price), address),
      { ...overrides }
    );
  }

  async borrowQui(
    initialTrove: Trove,
    borrowedQui: Decimalish,
    price: Decimalish,
    overrides?: LiquityTransactionOverrides
  ) {
    const address = this.requireAddress();
    const finalTrove = initialTrove.addDebt(borrowedQui);

    return this.borrowerOperations.withdrawCLV(
      Decimal.from(borrowedQui).bigNumber,
      await this._findHint(finalTrove, Decimal.from(price), address),
      { ...overrides }
    );
  }

  async repayQui(
    initialTrove: Trove,
    repaidQui: Decimalish,
    price: Decimalish,
    overrides?: LiquityTransactionOverrides
  ) {
    const address = this.requireAddress();
    const finalTrove = initialTrove.subtractDebt(repaidQui);

    return this.borrowerOperations.repayCLV(
      Decimal.from(repaidQui).bigNumber,
      await this._findHint(finalTrove, Decimal.from(price), address),
      { ...overrides }
    );
  }

  async changeTrove(
    initialTrove: Trove,
    change: TroveChange,
    price: Decimalish,
    overrides?: LiquityTransactionOverrides
  ) {
    const address = this.requireAddress();
    const finalTrove = initialTrove.apply(change);

    return this.borrowerOperations.adjustLoan(
      change.collateralDifference?.negative?.absoluteValue?.bigNumber || 0,
      change.debtDifference?.bigNumber || 0,
      await this._findHint(finalTrove, Decimal.from(price), address),
      {
        ...overrides,
        value: change.collateralDifference?.positive?.absoluteValue?.bigNumber
      }
    );
  }

  getNumberOfTroves(overrides?: LiquityCallOverrides) {
    return this.cdpManager.getCDPOwnersCount({ ...overrides }).then(numberify);
  }

  watchNumberOfTroves(onNumberOfTrovesChanged: (numberOfTroves: number) => void) {
    const { CDPUpdated } = this.cdpManager.filters;
    const cdpUpdated = CDPUpdated();

    const cdpUpdatedListener = debounce((blockTag: number) => {
      this.getNumberOfTroves({ blockTag }).then(onNumberOfTrovesChanged);
    });

    this.cdpManager.on(cdpUpdated, cdpUpdatedListener);

    return () => {
      this.cdpManager.removeListener(cdpUpdated, cdpUpdatedListener);
    };
  }

  async getPrice(overrides?: LiquityCallOverrides) {
    return new Decimal(await this.priceFeed.getPrice({ ...overrides }));
  }

  watchPrice(onPriceChanged: (price: Decimal) => void) {
    const { PriceUpdated } = this.priceFeed.filters;
    const priceUpdated = PriceUpdated();

    const priceUpdatedListener = debounce((blockTag: number) => {
      this.getPrice({ blockTag }).then(onPriceChanged);
    });

    this.priceFeed.on(priceUpdated, priceUpdatedListener);

    return () => {
      this.priceFeed.removeListener(priceUpdated, priceUpdatedListener);
    };
  }

  async setPrice(price: Decimalish, overrides?: LiquityTransactionOverrides) {
    return this.priceFeed.setPrice(Decimal.from(price).bigNumber, { ...overrides });
  }

  async updatePrice(overrides?: LiquityTransactionOverrides) {
    return this.priceFeed.updatePrice_Testnet({ ...overrides });
  }

  async getTotal(overrides?: LiquityCallOverrides) {
    const [activeCollateral, activeDebt, liquidatedCollateral, closedDebt] = await Promise.all(
      [
        this.poolManager.getActiveColl({ ...overrides }),
        this.poolManager.getActiveDebt({ ...overrides }),
        this.poolManager.getLiquidatedColl({ ...overrides }),
        this.poolManager.getClosedDebt({ ...overrides })
      ].map(getBigNumber => getBigNumber.then(decimalify))
    );

    return new Trove({
      collateral: activeCollateral.add(liquidatedCollateral),
      debt: activeDebt.add(closedDebt)
    });
  }

  watchTotal(onTotalChanged: (total: Trove) => void) {
    const { CDPUpdated } = this.cdpManager.filters;
    const cdpUpdated = CDPUpdated();

    const totalListener = debounce((blockTag: number) => {
      this.getTotal({ blockTag }).then(onTotalChanged);
    });

    this.cdpManager.on(cdpUpdated, totalListener);

    return () => {
      this.cdpManager.removeListener(cdpUpdated, totalListener);
    };
  }

  async liquidate(address: string, overrides?: LiquityTransactionOverrides) {
    return this.cdpManager.liquidate(address, { ...overrides });
  }

  async liquidateUpTo(
    maximumNumberOfTrovesToLiquidate: number,
    overrides?: LiquityTransactionOverrides
  ) {
    return this.cdpManager.liquidateCDPs(maximumNumberOfTrovesToLiquidate, { ...overrides });
  }

  async getStabilityDeposit(address = this.requireAddress(), overrides?: LiquityCallOverrides) {
    const [deposit, snapshot, S_ETH, S_CLV] = await Promise.all([
      this.poolManager.deposit(address, { ...overrides }).then(decimalify),
      this.poolManager.snapshot(address, { ...overrides }),
      this.poolManager.S_ETH({ ...overrides }).then(decimalify),
      this.poolManager.S_CLV({ ...overrides }).then(decimalify)
    ]);

    const snapshotETH = new Decimal(snapshot.ETH);
    const snapshotCLV = new Decimal(snapshot.CLV);

    const pendingCollateralGain = computePendingReward(snapshotETH, S_ETH, deposit);
    const pendingDepositLoss = computePendingReward(snapshotCLV, S_CLV, deposit);

    return new StabilityDeposit({ deposit, pendingCollateralGain, pendingDepositLoss });
  }

  watchStabilityDeposit(
    onStabilityDepositChanged: (deposit: StabilityDeposit) => void,
    address = this.requireAddress()
  ) {
    const { UserDepositChanged } = this.poolManager.filters;
    const { EtherSent } = this.activePool.filters;

    const userDepositChanged = UserDepositChanged(address);
    const etherSent = EtherSent();

    const depositListener = debounce((blockTag: number) => {
      this.getStabilityDeposit(address, { blockTag }).then(onStabilityDepositChanged);
    });

    const etherSentListener = (toAddress: string, _amount: BigNumber, event: Event) => {
      if (toAddress === this.stabilityPool.address) {
        // Liquidation while Stability Pool has some deposits
        // There may be new gains
        depositListener(event);
      }
    };

    this.poolManager.on(userDepositChanged, depositListener);
    this.activePool.on(etherSent, etherSentListener);

    return () => {
      this.poolManager.removeListener(userDepositChanged, depositListener);
      this.activePool.removeListener(etherSent, etherSentListener);
    };
  }

  depositQuiInStabilityPool(depositedQui: Decimalish, overrides?: LiquityTransactionOverrides) {
    return this.poolManager.provideToSP(Decimal.from(depositedQui).bigNumber, { ...overrides });
  }

  withdrawQuiFromStabilityPool(withdrawnQui: Decimalish, overrides?: LiquityTransactionOverrides) {
    return this.poolManager.withdrawFromSP(Decimal.from(withdrawnQui).bigNumber, { ...overrides });
  }

  async transferCollateralGainToTrove(
    deposit: StabilityDeposit,
    initialTrove: Trove,
    price: Decimalish,
    overrides?: LiquityTransactionOverrides
  ) {
    const address = this.requireAddress();
    const finalTrove = initialTrove.addCollateral(deposit.pendingCollateralGain);

    return this.poolManager.withdrawFromSPtoCDP(
      address,
      await this._findHint(finalTrove, Decimal.from(price), address),
      { ...overrides }
    );
  }

  async getQuiInStabilityPool(overrides?: LiquityCallOverrides) {
    return new Decimal(await this.poolManager.getStabilityPoolCLV({ ...overrides }));
  }

  watchQuiInStabilityPool(onQuiInStabilityPoolChanged: (quiInStabilityPool: Decimal) => void) {
    const { Transfer } = this.clvToken.filters;

    const transferQuiFromStabilityPool = Transfer(this.stabilityPool.address);
    const transferQuiToStabilityPool = Transfer(null, this.stabilityPool.address);

    const stabilityPoolQuiFilters = [transferQuiFromStabilityPool, transferQuiToStabilityPool];

    const stabilityPoolQuiListener = debounce((blockTag: number) => {
      this.getQuiInStabilityPool({ blockTag }).then(onQuiInStabilityPoolChanged);
    });

    stabilityPoolQuiFilters.forEach(filter => this.clvToken.on(filter, stabilityPoolQuiListener));

    return () =>
      stabilityPoolQuiFilters.forEach(filter =>
        this.clvToken.removeListener(filter, stabilityPoolQuiListener)
      );
  }

  async getQuiBalance(address = this.requireAddress(), overrides?: LiquityCallOverrides) {
    return new Decimal(await this.clvToken.balanceOf(address, { ...overrides }));
  }

  watchQuiBalance(onQuiBalanceChanged: (balance: Decimal) => void, address = this.requireAddress()) {
    const { Transfer } = this.clvToken.filters;
    const transferQuiFromUser = Transfer(address);
    const transferQuiToUser = Transfer(null, address);

    const quiTransferFilters = [transferQuiFromUser, transferQuiToUser];

    const quiTransferListener = debounce((blockTag: number) => {
      this.getQuiBalance(address, { blockTag }).then(onQuiBalanceChanged);
    });

    quiTransferFilters.forEach(filter => this.clvToken.on(filter, quiTransferListener));

    return () =>
      quiTransferFilters.forEach(filter =>
        this.clvToken.removeListener(filter, quiTransferListener)
      );
  }

  sendQui(toAddress: string, amount: Decimalish, overrides?: LiquityTransactionOverrides) {
    return this.clvToken.transfer(toAddress, Decimal.from(amount).bigNumber, { ...overrides });
  }

  async _findRedemptionHints(
    exchangedQui: Decimal,
    price: Decimal
  ): Promise<[string, string, Decimal]> {
    if (!Liquity.useHint) {
      return [AddressZero, AddressZero, Decimal.INFINITY];
    }

    const {
      firstRedemptionHint,
      partialRedemptionHintICR
    } = await this.cdpManager.getRedemptionHints(exchangedQui.bigNumber, price.bigNumber);

    const collateralRatio = new Decimal(partialRedemptionHintICR);

    return [
      firstRedemptionHint,
      collateralRatio.nonZero
        ? await this._findHintForCollateralRatio(collateralRatio, price, AddressZero)
        : AddressZero,
      collateralRatio
    ];
  }

  async redeemCollateral(
    exchangedQui: Decimalish,
    price: Decimalish,
    overrides?: LiquityTransactionOverrides
  ) {
    exchangedQui = Decimal.from(exchangedQui);
    price = Decimal.from(price);

    const [
      firstRedemptionHint,
      partialRedemptionHint,
      partialRedemptionHintICR
    ] = await this._findRedemptionHints(exchangedQui, price);

    return this.cdpManager.redeemCollateral(
      exchangedQui.bigNumber,
      firstRedemptionHint,
      partialRedemptionHint,
      partialRedemptionHintICR.bigNumber,
      {
        ...overrides
      }
    );
  }

  async getLastTroves(startIdx: number, numberOfTroves: number, overrides?: LiquityCallOverrides) {
    const cdps = await this.multiCDPgetter.getMultipleSortedCDPs(-(startIdx + 1), numberOfTroves, {
      ...overrides
    });

    return cdps.map(
      ({ owner, coll, debt, stake, snapshotCLVDebt, snapshotETH }) =>
        [
          owner,

          new TroveWithPendingRewards({
            collateral: new Decimal(coll),
            debt: new Decimal(debt),
            stake: new Decimal(stake),

            snapshotOfTotalRedistributed: {
              collateral: new Decimal(snapshotETH),
              debt: new Decimal(snapshotCLVDebt)
            }
          })
        ] as const
    );
  }

  async _getFirstTroveAddress() {
    const first = await this.sortedCDPs.getFirst();

    return first !== AddressZero ? first : undefined;
  }

  async _getNextTroveAddress(address: string) {
    const next = await this.sortedCDPs.getNext(address);

    return next !== AddressZero ? next : undefined;
  }
}
