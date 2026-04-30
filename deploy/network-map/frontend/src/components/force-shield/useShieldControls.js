import { DEFAULT_SHIELD_CONFIG } from "./consts";

export function useShieldControls(_lifeRef) {
  return [DEFAULT_SHIELD_CONFIG, () => {}];
}
