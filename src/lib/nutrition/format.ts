import Decimal from "decimal.js";
/** Format exact API text only at the display boundary, using Polish decimal/grouping rules. */
export function formatNutritionValue(value: string, fixed = false): string {
  const rounded = new Decimal(value).toDecimalPlaces(2, Decimal.ROUND_HALF_UP);
  const [integer = "0", fraction] = rounded.toFixed(fixed ? 2 : undefined).split(".");
  const grouped =
    integer.replace("-", "").length > 4
      ? integer.replace(/\B(?=(\d{3})+(?!\d))/g, "\u00a0")
      : integer;
  return fraction === undefined ? grouped : `${grouped},${fraction}`;
}
