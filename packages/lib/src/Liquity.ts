import { Web3Provider } from "ethers/providers";
import { bigNumberify, BigNumber, BigNumberish } from "ethers/utils";

import { Decimal, Decimalish, Difference } from "../utils/Decimal";

import { CDPManager } from "../types/CDPManager";
import { CDPManagerFactory } from "../types/CDPManagerFactory";
import { SortedCDPs } from "../types/SortedCDPs";
import { SortedCDPsFactory } from "../types/SortedCDPsFactory";
import { PriceFeed } from "../types/PriceFeed";
import { PriceFeedFactory } from "../types/PriceFeedFactory";
import { PoolManager } from "../types/PoolManager";
import { PoolManagerFactory } from "../types/PoolManagerFactory";

interface Poolish {
  readonly activeCollateral: Decimalish;
  readonly activeDebt: Decimalish;
  readonly liquidatedCollateral: Decimalish;
  readonly closedDebt: Decimalish;
}

export class Pool {
  readonly activeCollateral: Decimal;
  readonly activeDebt: Decimal;
  readonly liquidatedCollateral: Decimal;
  readonly closedDebt: Decimal;

  constructor({ activeCollateral, activeDebt, liquidatedCollateral, closedDebt }: Poolish) {
    this.activeCollateral = Decimal.from(activeCollateral);
    this.activeDebt = Decimal.from(activeDebt);
    this.liquidatedCollateral = Decimal.from(liquidatedCollateral);
    this.closedDebt = Decimal.from(closedDebt);
  }

  get totalCollateral() {
    return this.activeCollateral.add(this.liquidatedCollateral);
  }

  get totalDebt() {
    return this.activeDebt.add(this.closedDebt);
  }

  totalCollateralRatioAt(price: Decimalish) {
    return calculateCollateralRatio(this.totalCollateral, this.totalDebt, price);
  }

  isRecoveryModeActiveAt(price: Decimalish) {
    return this.totalCollateralRatioAt(price).lt(1.5);
  }
}

interface Trovish {
  readonly collateral?: Decimalish;
  readonly debt?: Decimalish;
  readonly pendingCollateralReward?: Decimalish;
  readonly pendingDebtReward?: Decimalish;
}

const calculateCollateralRatio = (collateral: Decimal, debt: Decimal, price: Decimalish) => {
  if (debt.isZero) {
    return Decimal.INFINITY;
  }
  return collateral.mulDiv(price, debt);
};

export class Trove {
  readonly collateral: Decimal;
  readonly debt: Decimal;
  readonly pendingCollateralReward: Decimal;
  readonly pendingDebtReward: Decimal;

  get collateralAfterReward() {
    return this.collateral.add(this.pendingCollateralReward);
  }

  get debtAfterReward() {
    return this.debt.add(this.pendingDebtReward);
  }

  collateralRatioAt(price: Decimalish): Decimal {
    return calculateCollateralRatio(this.collateral, this.debt, price);
  }

  collateralRatioAfterRewardsAt(price: Decimalish): Decimal {
    return calculateCollateralRatio(this.collateralAfterReward, this.debtAfterReward, price);
  }

  isBelowMinimumCollateralRatioAt(price: Decimalish) {
    return this.collateralRatioAfterRewardsAt(price).lt(1.1);
  }

  constructor({
    collateral = 0,
    debt = 0,
    pendingCollateralReward = 0,
    pendingDebtReward = 0
  }: Trovish = {}) {
    this.collateral = Decimal.from(collateral);
    this.debt = Decimal.from(debt);
    this.pendingCollateralReward = Decimal.from(pendingCollateralReward);
    this.pendingDebtReward = Decimal.from(pendingDebtReward);
  }

  addCollateral(addedCollateral: Decimalish): Trove {
    return new Trove({
      collateral: this.collateralAfterReward.add(addedCollateral),
      debt: this.debtAfterReward
    });
  }

