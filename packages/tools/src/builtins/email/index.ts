// Side-effect imports — each module registers its tool at load time.
import "./list.js";
import "./search.js";
import "./read.js";
import "./send.js";
import "./reply.js";
import "./mark.js";

export { bindEmail, getEmailBindings, type EmailBindings } from "./bindings.js";
