import { bars, type Bars } from "./units";

export interface BuhlmannCompartment {
  halfTimeMin: number;
  a: number;
  b: number;
}

export const WATER_VAPOR_PRESSURE_BAR = bars(0.0627);
export const SURFACE_N2_LOADING_BAR = bars(
  (1 - WATER_VAPOR_PRESSURE_BAR) * 0.79,
);
export const LN_2 = Math.log(2);

export const ZHL16C_N2: readonly BuhlmannCompartment[] = [
  { halfTimeMin: 5, a: 1.2599, b: 0.505 },
  { halfTimeMin: 8, a: 1, b: 0.6514 },
  { halfTimeMin: 12.5, a: 0.8618, b: 0.7222 },
  { halfTimeMin: 18.5, a: 0.7562, b: 0.7825 },
  { halfTimeMin: 27, a: 0.62, b: 0.8126 },
  { halfTimeMin: 38.3, a: 0.5043, b: 0.8434 },
  { halfTimeMin: 54.3, a: 0.441, b: 0.8693 },
  { halfTimeMin: 77, a: 0.4, b: 0.891 },
  { halfTimeMin: 109, a: 0.375, b: 0.9092 },
  { halfTimeMin: 146, a: 0.35, b: 0.9222 },
  { halfTimeMin: 187, a: 0.3295, b: 0.9319 },
  { halfTimeMin: 239, a: 0.3065, b: 0.9403 },
  { halfTimeMin: 305, a: 0.2835, b: 0.9477 },
  { halfTimeMin: 390, a: 0.261, b: 0.9544 },
  { halfTimeMin: 498, a: 0.248, b: 0.9602 },
  { halfTimeMin: 635, a: 0.2327, b: 0.9653 },
] as const satisfies readonly BuhlmannCompartment[];

export const ZHL16C_HE: readonly BuhlmannCompartment[] = [
  { halfTimeMin: 1.88, a: 1.6189, b: 0.477 },
  { halfTimeMin: 3.02, a: 1.383, b: 0.5747 },
  { halfTimeMin: 4.72, a: 1.1919, b: 0.6527 },
  { halfTimeMin: 6.99, a: 1.0458, b: 0.7223 },
  { halfTimeMin: 10.21, a: 0.922, b: 0.7582 },
  { halfTimeMin: 14.48, a: 0.8205, b: 0.7957 },
  { halfTimeMin: 20.53, a: 0.7305, b: 0.8279 },
  { halfTimeMin: 29.11, a: 0.6502, b: 0.8553 },
  { halfTimeMin: 41.2, a: 0.595, b: 0.8757 },
  { halfTimeMin: 55.19, a: 0.5545, b: 0.8903 },
  { halfTimeMin: 70.69, a: 0.5333, b: 0.8997 },
  { halfTimeMin: 90.34, a: 0.5189, b: 0.9073 },
  { halfTimeMin: 115.29, a: 0.5181, b: 0.9122 },
  { halfTimeMin: 147.42, a: 0.5176, b: 0.9171 },
  { halfTimeMin: 188.24, a: 0.5172, b: 0.9217 },
  { halfTimeMin: 240.03, a: 0.5119, b: 0.9267 },
] as const satisfies readonly BuhlmannCompartment[];

export const TISSUE_COMPARTMENT_COUNT = 16;

export function asTissuePressure(value: number): Bars {
  return bars(value);
}