  addDebt(addedDebt: Decimalish): Trove {
    return new Trove({
      collateral: this.collateralAfterReward,
      debt: this.debtAfterReward.add(addedDebt)
    });
  }

  subtractCollateral(subtractedCollateral: Decimalish): Trove {
    return new Trove({
      collateral: this.collateralAfterReward.sub(subtractedCollateral),
      debt: this.debtAfterReward
    });
  }

  subtractDebt(subtractedDebt: Decimalish): Trove {
    return new Trove({
      collateral: this.collateralAfterReward,
      debt: this.debtAfterReward.sub(subtractedDebt)
    });
  }

  setCollateral(collateral: Decimalish): Trove {
    return new Trove({
      collateral,
      debt: this.debtAfterReward
    });
  }

  setDebt(debt: Decimalish): Trove {
    return new Trove({
      collateral: this.collateralAfterReward,
      debt
    });
  }

  whatChanged(that: Trove): { property: "collateral" | "debt"; difference: Difference } | undefined {
    if (!that.collateralAfterReward.eq(this.collateralAfterReward)) {
      return {
        property: "collateral",
        difference: Difference.between(that.collateralAfterReward, this.collateralAfterReward)
      };
    }
    if (!that.debtAfterReward.eq(this.debtAfterReward)) {
      return {
        property: "debt",
        difference: Difference.between(that.debtAfterReward, this.debtAfterReward)
      };
    }
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

  calculateDifference(that: StabilityDeposit) {
    if (!that.depositAfterLoss.eq(this.depositAfterLoss)) {
      return Difference.between(that.depositAfterLoss, this.depositAfterLoss);
    }
  }
}

enum CDPStatus {
  nonExistent,
  active,
  closed
}

export class Liquity {
  public static useHint = true;

  protected price?: Decimal;

  private readonly cdpManager: CDPManager;
  private readonly priceFeed: PriceFeed;
  private readonly sortedCDPs: SortedCDPs;
  private readonly poolManager: PoolManager;
  private readonly userAddress?: string;

  private constructor(
    cdpManager: CDPManager,
    priceFeed: PriceFeed,
    sortedCDPs: SortedCDPs,
    poolManager: PoolManager,
    userAddress?: string
  ) {
    this.cdpManager = cdpManager;
    this.priceFeed = priceFeed;
    this.sortedCDPs = sortedCDPs;
    this.poolManager = poolManager;
    this.userAddress = userAddress;
  }

  static async connect(cdpManagerAddress: string, provider: Web3Provider, userAddress?: string) {
    const signerOrProvider = userAddress ? provider.getSigner(userAddress) : provider;
    const cdpManager = CDPManagerFactory.connect(cdpManagerAddress, signerOrProvider);

    const [priceFeed, sortedCDPs, poolManager] = await Promise.all([
      cdpManager.priceFeedAddress().then(address => {
        return PriceFeedFactory.connect(address, signerOrProvider);
      }),
      cdpManager.sortedCDPsAddress().then(address => {
        return SortedCDPsFactory.connect(address, signerOrProvider);
      }),
      cdpManager.poolManagerAddress().then(address => {
        return PoolManagerFactory.connect(address, signerOrProvider);
      })
    ]);

    return new Liquity(cdpManager, priceFeed, sortedCDPs, poolManager, userAddress);
  }

  private requireAddress(): string {
    if (!this.userAddress) {
      throw Error("An address is required");
    }
    return this.userAddress;
  }

  private static computePendingReward(
    snapshotValue: Decimal,
    currentValue: Decimal,
    stake: Decimal
  ) {
    const rewardPerStake = currentValue.sub(snapshotValue);
    const reward = rewardPerStake.mul(stake);

    return reward;
  }

