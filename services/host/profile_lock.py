"""Acquire a Linux flock on inherited fd 3, retained by the Node parent.

flock attaches to the shared open file description. Exiting this helper does
not release the lock while the parent retains its descriptor. No stale-PID or
heartbeat lock stealing is necessary across container restarts.
"""

import fcntl
import sys

EXPECTED_ARG_COUNT = 2
CHALLENGE_HEX_LENGTH = 64

try:
    fcntl.flock(3, fcntl.LOCK_EX | fcntl.LOCK_NB)
except OSError:
    sys.exit(2)
if len(sys.argv) != EXPECTED_ARG_COUNT or len(sys.argv[1]) != CHALLENGE_HEX_LENGTH:
    sys.exit(3)
sys.stdout.write("locked:" + sys.argv[1])
sys.stdout.flush()
