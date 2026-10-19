/**
 * What both ports do with a raw Bun socket: pause and resume it in a way Bun
 * 1.3.11 keeps, write to it without that undoing a pause, keep the bytes a
 * read delivered, and close a refused one without the reset that would throw
 * its answer away.
 *
 * Every function here works around a behaviour of Bun measured on 1.3.11 and
 * held to by the tests of proxy.ts and connectors.ts: change one only with
 * those tests running.
 */
import type { Socket } from "bun";

/** One end of a connection, and the bytes waiting for it. */
export type Side = {
  socket: Socket<unknown> | null;
  /** Bytes waiting for this side to drain. */
  queue: Uint8Array[];
  queued: number;
  /** Its peer is gone, or has said all: the connection closes once this queue is written. */
  ending: boolean;
  /** Told to stop reading: what Bun's own flag cannot be trusted to say, see write(). */
  paused: boolean;
};

export function side(socket: Socket<unknown> | null): Side {
  return { socket, queue: [], queued: 0, ending: false, paused: false };
}

export function pause(side: Side): void {
  side.paused = true;
  // resume() first: after a short write Bun may be reading a socket it
  // still counts as paused, and on which a lone pause() does nothing.
  side.socket?.resume();
  side.socket?.pause();
}

export function resume(side: Side): void {
  side.paused = false;
  side.socket?.resume();
}

/**
 * Writes to a side and keeps it from reading if it was paused. Bun 1.3.11
 * turns a socket's reading back on whenever a write to it comes up short
 * (uSockets' us_socket_write asks for readable and writable both, whatever
 * pause() said) and still counts it as paused, so that the next pause()
 * does nothing. A tunnel whose two ends both send and neither reads, each
 * end being written to while it should not be read, was read without
 * limit: gigabytes held in seconds. resume() then pause() puts the polling
 * and the flag back in step.
 */
export function write(side: Side, chunk: Uint8Array): number {
  const socket = side.socket!;
  const written = Math.max(socket.write(chunk), 0);
  if (written < chunk.length && side.paused) {
    socket.resume();
    socket.pause();
  }
  return written;
}

/**
 * A copy of what a read delivered, to keep it beyond the callback: its memory
 * may be reused by the next read. Not `slice`, which on the Buffer a socket
 * hands over is a view, not a copy.
 */
export function copy(view: Uint8Array): Uint8Array {
  const kept = new Uint8Array(view.length);
  kept.set(view);
  return kept;
}

export function concat(a: Uint8Array, b: Uint8Array): Uint8Array {
  const joined = new Uint8Array(a.length + b.length);
  joined.set(a, 0);
  joined.set(b, a.length);
  return joined;
}

export type LingerLimits = {
  /** Lingering sockets at a time, past which a refusal closes at once. */
  maxConnections: number;
  lingerMs: number;
  lingerBytes: number;
};

export type Lingering = {
  /** Answers, then reads and drops what the client still sends, until it closes. */
  start: (socket: Socket<unknown>, answer: string) => void;
  /** What a lingering client sent since, dropped; past lingerBytes, its socket is cut. */
  drop: (socket: Socket<unknown>, bytes: number) => void;
  /** Its socket closed: the linger is over. */
  end: (socket: Socket<unknown>) => void;
  size: () => number;
  /** Cuts every one. */
  stop: () => void;
};

/**
 * A refused client answered, then read and ignored for a moment before its
 * socket closes: a lingering close, as nginx and Apache do it.
 *
 * A refusal often comes while the client is still sending: a body behind
 * its head, a head too large. Closed with those bytes unread, or receiving
 * more once closed, a socket answers with a reset, and a reset makes the
 * client's kernel throw away what it received and had not read yet: the
 * answer itself. The client saw "connection reset" instead of the sentence
 * that says why, 2 attempts in 40 on a loaded machine. So the answer goes,
 * a FIN behind it, and what still arrives is read and dropped until the
 * client closes its side, which it does once it has read the answer: for
 * lingerMs and lingerBytes at most, past which the socket is cut, the
 * client having had its chance.
 *
 * shutdown(), not end(): in Bun 1.3.11 end() on a server socket closes the
 * descriptor at once, unread bytes and all, which is the reset this
 * avoids. shutdown() without an argument is shutdown(SHUT_WR), the socket
 * reads on; shutdown(true), whatever its documentation says, closes the
 * reading side. Both measured on this Bun, which the tests hold to.
 *
 * Lingering sockets hold no byte and are no longer counted among the
 * connections; they are bounded apart, by maxConnections, past which a
 * refusal closes at once.
 */
export function createLingering(limits: LingerLimits): Lingering {
  const lingering = new Map<Socket<unknown>, { dropped: number; timer: ReturnType<typeof setTimeout> }>();

  function end(socket: Socket<unknown>): void {
    const state = lingering.get(socket);
    if (state === undefined) return;
    clearTimeout(state.timer);
    lingering.delete(socket);
  }

  function cut(socket: Socket<unknown>): void {
    end(socket);
    socket.terminate();
  }

  return {
    start(socket, answer) {
      if (answer.length > 0) socket.write(answer);
      if (lingering.size >= limits.maxConnections) {
        socket.end();
        return;
      }
      lingering.set(socket, { dropped: 0, timer: setTimeout(() => cut(socket), limits.lingerMs) });
      // Paused while its head was judged, perhaps: what it sends is read now,
      // to be dropped, and nothing is written to it any more, so the quirk
      // write() works around cannot turn that back. Resumed before the
      // shutdown, never after: Bun 1.3.11 closes a socket shut down while
      // paused, at once, which is the very reset this avoids.
      socket.resume();
      socket.shutdown();
    },
    drop(socket, bytes) {
      const state = lingering.get(socket);
      if (state === undefined) return;
      state.dropped += bytes;
      if (state.dropped > limits.lingerBytes) cut(socket);
    },
    end,
    size: () => lingering.size,
    stop() {
      for (const socket of [...lingering.keys()]) cut(socket);
    },
  };
}