  async getTrove(address = this.requireAddress()): Promise<Trove | undefined> {
    const cdp = await this.cdpManager.CDPs(address);

    if (cdp.status !== CDPStatus.active) {
      return undefined;
    }

    const snapshot = await this.cdpManager.rewardSnapshots(address);
    const snapshotETH = new Decimal(snapshot.ETH);
    const snapshotCLVDebt = new Decimal(snapshot.CLVDebt);

    const L_ETH = new Decimal(await this.cdpManager.L_ETH());
    const L_CLVDebt = new Decimal(await this.cdpManager.L_CLVDebt());

    const stake = new Decimal(cdp.stake);
    const pendingCollateralReward = Liquity.computePendingReward(snapshotETH, L_ETH, stake);
    const pendingDebtReward = Liquity.computePendingReward(snapshotCLVDebt, L_CLVDebt, stake);

    return new Trove({
      collateral: new Decimal(cdp.coll),
      debt: new Decimal(cdp.debt),
      pendingCollateralReward,
      pendingDebtReward
    });
  }

  watchTrove(onTroveChanged: (trove: Trove | undefined) => void, address = this.requireAddress()) {
    const { CDPCreated, CDPUpdated, CDPClosed } = this.cdpManager.filters;

    const cdpCreated = CDPCreated(address, null);
    const cdpUpdated = CDPUpdated(address, null, null, null, null);
    const cdpClosed = CDPClosed(address);

    const cdpCreatedListener = () => {
      onTroveChanged(new Trove());
    };
    const cdpUpdatedListener = (_address: string, debt: BigNumber, collateral: BigNumber) => {
      // When a CDP is updated, pending rewards are applied to its collateral and debt, and then the
      // rewards are reset to 0. Therefore we don't need to calculate them here.
      onTroveChanged(new Trove({ collateral: new Decimal(collateral), debt: new Decimal(debt) }));
    };
    const cdpClosedListener = () => {
      onTroveChanged(undefined);
    };

    this.cdpManager.on(cdpCreated, cdpCreatedListener);
    this.cdpManager.on(cdpUpdated, cdpUpdatedListener);
    this.cdpManager.on(cdpClosed, cdpClosedListener);

    // TODO: we might want to setup a low-freq periodic task to check for any new rewards

    return () => {
      this.cdpManager.removeListener(cdpCreated, cdpCreatedListener);
      this.cdpManager.removeListener(cdpUpdated, cdpUpdatedListener);
      this.cdpManager.removeListener(cdpClosed, cdpClosedListener);
    };
  }

  private async findHint(trove: Trove, price: Decimalish, address: string) {
    if (!Liquity.useHint) {
      return address;
    }

    const numberOfTroves = (await this.getNumberOfTroves()).toNumber();

    if (!numberOfTroves) {
      return address;
    }

    const numberOfTrials = bigNumberify(Math.ceil(Math.sqrt(numberOfTroves))); // XXX not multiplying by 10 here
    const collateralRatio = trove.collateralRatioAfterRewardsAt(price).bigNumber;

    const approxHint = await this.cdpManager.getApproxHint(
      collateralRatio,
      bigNumberify(numberOfTrials)
    );

    const { 0: hint } = await this.sortedCDPs.findInsertPosition(
      collateralRatio,
      approxHint,
      approxHint
    );

    return hint;
  }

  async createTrove(trove: Trove, price: Decimalish) {
    const address = this.requireAddress();

    return this.cdpManager.openLoan(
      trove.debt.bigNumber,
      await this.findHint(trove, price, address),
      {
        value: trove.collateral.bigNumber
      }
    );
  }

  async depositEther(
    initialTrove: Trove,
    depositedEther: Decimalish,
    price: Decimalish,
    address = this.requireAddress()
  ) {
    const finalTrove = initialTrove.addCollateral(depositedEther);

    return this.cdpManager.addColl(address, await this.findHint(finalTrove, price, address), {
      value: Decimal.from(depositedEther).bigNumber
    });
  }

  async withdrawEther(initialTrove: Trove, withdrawnEther: Decimalish, price: Decimalish) {
    const address = this.requireAddress();
    const finalTrove = initialTrove.subtractCollateral(withdrawnEther);

    return this.cdpManager.withdrawColl(
      Decimal.from(withdrawnEther).bigNumber,
      await this.findHint(finalTrove, price, address)
    );
  }

