// Runs once when the server starts: fixture mode cannot start in production or on mainnet.
import { checkMode } from "./lib/mode";

export function register() {
  checkMode();
}
