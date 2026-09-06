#!/usr/bin/env python3
"""Close stdin immediately, then stay alive until the provider terminates us."""

import os
import time
from pathlib import Path


os.close(0)
Path(__file__).with_suffix(".pid").write_text(str(os.getpid()), encoding="utf-8")
while True:  # pragma: no branch - terminated by the provider under test
  time.sleep(1)
