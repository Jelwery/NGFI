#!/usr/bin/env python3

import json
import sys

request = json.loads(sys.stdin.readline())
print(json.dumps({"version": "1", "id": request["id"], "ok": True, "data": {}}))
