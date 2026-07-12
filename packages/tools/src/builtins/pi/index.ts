// Side-effect import — registers the pi tool at load time.
import "./pi.js";

export { bindPi, getPiBindings, type PiBindings } from "./bindings.js";
