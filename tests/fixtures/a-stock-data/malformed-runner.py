#!/usr/bin/env python3
"""Fixture process that violates the one-record NDJSON response contract."""

import sys

sys.stdin.readline()
sys.stdout.write("not-json\nsecond-record\n")
sys.stdout.flush()
