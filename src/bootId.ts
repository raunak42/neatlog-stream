import { randomUUID } from "node:crypto";

/**
 * Identifies this process. It changes on restart and differs between replicas,
 * which is what lets a client tell "same server, keep going" from "different
 * server, my cursors are meaningless".
 *
 * Both cases look identical otherwise: ids restart at 1 after a redeploy, and a
 * second replica has its own independent sequence — so a client comparing only
 * ids would silently mis-merge.
 */
export const BOOT_ID = randomUUID();
