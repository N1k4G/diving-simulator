export interface InputIntent {
  ascend: boolean;
  descend: boolean;
  finLeft: boolean;
  finRight: boolean;
  inflateBcd: boolean;
  ventBcd: boolean;
  toggleTorch: boolean;
  bailout: boolean;
  switchGasIndex: number | null;
}

export const NO_INPUT: Readonly<InputIntent> = Object.freeze({
  ascend: false,
  descend: false,
  finLeft: false,
  finRight: false,
  inflateBcd: false,
  ventBcd: false,
  toggleTorch: false,
  bailout: false,
  switchGasIndex: null,
});
