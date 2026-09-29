"""Put pi/ on sys.path so `import screentinker_native` works without installing the package."""
import os
import sys

PI_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if PI_DIR not in sys.path:
    sys.path.insert(0, PI_DIR)

# Shared conformance vectors live at <repo>/shared/, next to pi/.
SHARED_DIR = os.path.abspath(os.path.join(os.path.dirname(__file__), "..", "..", "shared"))