  async borrowQui(initialTrove: Trove, borrowedQui: Decimalish, price: Decimalish) {
    const address = this.requireAddress();
    const finalTrove = initialTrove.addDebt(borrowedQui);

    return this.cdpManager.withdrawCLV(
      Decimal.from(borrowedQui).bigNumber,
      await this.findHint(finalTrove, price, address)
    );
  }

  async repayQui(initialTrove: Trove, repaidQui: Decimalish, price: Decimalish) {
    const address = this.requireAddress();
    const finalTrove = initialTrove.subtractDebt(repaidQui);

    return this.cdpManager.repayCLV(
      Decimal.from(repaidQui).bigNumber,
      await this.findHint(finalTrove, price, address)
    );
  }

  getNumberOfTroves() {
    return this.cdpManager.getCDPOwnersCount();
  }

  async getPrice() {
    return new Decimal(await this.priceFeed.getPrice());
  }

  watchPrice(onPriceChanged: (price: Decimal) => void) {
    const { PriceUpdated } = this.priceFeed.filters;
    const priceUpdated = PriceUpdated(null);

    const priceUpdatedListener = (price: BigNumber) => {
      onPriceChanged(new Decimal(price));
    };

    this.priceFeed.on(priceUpdated, priceUpdatedListener);

    return () => {
      this.priceFeed.removeListener(priceUpdated, priceUpdatedListener);
    };
  }

  async setPrice(price: Decimalish) {
    return this.priceFeed.setPrice(Decimal.from(price).bigNumber);
  }

  async getPool() {
    const [activeCollateral, activeDebt, liquidatedCollateral, closedDebt] = await Promise.all(
      [
        this.poolManager.getActiveColl(),
        this.poolManager.getActiveDebt(),
        this.poolManager.getLiquidatedColl(),
        this.poolManager.getClosedDebt()
      ].map(promise => promise.then(bigNumber => new Decimal(bigNumber)))
    );

    return new Pool({ activeCollateral, activeDebt, liquidatedCollateral, closedDebt });
  }

  async liquidate(maximumNumberOfCDPsToLiquidate: BigNumberish) {
    return this.cdpManager.liquidateCDPs(maximumNumberOfCDPsToLiquidate);
  }

  async getStabilityDeposit(address: string = this.requireAddress()) {
    const deposit = new Decimal(await this.poolManager.deposit(address));

    const snapshot = await this.poolManager.snapshot(address);
    const snapshotETH = new Decimal(snapshot.ETH);
    const snapshotCLV = new Decimal(snapshot.CLV);

    const S_ETH = new Decimal(await this.poolManager.S_ETH());
    const S_CLV = new Decimal(await this.poolManager.S_CLV());

    const pendingCollateralGain = Liquity.computePendingReward(snapshotETH, S_ETH, deposit);
    const pendingDepositLoss = Liquity.computePendingReward(snapshotCLV, S_CLV, deposit);

    return new StabilityDeposit({ deposit, pendingCollateralGain, pendingDepositLoss });
  }

  watchStabilityDeposit(
    onStabilityDepositChanged: (deposit: StabilityDeposit) => void,
    address: string = this.requireAddress()
  ) {
    const { UserDepositChanged } = this.poolManager.filters;
    const userDepositChanged = UserDepositChanged(address, null);

    const userDepositChangedListener = (_address: string, deposit: BigNumber) => {
      onStabilityDepositChanged(new StabilityDeposit({ deposit: new Decimal(deposit) }));
    };

    this.poolManager.on(userDepositChanged, userDepositChangedListener);

    return () => {
      this.poolManager.removeListener(userDepositChanged, userDepositChangedListener);
    };
  }

  depositQuiInStabilityPool(depositedQui: Decimal) {
    return this.poolManager.provideToSP(depositedQui.bigNumber);
  }

  withdrawQuiFromStabilityPool(withdrawnQui: Decimal) {
    return this.poolManager.withdrawFromSP(withdrawnQui.bigNumber);
  }
}
