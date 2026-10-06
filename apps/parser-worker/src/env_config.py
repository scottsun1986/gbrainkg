"""Finite positive numeric settings with safe defaults for optional configuration."""
import math
import os


def env_int(name: str, default: int, minimum: int = 1) -> int:
    try:
        value = int(os.environ.get(name, str(default)))
        return value if value >= minimum else default
    except (ValueError, TypeError):
        return default


def env_float(name: str, default: float, minimum: float = 0.001) -> float:
    try:
        value = float(os.environ.get(name, str(default)))
        return value if math.isfinite(value) and value >= minimum else default
    except (ValueError, TypeError):
        return default
