"""Prove the pipeline makes no network calls, without touching the network.

    python verify_offline.py

Every socket connection to anything that is not loopback raises immediately,
then all three stages run. If the run completes, nothing in this pipeline
reached off the machine.

This is a stricter check than switching wifi off: pulling the network proves
that nothing *succeeded* off-machine, while this proves nothing was even
attempted. Attempts matter — a library that quietly retries a telemetry
endpoint still works offline but has no business in this demo.

It does not cover the `foundry` CLI subprocess, which is a separate binary.
That call is local by nature (it reports on a daemon on this machine), but
the belt-and-braces check is still to run `python run_demo.py` with wifi off.
"""

from __future__ import annotations

import socket
import sys
from pathlib import Path

import console

HERE = Path(__file__).parent

LOOPBACK_HOSTS = {"127.0.0.1", "::1", "localhost"}

_blocked: list[str] = []


class NetworkCallAttempted(RuntimeError):
    """Raised the moment anything tries to leave the machine."""


def _install_socket_guard() -> None:
    """Replace socket.connect with a version that refuses non-loopback hosts."""
    real_connect = socket.socket.connect
    real_connect_ex = socket.socket.connect_ex

    def guarded_connect(self, address, *args, **kwargs):
        host = address[0] if isinstance(address, tuple) else address
        if isinstance(host, str) and host not in LOOPBACK_HOSTS:
            _blocked.append(str(host))
            raise NetworkCallAttempted(
                f"Blocked a connection to {host!r} — this pipeline must be offline."
            )
        return real_connect(self, address, *args, **kwargs)

    def guarded_connect_ex(self, address, *args, **kwargs):
        host = address[0] if isinstance(address, tuple) else address
        if isinstance(host, str) and host not in LOOPBACK_HOSTS:
            _blocked.append(str(host))
            raise NetworkCallAttempted(
                f"Blocked a connection to {host!r} — this pipeline must be offline."
            )
        return real_connect_ex(self, address, *args, **kwargs)

    socket.socket.connect = guarded_connect
    socket.socket.connect_ex = guarded_connect_ex


def main() -> int:
    console.banner("OFFLINE VERIFICATION")
    console.info("Blocking every socket connection except loopback.")
    _install_socket_guard()

    # Imported after the guard is installed so any import-time network call
    # is caught too.
    import run_demo

    try:
        exit_code = run_demo.main()
    except NetworkCallAttempted as exc:
        console.banner("OFFLINE VERIFICATION FAILED")
        console.info(str(exc))
        return 1

    console.banner("OFFLINE VERIFICATION PASSED" if exit_code == 0 else "PIPELINE FAILED")
    if exit_code == 0:
        console.info("All three stages completed with no off-machine connection.")
    return exit_code


if __name__ == "__main__":
    sys.argv = [sys.argv[0]]  # run_demo parses argv; give it a clean one
    raise SystemExit(main())
