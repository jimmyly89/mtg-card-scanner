"""
Shared environment / configuration loader for the MTG Card Scanner Python layer.

Reads the gitignored ``.env`` file at the repository root (the same file the
Node.js server loads via systemd ``EnvironmentFile``) so Node and Python share
one source of truth for database credentials and interpreter paths.

Secrets are never logged. Use :func:`db_config` to obtain the MariaDB
connection parameters and :func:`python_interpreter` for the interpreter the
Node server should spawn.

Usage::

    from env_config import db_config, python_interpreter
    cfg = db_config()
    conn = mysql.connector.connect(**cfg)
"""

from __future__ import annotations

import os
from pathlib import Path

# Repository root = parent of the scripts/ directory.
SCRIPT_DIR = Path(__file__).resolve().parent
PROJECT_DIR = SCRIPT_DIR.parent
ENV_FILE = PROJECT_DIR / ".env"

# Defaults mirror the documented external MariaDB layout. They are only used
# when the corresponding variable is absent from the environment AND .env.
_DEFAULTS = {
    "DB_HOST": "127.0.0.1",
    "DB_PORT": "3306",
    "DB_NAME": "mtg_inventory",
    "DB_USER": "mtgscanner",
    "DB_PASSWORD": "",
    "PYTHON_INTERPRETER": str(SCRIPT_DIR.parent / ".venv" / "bin" / "python"),
}


def _parse_env_file(path: Path) -> dict[str, str]:
    """Parse a simple KEY=VALUE .env file (no shell expansion)."""
    values: dict[str, str] = {}
    if not path.exists():
        return values
    try:
        for raw in path.read_text(encoding="utf-8").splitlines():
            line = raw.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            key, _, value = line.partition("=")
            key = key.strip()
            value = value.strip().strip('"').strip("'")
            if key:
                values[key] = value
    except OSError:
        pass
    return values


def _get(name: str) -> str:
    """Return the env var, then the .env value, then the default."""
    value = os.environ.get(name)
    if value is not None and value != "":
        return value
    file_values = _parse_env_file(ENV_FILE)
    if name in file_values and file_values[name] != "":
        return file_values[name]
    return _DEFAULTS.get(name, "")


def db_config() -> dict:
    """Return MariaDB connection parameters shared with the Node server."""
    return {
        "host": _get("DB_HOST"),
        "port": int(_get("DB_PORT") or 3306),
        "user": _get("DB_USER"),
        "password": _get("DB_PASSWORD"),
        "database": _get("DB_NAME"),
        "charset": "utf8mb4",
    }


def python_interpreter() -> str:
    """Return the Python interpreter path the Node server should spawn."""
    return _get("PYTHON_INTERPRETER")


def collectorvision_cache() -> str:
    """Return the CollectorVision model/catalog cache root (may be empty)."""
    return _get("COLLECTORVISION_CACHE")


if __name__ == "__main__":
    # Diagnostic helper — prints connection targets WITHOUT the password.
    cfg = db_config()
    print(f"DB_HOST={cfg['host']}")
    print(f"DB_PORT={cfg['port']}")
    print(f"DB_NAME={cfg['database']}")
    print(f"DB_USER={cfg['user']}")
    print(f"PYTHON_INTERPRETER={python_interpreter()}")