#!/usr/bin/env python3
"""Fixture process that never answers before timeout/cancellation tests act."""

import sys
import time

sys.stdin.readline()
time.sleep(30)
