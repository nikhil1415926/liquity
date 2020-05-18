import React, { useState } from "react";
import { Heading, Box, Card, Loader, Link, Icon } from "rimble-ui";

import { Decimal, Percent, Difference } from "@liquity/decimal";
import { Trove, Liquity } from "@liquity/lib";
import { EditableRow, StaticRow } from "./Editor";
import { LoadingOverlay } from "./LoadingOverlay";

type TroveEditorProps = {
  title: string;
  original: Trove;
  edited: Trove;
  setEdited: (trove: Trove) => void;
  changePending: boolean;
  price: Decimal;
};

export const TroveEditor: React.FC<TroveEditorProps> = ({
  title,
  original,
  edited,
  setEdited,
  changePending,
  price
}) => {
  const editingState = useState<string>();

  const collateralChange = Difference.between(edited.collateral, original.collateral.nonZero);
  const debtChange = Difference.between(edited.debt, original.debt.nonZero);

  const collateralRatio =
    (edited.collateral.nonZero || edited.debt.nonZero) && edited.collateralRatio(price);
  const collateralRatioPct = new Percent(collateralRatio || { toString: () => "N/A" });
  const collateralRatioChange = Difference.between(
    edited.collateralRatio(price),
    original.collateralRatio(price).finite
  );
  const collateralRatioChangePct = new Percent(collateralRatioChange);

  const isChanged = original.whatChanged(edited) !== undefined;

  return (
    <Card p={0}>
      <Heading
        as="h3"
        bg="lightgrey"
        pl={3}
        py={2}
        pr={2}
        display="flex"
        justifyContent="space-between"
        alignItems="center"
      >
        {title}
        <Box width="40px" height="40px">
          {isChanged && !changePending && (
            <Link
              color="text"
              hoverColor="danger"
              activeColor="danger"
              display="flex"
              alignItems="center"
              onClick={() => setEdited(original)}
            >
              <Icon name="Replay" size="40px" />
            </Link>
          )}
        </Box>
      </Heading>

      {changePending && (
        <LoadingOverlay>
          <Loader size="24px" color="text" />
        </LoadingOverlay>
      )}

      <Box p={2}>
        <EditableRow
          label="Collateral"
          amount={edited.collateral.prettify(4)}
          pendingAmount={collateralChange.nonZero?.prettify()}
          pendingColor={collateralChange.positive ? "success" : "danger"}
          unit="ETH"
          {...{ editingState }}
          editedAmount={edited.collateral.toString(4)}
          setEditedAmount={(editedCollateral: string) =>
            setEdited(edited.setCollateral(editedCollateral))
          }
        ></EditableRow>

        <EditableRow
          label="Debt"
          amount={edited.debt.prettify()}
          pendingAmount={debtChange.nonZero?.prettify()}
          pendingColor={debtChange.positive ? "danger" : "success"}
          unit="LQTY"
          {...{ editingState }}
          editedAmount={edited.debt.toString(2)}
          setEditedAmount={(editedDebt: string) => setEdited(edited.setDebt(editedDebt))}
        />

        <StaticRow
          label="Collateral ratio"
          amount={
            collateralRatio?.gt(10)
              ? "× " + collateralRatio.shorten()
              : collateralRatioPct.prettify()
          }
          color={
            collateralRatio?.gt(Liquity.CRITICAL_COLLATERAL_RATIO)
              ? "success"
              : collateralRatio?.gt(Liquity.MINIMUM_COLLATERAL_RATIO)
              ? "warning"
              : "danger"
          }
          pendingAmount={
            collateralRatioChange.positive?.absoluteValue?.gt(10)
              ? "++"
              : collateralRatioChange.negative?.absoluteValue?.gt(10)
              ? "--"
              : collateralRatioChangePct.nonZeroish(2)?.prettify()
          }
          pendingColor={collateralRatioChange.positive ? "success" : "danger"}
        />
      </Box>
    </Card>
  );
};
