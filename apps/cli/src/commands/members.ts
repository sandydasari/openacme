import {
  loadConfig,
  resolveDataDir,
  reachableBaseUrl,
  type Config,
} from "@openacme/config";
import { createDatabase, createAuthStore, type AuthStore } from "@openacme/db";

interface MembersOpts {
  dataDir?: string;
}

function open(opts: MembersOpts): {
  store: AuthStore;
  config: Config;
  db: ReturnType<typeof createDatabase>;
} {
  const config = loadConfig(resolveDataDir(opts.dataDir));
  const db = createDatabase(config);
  return { store: createAuthStore(db), config, db };
}

/** Print the substitution hint when the daemon is exposed — the printed host
 *  is a best guess; a domain/proxy user reaches it by a different name. */
function exposedHint(): void {
  console.log(
    "  Open it from your own machine. If you reach this server by a domain"
  );
  console.log("  or public IP, use that in place of the host above.");
  console.log("");
}

export async function membersListCommand(opts: MembersOpts): Promise<void> {
  const { store, db } = open(opts);
  try {
    const members = store.listMembers();
    if (members.length === 0) {
      console.log("No members yet. Run `openacme claim` to create the operator account.");
      return;
    }
    for (const m of members) console.log(`  ${m.email}`);
  } finally {
    db.close();
  }
}

export async function membersRevokeCommand(email: string, opts: MembersOpts): Promise<void> {
  const { store, db } = open(opts);
  try {
    const all = store.listMembers();
    const target = all.find((m) => m.email === email.trim().toLowerCase());
    if (!target) {
      console.error(`No member with email: ${email}`);
      process.exitCode = 1;
      return;
    }
    if (all.length === 1) {
      console.error("Cannot remove the only member — that would lock everyone out.");
      process.exitCode = 1;
      return;
    }
    store.deleteMember(target.id);
    console.log(`✓ removed ${target.email}; their sessions are now invalid.`);
  } finally {
    db.close();
  }
}

export async function inviteCommand(opts: MembersOpts): Promise<void> {
  const { store, config, db } = open(opts);
  try {
    const { token } = store.createEnrollToken();
    const { url, exposed } = reachableBaseUrl(config.server);
    console.log("Share this one-time invite link (valid 7 days):");
    console.log("");
    console.log(`    ${url}/enroll?token=${token}`);
    console.log("");
    if (exposed) exposedHint();
  } finally {
    db.close();
  }
}

export async function claimCommand(opts: MembersOpts): Promise<void> {
  const { store, config, db } = open(opts);
  try {
    if (store.countMembers() > 0) {
      console.log("This instance is already claimed. Use `openacme invite` to add a member.");
      return;
    }
    const { token } = store.createEnrollToken();
    const { url, exposed } = reachableBaseUrl(config.server);
    console.log("Open this link to create the operator account:");
    console.log("");
    console.log(`    ${url}/setup?token=${token}`);
    console.log("");
    if (exposed) exposedHint();
  } finally {
    db.close();
  }
}
