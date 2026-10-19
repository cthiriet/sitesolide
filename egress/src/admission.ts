/**
 * What every connection to the proxy is counted against, whichever of its two
 * ports it came to: a place among all of them, a share for its project, and
 * the bytes waiting in it for a slow end.
 *
 * One admission for the CONNECT port and the connectors' port together,
 * because what it bounds belongs to the process, not to a port: its file
 * descriptors and its memory, under the unit's LimitNOFILE and MemoryMax.
 * Counted per port, the connectors' port held whatever one project opened, and
 * once the descriptors ran out, every other project's CONNECT went unanswered.
 * The arithmetic of DEFAULT_LIMITS in proxy.ts holds for both ports at once.
 */

export type AdmissionLimits = {
  /** Open client connections, all projects and both ports together. */
  maxConnections: number;
  /** Open connections per project, both ports together. */
  maxPerProject: number;
  /** Bytes held for all of one project's connections, before every one of them stops reading. */
  projectBufferBytes: number;
  /** Bytes held for every connection, before the whole proxy stops reading. */
  totalBufferBytes: number;
};

/** One connection as the admission sees it. */
export type Member = {
  /** Its project's share, once the kernel named a project and the share had room. */
  share: Share | null;
  /** A budget was crossed: the connection's sides stop reading. */
  stopReading: () => void;
  /** The budgets allow it again: its sides may read. */
  startReading: () => void;
};

/** What one project holds of the proxy: its connections, the bytes waiting in them, and whether they read. */
export type Share = { slug: string; members: Set<Member>; held: number; blocked: boolean };

export type Admission = {
  /** Takes a place among every connection to the proxy; false when none is left. */
  enter: (member: Member) => boolean;
  /**
   * Counts the connection in its project's share, with the bytes it already
   * holds; returns the number the share holds when it is full, null once in.
   */
  join: (member: Member, slug: string, held: number) => number | null;
  /** The connection is gone: its place and its share are free. Its bytes are released apart, by account(). */
  leave: (member: Member) => void;
  /** Bytes that start or stop waiting in this connection. */
  account: (member: Member, bytes: number) => void;
  /** May this connection read, as far as the budgets go? */
  mayRead: (member: Member) => boolean;
  /** Connections on both ports. */
  open: () => number;
  /** Bytes waiting on both ports. */
  held: () => number;
};

export function createAdmission(limits: AdmissionLimits): Admission {
  const members = new Set<Member>();
  const shares = new Map<string, Share>();
  /** Bytes waiting in every connection; past totalBufferBytes, `saturated` until half has drained. */
  let held = 0;
  let saturated = false;

  /**
   * Stops or restarts reading where a budget is crossed: a whole project past
   * projectBufferBytes, the whole proxy past totalBufferBytes, until half has
   * drained. See DEFAULT_LIMITS in proxy.ts for why the mark of each
   * direction is not enough.
   */
  function overBudget(share: Share | null): void {
    if (share !== null && !share.blocked && share.held > limits.projectBufferBytes) {
      share.blocked = true;
      for (const each of share.members) each.stopReading();
    }
    if (!saturated && held > limits.totalBufferBytes) {
      saturated = true;
      for (const each of members) each.stopReading();
    }
  }

  function underBudget(share: Share | null): void {
    if (share !== null && share.blocked && share.held <= limits.projectBufferBytes / 2) {
      share.blocked = false;
      for (const each of share.members) each.startReading();
    }
    if (saturated && held <= limits.totalBufferBytes / 2) {
      saturated = false;
      for (const each of members) each.startReading();
    }
  }

  return {
    enter(member) {
      if (members.size >= limits.maxConnections) return false;
      members.add(member);
      return true;
    },
    join(member, slug, bytes) {
      const share = shares.get(slug) ?? { slug, members: new Set<Member>(), held: 0, blocked: false };
      if (share.members.size >= limits.maxPerProject) return share.members.size;
      shares.set(slug, share);
      share.members.add(member);
      member.share = share;
      share.held += bytes;
      overBudget(share);
      return null;
    },
    leave(member) {
      members.delete(member);
      const share = member.share;
      if (share === null) return;
      share.members.delete(member);
      if (share.members.size === 0) shares.delete(share.slug);
    },
    account(member, bytes) {
      held += bytes;
      const share = member.share;
      if (share !== null) share.held += bytes;
      if (bytes > 0) overBudget(share);
      else if (bytes < 0) underBudget(share);
    },
    mayRead: (member) => !saturated && !(member.share?.blocked ?? false),
    open: () => members.size,
    held: () => held,
  };
}
