# Never run and never shipped: screentinker.spec analyses this file only to learn which STANDARD-LIBRARY
# modules the optional audience add-on (numpy + OpenCV, packaging/audience) imports. See the spec.
import cv2  # noqa: F401
import numpy  # noqa: F401
