declare const unitBrand: unique symbol;

type Unit<Name extends string> = number & { readonly [unitBrand]: Name };

export type Bars = Unit<"bars">;
export type Fraction = Unit<"fraction">;
export type Litres = Unit<"litres">;
export type LitresPerMinute = Unit<"litres-per-minute">;
export type Metres = Unit<"metres">;
export type Minutes = Unit<"minutes">;
export type Seconds = Unit<"seconds">;

export function bars(value: number): Bars {
  return nonNegative(value, "bars") as Bars;
}

export function fraction(value: number): Fraction {
  if (!Number.isFinite(value) || value < 0 || value > 1) {
    throw new RangeError("fraction must be a finite number between 0 and 1");
  }

  return value as Fraction;
}

export function litres(value: number): Litres {
  return nonNegative(value, "litres") as Litres;
}

export function litresPerMinute(value: number): LitresPerMinute {
  return nonNegative(value, "litres per minute") as LitresPerMinute;
}

export function metres(value: number): Metres {
  return nonNegative(value, "metres") as Metres;
}

export function minutes(value: number): Minutes {
  return nonNegative(value, "minutes") as Minutes;
}

export function seconds(value: number): Seconds {
  return nonNegative(value, "seconds") as Seconds;
}

export function minutesToSeconds(value: Minutes): Seconds {
  return seconds(value * 60);
}

export function secondsToMinutes(value: Seconds): Minutes {
  return minutes(value / 60);
}

function nonNegative(value: number, name: string): number {
  if (!Number.isFinite(value) || value < 0) {
    throw new RangeError(`${name} must be a finite non-negative number`);
  }

  return value;
}
